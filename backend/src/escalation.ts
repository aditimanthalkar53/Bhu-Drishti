import { createHmac, timingSafeEqual } from "node:crypto";
import { audit, notify } from "./delivery.js";
import type { Alert, Escalation, Monitor, Recipient } from "./domain.js";
import { sendMail, smtpConfigured } from "./email.js";
import type { Store } from "./store/types.js";

const now = () => new Date().toISOString();

export const LEVELS: Record<number, string> = { 1: "Block / field", 2: "District", 3: "State", 4: "National" };
export const MAX_LEVEL = 4;

/** Mail sender, replaceable so tests never touch an SMTP server. */
export type Mailer = (to: string, subject: string, text: string, html: string) => Promise<void>;
let mailer: Mailer | null = null;
export const setMailer = (m: Mailer | null) => { mailer = m; };

async function deliver(to: string, subject: string, text: string, html: string): Promise<void> {
  if (mailer) return mailer(to, subject, text, html);
  if (!smtpConfigured()) throw new Error("email is not configured on this server (SMTP_USER / SMTP_PASS)");
  await sendMail({ to, subject, text, html });
}

// ---------------------------------------------------------------------------- the chain (pure)

/** Whether ``reportsToId`` of ``id`` can be set without a loop (it cannot point at itself or at someone below). */
export function wouldLoop(all: Pick<Recipient, "id" | "reportsToId">[], id: string, reportsToId: string | null | undefined): boolean {
  const by = new Map(all.map((r) => [r.id, r]));
  const seen = new Set<string>([id]);
  let cur = reportsToId ?? null;
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = by.get(cur)?.reportsToId ?? null;
  }
  return false;
}

/** The people one step above everyone already told, skipping anyone already told or inactive (pure). */
export function nextUp(all: Recipient[], notifiedIds: Iterable<string>): Recipient[] {
  const told = new Set(notifiedIds);
  const by = new Map(all.map((r) => [r.id, r]));
  const out = new Map<string, Recipient>();
  for (const id of told) {
    let up = by.get(id)?.reportsToId ?? null;
    // an inactive official is passed over to whoever they report to, so a vacancy never breaks the chain
    while (up && by.get(up) && !by.get(up)!.active && !told.has(up)) up = by.get(up)!.reportsToId ?? null;
    const r = up ? by.get(up) : undefined;
    if (r && r.active && !told.has(r.id)) out.set(r.id, r);
  }
  return [...out.values()];
}

/** How many levels above the monitor's own recipients to tell straight away, from how severe the value is (pure). */
export function initialSteps(value: number | null, esc: Escalation): number {
  if (value === null) return 0;
  if (esc.criticalValue != null && value >= esc.criticalValue) return 2;
  if (esc.severeValue != null && value >= esc.severeValue) return 1;
  return 0;
}

export function dueForEscalation(a: Alert, at: Date): boolean {
  const e = a.escalation;
  if (!e?.enabled || a.status !== "open") return false;
  const last = Date.parse(a.lastEscalatedAt ?? a.createdAt);
  return at.getTime() - last >= Math.max(1, e.ackMinutes) * 60_000;
}

// ---------------------------------------------------------------------------- acknowledge links

export const ackSignature = (secret: string, alertId: string, recipientId: string) =>
  createHmac("sha256", secret).update(`ack:${alertId}:${recipientId}`).digest("hex").slice(0, 32);

export function ackValid(secret: string, alertId: string, recipientId: string, sig: string): boolean {
  const want = Buffer.from(ackSignature(secret, alertId, recipientId));
  const got = Buffer.from(String(sig));
  return want.length === got.length && timingSafeEqual(want, got);
}

// ---------------------------------------------------------------------------- notifying

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface Ctx { store: Store; secret: string; publicUrl: string; appUrl: string }

/** Tell these people, record each attempt on the alert, and log it. A failed email is recorded, never hidden. */
export async function tell(ctx: Ctx, a: Alert, people: Recipient[], reason: string, actor = "system"): Promise<void> {
  for (const r of people) {
    const link = `${ctx.publicUrl}/api/alerts/${a.id}/ack?r=${r.id}&s=${ackSignature(ctx.secret, a.id, r.id)}`;
    const drill = a.drill ? "DRILL: " : "";
    const subject = `${drill}Bhu-Drishti alert: ${a.title}`;
    const lines = [
      `Dear ${r.name},`,
      "",
      `${reason}`,
      "",
      a.message,
      "",
      a.value !== null ? `Measured value: ${a.value}.` : "",
      a.drill ? "This is a drill. No satellite analysis was run for this message." : "This is a satellite-based estimate that a person at the district level has not necessarily reviewed. Read the limitations in the full report before acting.",
      "",
      `Please confirm you have seen this: ${link}`,
      "",
      "Bhu-Drishti satellite monitoring",
    ].filter((l, i, arr) => !(l === "" && arr[i - 1] === ""));
    const html = `<p>Dear ${esc(r.name)},</p><p>${esc(reason)}</p><p>${esc(a.message)}</p>${a.value !== null ? `<p>Measured value: <b>${a.value}</b>.</p>` : ""}` +
      `<p>${a.drill ? "<b>This is a drill.</b> No satellite analysis was run for this message." : "This is a satellite-based estimate that has not necessarily been reviewed. Read the limitations in the full report before acting."}</p>` +
      `<p><a href="${esc(link)}">Confirm that you have seen this alert</a></p>`;
    let status: "sent" | "failed" = "sent";
    let error: string | undefined;
    try {
      await deliver(r.email, subject, lines.join("\n"), html);
    } catch (e) {
      status = "failed";
      error = (e as Error).message.slice(0, 200);
    }
    a.notified.push({ at: now(), recipientId: r.id, name: r.name, designation: r.designation, level: r.level ?? 1, email: r.email, channel: "email", status, error, reason });
    a.history.push({ at: now(), by: actor, action: status === "sent" ? "notified" : "notify failed", note: `${r.name}${r.designation ? `, ${r.designation}` : ""}: ${reason}${error ? ` (${error})` : ""}` });
    await audit(ctx.store, a.ownerId, actor, "alert.notify", `alert:${a.id}`, { recipient: r.id, level: r.level ?? 1, status, reason, error });
  }
  await ctx.store.putRecord("alert", a);
}

/** Resolve a monitor's explicit recipients and its group members (active only, de-duplicated). */
export async function monitorPeople(store: Store, m: Pick<Monitor, "ownerId" | "recipientIds" | "groupIds">): Promise<Recipient[]> {
  const all = await store.listRecords<Recipient>("recipient", m.ownerId);
  const want = new Set(m.recipientIds);
  const groups = new Set(m.groupIds);
  return all.filter((r) => r.active && (want.has(r.id) || r.groupIds.some((g) => groups.has(g))));
}

/** First notification of a new alert: the monitor's own people, then further up the chain if the value is severe. */
export async function openChain(ctx: Ctx, a: Alert, m: Monitor): Promise<void> {
  const e = m.escalation;
  if (!e?.enabled) return;
  a.escalation = { ...e };
  a.lastEscalatedAt = now();
  const all = await ctx.store.listRecords<Recipient>("recipient", m.ownerId);
  const first = await monitorPeople(ctx.store, m);
  if (first.length === 0) {
    a.history.push({ at: now(), by: "system", action: "no recipients", note: "Escalation is on but this monitor has no active recipients to tell first." });
    await ctx.store.putRecord("alert", a);
    return;
  }
  await tell(ctx, a, first, `A monitor you follow has crossed its threshold (${m.name}).`);
  let told = new Set(first.map((r) => r.id));
  for (let step = initialSteps(a.value, e); step > 0; step--) {
    const up = nextUp(all, told);
    if (up.length === 0) break;
    await tell(ctx, a, up, `The value ${a.value} is above the ${step === 1 ? "severe" : "critical"} level set for ${m.name}, so it was sent straight to you.`);
    told = new Set([...told, ...up.map((r) => r.id)]);
  }
}

/** One step up, because nobody confirmed in time (or because a person pressed Escalate). Returns who was told. */
export async function escalate(ctx: Ctx, a: Alert, why: "no confirmation" | "manual", actor = "system", at: Date = new Date()): Promise<Recipient[]> {
  const all = await ctx.store.listRecords<Recipient>("recipient", a.ownerId);
  const up = nextUp(all, a.notified.map((n) => n.recipientId));
  a.lastEscalatedAt = at.toISOString();
  if (up.length === 0) {
    a.history.push({ at: now(), by: actor, action: "top of chain", note: "Nobody is left above the people already told." });
    await ctx.store.putRecord("alert", a);
    return [];
  }
  const mins = a.escalation?.ackMinutes;
  await tell(ctx, a, up, why === "manual" ? `${actor} escalated this alert to you.` : `Nobody confirmed this alert within ${mins} minutes, so it has moved up to you.`, actor);
  await notify(ctx.store, a.ownerId, `Alert escalated: ${a.title}`, `Now also with ${up.map((r) => r.name).join(", ")}`, "critical", "/app/alerts");
  return up;
}

/** Called every minute: escalate each open alert that has waited longer than its monitor allowed. */
export async function escalateDue(ctx: Ctx, at: Date = new Date()): Promise<number> {
  let n = 0;
  for (const a of await ctx.store.listRecords<Alert>("alert")) {
    if (dueForEscalation(a, at) && (await escalate(ctx, a, "no confirmation", "system", at)).length > 0) n++;
    else if (dueForEscalation(a, at)) await ctx.store.putRecord("alert", { ...a, lastEscalatedAt: at.toISOString() }); // top of chain: do not retry every tick
  }
  return n;
}

/** A recipient confirmed by link. Idempotent. */
export async function confirmByRecipient(ctx: Ctx, a: Alert, r: Recipient): Promise<"confirmed" | "already"> {
  if (a.confirmedBy?.some((c) => c.recipientId === r.id)) return "already";
  a.confirmedBy = [...(a.confirmedBy ?? []), { recipientId: r.id, name: r.name, at: now() }];
  if (a.status === "open") a.status = "acknowledged";
  a.history.push({ at: now(), by: r.name, action: "confirmed", note: `${r.designation || "recipient"} confirmed by email link` });
  await ctx.store.putRecord("alert", a);
  await audit(ctx.store, a.ownerId, r.id, "alert.confirmed", `alert:${a.id}`, { level: r.level ?? 1 }, r.name);
  await notify(ctx.store, a.ownerId, `Alert confirmed: ${a.title}`, `${r.name} confirmed they have seen it.`, "info", "/app/alerts");
  return "confirmed";
}
