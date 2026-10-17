import { randomUUID } from "node:crypto";
import type { AuditEntry, Delivery, Group, Notification, Recipient, Report } from "./domain.js";
import { sendReportEmail, smtpConfigured } from "./email.js";
import type { EngineClient } from "./engine-client.js";
import { createReportPdf, type ReportQuery } from "./report.js";
import type { QuerySession, Store } from "./store/types.js";
import { emit } from "./webhooks.js";

const now = () => new Date().toISOString();

/** Fields of a finished engine result worth keeping with the session (drops bulky tile lists). */
export function snapshot(result: Record<string, any> | null | undefined): Record<string, unknown> | null {
  if (!result) return null;
  const keep = ["estimate", "units", "stop_reason", "n", "population", "oracle_calls", "cache_hits", "elapsed_s", "sensor",
    "oracle", "scene_key", "caveats", "supporting_evidence", "advisory", "data_mode", "region", "inputs_summary",
    "missing_data_tiles", "sampled_fraction", "answer"];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (k in result) out[k] = result[k];
  if (Array.isArray(result.priority_tiles)) out.priority_tiles = result.priority_tiles.slice(0, 25);
  return out;
}

export async function audit(store: Store, ownerId: string, actor: string, action: string, target: string, detail?: Record<string, unknown>, actorName?: string) {
  const e: AuditEntry = { id: randomUUID(), ownerId, createdAt: now(), actor, actorName, action, target, detail };
  await store.putRecord("audit", e);
}

export async function notify(store: Store, ownerId: string, title: string, body: string, level: Notification["level"] = "info", link?: string) {
  const n: Notification = { id: randomUUID(), ownerId, createdAt: now(), title, body, level, link, read: false };
  await store.putRecord("notification", n);
}

/** Active recipients of a report: explicit ones plus members of its groups (de-duplicated by email). */
export async function reportRecipients(store: Store, report: Report): Promise<Recipient[]> {
  const all = await store.listRecords<Recipient>("recipient", report.ownerId);
  const want = new Set(report.recipientIds);
  const groups = new Set(report.groupIds);
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of all) {
    if (!r.active) continue;
    if (!(want.has(r.id) || r.groupIds.some((g) => groups.has(g)))) continue;
    const key = r.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export async function groupNames(store: Store, ownerId: string): Promise<Map<string, string>> {
  return new Map((await store.listRecords<Group>("group", ownerId)).map((g) => [g.id, g.name]));
}

/** Build the PDF from stored sessions (+ live map evidence if the engine still has the job). */
export async function buildReportPdf(store: Store, engine: EngineClient, report: Report): Promise<Buffer> {
  const queries: ReportQuery[] = [];
  for (const id of report.queryIds) {
    const s = await store.session(id);
    if (!s || s.userId !== report.ownerId) continue;
    const q: ReportQuery = { queryId: s.id, question: s.question, status: s.status, answer: s.answer, estimate: s.estimate as any,
      result: s.result as any, createdAt: s.createdAt };
    try {
      q.evidence = await engine.get<any>(`/queries/${s.id}/evidence`);
      q.regionGeometry = (await engine.get<any>(`/regions/${encodeURIComponent(s.regionId)}`)).geometry;
    } catch { /* engine restarted or region removed: report without the map */ }
    queries.push(q);
  }
  const approver = report.approvedBy ? (await store.userById(report.approvedBy))?.name ?? report.approvedBy : null;
  return createReportPdf({ reportId: report.id, title: report.title, summary: report.summary, status: report.status, approvedBy: approver, queries });
}

export function reportSummary(sessions: QuerySession[]): string {
  return sessions.map((s) => s.answer ?? `${s.question}: no answer (${s.status})`).join(" ");
}

export type DeliveryMode = "smtp" | "n8n";

export function deliveryMode(env: NodeJS.ProcessEnv = process.env): DeliveryMode {
  return env.REPORT_DELIVERY === "n8n" ? "n8n" : "smtp";
}

/**
 * Send an approved report. SMTP mode emails every recipient directly and logs each delivery;
 * n8n mode hands the report to the automation (report.approved webhook) and n8n posts delivery
 * results back to /api/reports/:id/deliveries.
 */
export async function sendReport(store: Store, engine: EngineClient, report: Report, actor: string, publicUrl: string) {
  if (report.status !== "approved" && report.status !== "partially_sent" && report.status !== "failed") {
    throw Object.assign(new Error(`report is ${report.status}; it must be approved before sending`), { statusCode: 409 });
  }
  const recipients = await reportRecipients(store, report);
  if (!recipients.length) throw Object.assign(new Error("no active recipients on this report"), { statusCode: 400 });
  const mode = deliveryMode();
  report.status = "sending";
  await store.putRecord("report", report);

  if (mode === "n8n") {
    const hooks = await emit(store, report.ownerId, "report.approved", reportPayload(report, recipients, publicUrl));
    for (const r of recipients) await logDelivery(store, report, r, "queued", "n8n");
    report.status = hooks ? "sending" : "failed";
    report.note = hooks ? "handed to n8n" : "no active webhook subscribed to report.approved";
    await store.putRecord("report", report);
    await audit(store, report.ownerId, actor, "report.send", `report:${report.id}`, { via: "n8n", recipients: recipients.length, hooks });
    return { mode, queued: recipients.length, hooks };
  }

  if (!smtpConfigured()) {
    report.status = "failed";
    report.note = "SMTP is not configured (SMTP_USER / SMTP_PASS)";
    await store.putRecord("report", report);
    await audit(store, report.ownerId, actor, "report.send", `report:${report.id}`, { via: "smtp", error: report.note });
    throw Object.assign(new Error(report.note), { statusCode: 503 });
  }
  const pdf = await buildReportPdf(store, engine, report);
  let ok = 0;
  const failures: string[] = [];
  for (const r of recipients) {
    try {
      const info = await sendReportEmail(r.email, report.title, report.summary, pdf, r.name);
      await logDelivery(store, report, r, "sent", "smtp", null, info.messageId);
      ok++;
    } catch (e) {
      failures.push(`${r.email}: ${(e as Error).message}`);
      await logDelivery(store, report, r, "failed", "smtp", (e as Error).message);
    }
  }
  report.status = ok === recipients.length ? "sent" : ok ? "partially_sent" : "failed";
  report.sentAt = ok ? now() : report.sentAt ?? null;
  report.note = failures.length ? failures.slice(0, 3).join("; ") : undefined;
  await store.putRecord("report", report);
  await audit(store, report.ownerId, actor, "report.send", `report:${report.id}`, { via: "smtp", sent: ok, failed: failures.length });
  if (ok) await emit(store, report.ownerId, "report.sent", { report_id: report.id, sent: ok, failed: failures.length });
  await notify(store, report.ownerId, `Report ${report.status.replace("_", " ")}`, `${report.title}: ${ok}/${recipients.length} emails sent`,
    failures.length ? "warning" : "info", `/app/reports/${report.id}`);
  return { mode, sent: ok, failed: failures.length, failures };
}

export async function logDelivery(store: Store, report: Report, r: Recipient | null, status: Delivery["status"], via: Delivery["via"],
  error: string | null = null, providerMessageId: string | null = null, to?: string) {
  const d: Delivery = { id: randomUUID(), ownerId: report.ownerId, createdAt: now(), reportId: report.id, recipientId: r?.id ?? null,
    channel: "email", to: to ?? r?.email ?? "", status, via, error, providerMessageId };
  await store.putRecord("delivery", d);
  return d;
}

export function reportPayload(report: Report, recipients: Recipient[], publicUrl: string) {
  return {
    report_id: report.id, title: report.title, summary: report.summary, status: report.status, region_id: report.regionId,
    query_ids: report.queryIds, origin: report.origin,
    pdf_url: `${publicUrl}/api/reports/${report.id}/pdf`,
    recipients_url: `${publicUrl}/api/reports/${report.id}/recipients`,
    deliveries_url: `${publicUrl}/api/reports/${report.id}/deliveries`,
    approve_url: `${publicUrl}/api/reports/${report.id}/approve`,
    recipients: recipients.map((r) => ({ id: r.id, name: r.name, email: r.email, designation: r.designation, department: r.department })),
  };
}
