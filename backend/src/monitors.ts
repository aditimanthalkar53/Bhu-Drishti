import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { audit, autoDeliver, notify, reportRecipients, sendReport, snapshot } from "./delivery.js";
import { escalateDue, openChain, type Ctx } from "./escalation.js";
import type { Alert, Monitor, Report, Threshold } from "./domain.js";
import { EngineClient, EngineError } from "./engine-client.js";
import type { Project, QuerySession, Store } from "./store/types.js";
import { emit } from "./webhooks.js";

const now = () => new Date().toISOString();
const IST_OFFSET_MIN = 330;

export function compare(v: number, t: Threshold): boolean {
  switch (t.op) {
    case ">": return v > t.value;
    case ">=": return v >= t.value;
    case "<": return v < t.value;
    case "<=": return v <= t.value;
  }
}

/** Last scheduled instant (UTC ms) of a daily "HH:MM" IST schedule at or before ``at``. */
export function lastDailySlot(time: string, at: Date): number {
  const [hh, mm] = time.split(":").map(Number);
  const ist = new Date(at.getTime() + IST_OFFSET_MIN * 60_000);
  let slot = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hh, mm) - IST_OFFSET_MIN * 60_000;
  if (slot > at.getTime()) slot -= 86_400_000;
  return slot;
}

export function isDue(m: Monitor, at: Date = new Date()): boolean {
  if (!m.enabled) return false;
  const last = m.lastRunAt ? Date.parse(m.lastRunAt) : 0;
  switch (m.schedule.type) {
    case "interval": return at.getTime() - last >= Math.max(1, m.schedule.hours) * 3_600_000;
    case "daily": return last < lastDailySlot(m.schedule.time, at);
    case "new_pass": return false; // handled by the freshness check
    default: return false;
  }
}

export function nextRun(m: Monitor, at: Date = new Date()): string | null {
  if (!m.enabled) return null;
  if (m.schedule.type === "interval") {
    const last = m.lastRunAt ? Date.parse(m.lastRunAt) : at.getTime();
    return new Date(Math.max(at.getTime(), last + m.schedule.hours * 3_600_000)).toISOString();
  }
  if (m.schedule.type === "daily") return new Date(lastDailySlot(m.schedule.time, at) + 86_400_000).toISOString();
  return null;
}

async function monitorProject(store: Store, ownerId: string): Promise<Project> {
  const ps = await store.projectsFor(ownerId);
  const p = ps.find((x) => x.name === "Monitors");
  if (p) return p;
  return store.createProject({ id: randomUUID(), ownerId, name: "Monitors", description: "Scheduled monitor runs", createdAt: now() });
}

export class MonitorScheduler {
  private timer?: NodeJS.Timeout;
  private running = new Set<string>();
  private lastPassCheck = new Map<string, number>();

  constructor(private store: Store, private engine: EngineClient, private log: FastifyBaseLogger,
    private opts: { publicUrl: string; secret?: string; appUrl?: string; tickMs?: number; pollMs?: number; maxConcurrent?: number; passCheckMs?: number } = { publicUrl: "" }) {}

  private ctx(): Ctx {
    return { store: this.store, secret: this.opts.secret ?? "dev", publicUrl: this.opts.publicUrl, appUrl: this.opts.appUrl ?? "" };
  }

  /** A rehearsal of the escalation chain: opens a clearly labelled alert without running any satellite analysis. */
  async drill(m: Monitor, value: number | null, actor: string): Promise<Alert> {
    const alert: Alert = {
      id: randomUUID(), ownerId: m.ownerId, createdAt: now(), monitorId: m.id, queryId: "", regionId: m.regionId, drill: true,
      title: `DRILL — ${m.name}`, message: `This is a rehearsal of the alert chain for "${m.name}". No satellite analysis was run.`, value,
      threshold: m.threshold ?? { metric: "value", op: ">=", value: value ?? 0 }, status: "open", notified: [],
      history: [{ at: now(), by: actor, action: "drill started" }],
    };
    await this.store.putRecord("alert", alert);
    await audit(this.store, m.ownerId, actor, "alert.drill", `alert:${alert.id}`, { monitor: m.id, value });
    await openChain(this.ctx(), alert, m);
    return alert;
  }

  start() {
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.error({ err: e }, "monitor tick failed")), this.opts.tickMs ?? 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(at: Date = new Date()) {
    await escalateDue(this.ctx(), at).catch((e) => this.log.error({ err: e }, "escalation check failed"));
    const monitors = (await this.store.listRecords<Monitor>("monitor")).filter((m) => m.enabled);
    for (const m of monitors) {
      if (this.running.size >= (this.opts.maxConcurrent ?? 2)) break;
      if (this.running.has(m.id)) continue;
      let due = isDue(m, at);
      if (!due && m.schedule.type === "new_pass") due = await this.newPassArrived(m, at);
      if (due) void this.run(m, "system");
    }
  }

  private async newPassArrived(m: Monitor, at: Date): Promise<boolean> {
    const lastCheck = this.lastPassCheck.get(m.id) ?? 0;
    if (at.getTime() - lastCheck < (this.opts.passCheckMs ?? 30 * 60_000)) return false;
    this.lastPassCheck.set(m.id, at.getTime());
    try {
      const f = await this.engine.get<{ items: { product: string; source: string; latest?: string | null }[] }>(`/regions/${encodeURIComponent(m.regionId)}/freshness`);
      const s1 = f.items.find((i) => i.product.startsWith("Sentinel-1") && i.latest)?.latest ?? null;
      if (!s1) return false;
      if (s1 !== m.lastPass) {
        await this.store.putRecord("monitor", { ...m, lastPass: s1 });
        return m.lastPass != null || !m.lastRunAt; // first observation of a pass only triggers if never run
      }
    } catch (e) {
      this.log.warn({ err: e, monitor: m.id }, "freshness check failed");
    }
    return false;
  }

  /** Run a monitor now: start the engine query, wait for it, evaluate the threshold, alert and report. */
  async run(m: Monitor, actor: string): Promise<QuerySession | null> {
    if (this.running.has(m.id)) return null;
    this.running.add(m.id);
    const startedAt = now();
    try {
      await this.store.putRecord("monitor", { ...m, lastRunAt: startedAt, lastStatus: "running", lastError: null });
      const project = await monitorProject(this.store, m.ownerId);
      const started = await this.engine.post<{ id: string }>("/queries", { question: m.question, region_id: m.regionId, overrides: {} });
      const session = await this.store.createSession({
        id: started.id, projectId: project.id, userId: m.ownerId, question: m.question, regionId: m.regionId, status: "running",
        answer: null, estimate: null, result: null, source: "monitor", createdAt: startedAt, updatedAt: startedAt,
      });
      const summary = await this.waitForJob(started.id);
      const result = summary?.result ?? null;
      const status = (summary?.status ?? "failed") as QuerySession["status"];
      await this.store.updateSession(session.id, { status, answer: result?.answer ?? null, estimate: result?.estimate ?? null, result: snapshot(result) });
      const fresh = (await this.store.getRecord<Monitor>("monitor", m.id)) ?? m;
      if (status !== "done" && status !== "stopped") {
        const err = summary?.error ?? "run did not finish";
        await this.store.putRecord("monitor", { ...fresh, lastStatus: "failed", lastError: err, lastQueryId: session.id, nextRunAt: nextRun(fresh) });
        await notify(this.store, m.ownerId, `Monitor failed: ${m.name}`, err, "warning", `/app/monitors`);
        await emit(this.store, m.ownerId, "monitor.failed", { monitor_id: m.id, name: m.name, query_id: session.id, error: err });
        return session;
      }
      const est = (result?.estimate ?? {}) as Record<string, number>;
      const value = typeof est.value === "number" ? est.value : null;
      let triggered = false;
      if (m.threshold && typeof est[m.threshold.metric] === "number") triggered = compare(est[m.threshold.metric], m.threshold);
      await this.store.putRecord("monitor", { ...fresh, lastStatus: triggered ? "triggered" : "ok", lastValue: value,
        lastQueryId: session.id, nextRunAt: nextRun(fresh) });
      await audit(this.store, m.ownerId, actor, "monitor.run", `monitor:${m.id}`, { query: session.id, value, triggered });

      if (triggered && m.threshold) {
        const alert: Alert = {
          id: randomUUID(), ownerId: m.ownerId, createdAt: now(), monitorId: m.id, queryId: session.id, regionId: m.regionId,
          title: `${m.name}: threshold crossed`, message: String(result?.answer ?? ""), value, threshold: m.threshold, status: "open",
          history: [{ at: now(), by: "system", action: "opened" }], notified: [],
        };
        await this.store.putRecord("alert", alert);
        await openChain(this.ctx(), alert, fresh);
        await notify(this.store, m.ownerId, alert.title, alert.message.slice(0, 300), "critical", `/app/alerts`);
        await emit(this.store, m.ownerId, "alert.triggered", { alert_id: alert.id, monitor_id: m.id, name: m.name, region_id: m.regionId,
          value, threshold: m.threshold, answer: alert.message, query_id: session.id });
      }
      if (m.autoReport || triggered) await this.makeReport(m, session.id, String(result?.answer ?? ""), triggered);
      return session;
    } catch (e) {
      const msg = e instanceof EngineError ? e.message : (e as Error).message;
      this.log.error({ err: e, monitor: m.id }, "monitor run failed");
      const fresh = (await this.store.getRecord<Monitor>("monitor", m.id)) ?? m;
      await this.store.putRecord("monitor", { ...fresh, lastStatus: "failed", lastError: msg.slice(0, 500), nextRunAt: nextRun(fresh) });
      await notify(this.store, m.ownerId, `Monitor failed: ${m.name}`, msg.slice(0, 300), "warning", `/app/monitors`);
      await emit(this.store, m.ownerId, "monitor.failed", { monitor_id: m.id, name: m.name, error: msg.slice(0, 500) });
      return null;
    } finally {
      this.running.delete(m.id);
    }
  }

  private async waitForJob(id: string, maxMs = 45 * 60_000): Promise<any> {
    const t0 = Date.now();
    let finishedAt = 0;
    while (Date.now() - t0 < maxMs) {
      const s = await this.engine.get<any>(`/queries/${id}`);
      if (!["queued", "running"].includes(s.status)) {
        // the engine answers before supporting evidence (rainfall, MODIS) arrives; a report is not urgent, so give
        // the evidence up to two minutes to land in the result
        const pending = s.result?.supporting_evidence?.[0]?.id === "pending";
        finishedAt ||= Date.now();
        if (!pending || Date.now() - finishedAt > 120_000) return s;
      }
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 5000));
    }
    try { await this.engine.post(`/queries/${id}/stop`); } catch { /* ignore */ }
    return this.engine.get<any>(`/queries/${id}`);
  }

  private async makeReport(m: Monitor, queryId: string, answer: string, triggered: boolean) {
    const r: Report = {
      id: randomUUID(), ownerId: m.ownerId, createdAt: now(), title: `${m.name} — ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}`,
      queryIds: [queryId], regionId: m.regionId, monitorId: m.id, origin: "monitor",
      status: m.requireApproval ? "pending_approval" : "approved", summary: (triggered ? "ALERT: threshold crossed. " : "") + answer,
      recipientIds: m.recipientIds, groupIds: m.groupIds, approvedBy: m.requireApproval ? null : "system", approvedAt: m.requireApproval ? null : now(),
    };
    await this.store.putRecord("report", r);
    const recipients = await reportRecipients(this.store, r);
    const { reportPayload } = await import("./delivery.js");
    await emit(this.store, m.ownerId, "report.ready", reportPayload(r, recipients, this.opts.publicUrl));
    await autoDeliver(this.store, this.engine, r, this.log);
    await notify(this.store, m.ownerId, m.requireApproval ? "Report waiting for approval" : "Report ready", r.title,
      triggered ? "critical" : "info", `/app/reports/${r.id}`);
    if (!m.requireApproval && recipients.length) {
      try {
        await sendReport(this.store, this.engine, r, "system", this.opts.publicUrl);
      } catch (e) {
        this.log.warn({ err: e, report: r.id }, "auto-send failed");
      }
    }
    return r;
  }
}
