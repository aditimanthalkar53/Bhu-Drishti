import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit, autoDeliver, autoEmailTargets, buildReportPdf, deliveryMode, logDelivery, notify, reportPayload, reportRecipients, reportSummary, sendReport } from "./delivery.js";
import { WEBHOOK_EVENTS, type AOI, type Alert, type Escalation, type AuditEntry, type Delivery, type Group, type Monitor, type Notification,
  type Recipient, type Report, type Webhook } from "./domain.js";
import { smtpConfigured } from "./email.js";
import { EngineClient, EngineError } from "./engine-client.js";
import { MonitorScheduler, nextRun } from "./monitors.js";
import type { RecordKind, Store, StoredRecord } from "./store/types.js";
import { deliver, isAllowedUrl, newSecret } from "./webhooks.js";
import { ackValid, confirmByRecipient, escalate, LEVELS, MAX_LEVEL, wouldLoop } from "./escalation.js";

type IdParams = { Params: { id: string } };
const now = () => new Date().toISOString();
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function normaliseEscalation(e: Partial<Escalation> | null | undefined): Escalation | null {
  if (!e || !e.enabled) return null;
  return { enabled: true, ackMinutes: Math.max(1, Math.round(e.ackMinutes ?? 60)), severeValue: e.severeValue ?? null, criticalValue: e.criticalValue ?? null };
}

export interface FeatureOptions {
  publicUrl: string;
  appUrl?: string;
  secret?: string;
  allowPrivateWebhooks: boolean;
}

export function featureRoutes(app: FastifyInstance, store: Store, engine: EngineClient, scheduler: MonitorScheduler, opts: FeatureOptions) {
  const auth = { preHandler: app.authenticate };

  const engineErr = (reply: FastifyReply, e: unknown) => {
    if (e instanceof EngineError) return reply.code(e.status).send(e.body ?? { error: e.message });
    throw e;
  };

  async function owned<T extends StoredRecord>(kind: RecordKind, req: FastifyRequest<IdParams>, reply: FastifyReply): Promise<T | undefined> {
    const r = await store.getRecord<T>(kind, req.params.id);
    if (!r || r.ownerId !== req.userId) {
      reply.code(404).send({ error: `${kind} not found` });
      return undefined;
    }
    return r;
  }

  const actorName = async (req: FastifyRequest) => (await store.userById(req.userId!))?.name ?? req.userId!;

  // ------------------------------------------------------------------ regions, sources, freshness (engine relay)
  app.get<{ Querystring: { q?: string; kind?: string; geometry?: string } }>("/api/regions/search", auth, async (req, reply) => {
    const qs = new URLSearchParams();
    if (req.query.q) qs.set("q", req.query.q);
    if (req.query.kind) qs.set("kind", req.query.kind);
    if (req.query.geometry === "true") qs.set("geometry", "true");
    try { return await engine.get(`/regions?${qs}`); } catch (e) { return engineErr(reply, e); }
  });

  app.get<IdParams>("/api/regions/:id", auth, async (req, reply) => {
    try { return await engine.get(`/regions/${encodeURIComponent(req.params.id)}`); } catch (e) { return engineErr(reply, e); }
  });

  app.get<IdParams>("/api/regions/:id/freshness", auth, async (req, reply) => {
    try { return await engine.get(`/regions/${encodeURIComponent(req.params.id)}/freshness`); } catch (e) { return engineErr(reply, e); }
  });

  app.get("/api/sources", auth, async (_req, reply) => {
    try { return await engine.get("/sources"); } catch (e) { return engineErr(reply, e); }
  });

  app.post<{ Querystring: { source?: string } }>("/api/sources/check", auth, async (req, reply) => {
    try {
      return await engine.json(`/sources/check${req.query.source ? `?source=${encodeURIComponent(req.query.source)}` : ""}`, { method: "POST" }, 300_000);
    } catch (e) { return engineErr(reply, e); }
  });

  // ------------------------------------------------------------------ areas of interest
  app.get("/api/aois", auth, async (req) => store.listRecords<AOI>("aoi", req.userId!));

  app.post<{ Body: { name?: string; regionId?: string; geometry?: unknown; description?: string } }>("/api/aois", {
    ...auth,
    schema: { body: { type: "object", properties: { name: { type: "string", maxLength: 120 }, regionId: { type: "string", maxLength: 120 },
      geometry: { type: "object" }, description: { type: "string", maxLength: 500 } } } },
  }, async (req, reply) => {
    const b = req.body ?? {};
    let regionId = b.regionId, kind: AOI["kind"] = "district", state = "", areaKm2: number | null = null, name = b.name?.trim();
    try {
      if (b.geometry) {
        const geom = normaliseGeometry(b.geometry);
        if (!geom) return reply.code(400).send({ error: "geometry must be a GeoJSON Polygon/MultiPolygon, Feature or FeatureCollection" });
        const r = await engine.post<any>("/regions", { name: name || "Custom area", geometry: geom, description: b.description ?? "" });
        regionId = r.id; kind = "custom"; areaKm2 = r.area_km2 ?? null;
      } else if (regionId) {
        const r = await engine.get<any>(`/regions/${encodeURIComponent(regionId)}`);
        kind = r.simulated ? "demo" : r.kind === "custom" ? "custom" : "district"; state = r.state ?? ""; areaKm2 = r.area_km2 ?? null;
        name = name || r.name;
      } else {
        return reply.code(400).send({ error: "give a district regionId or a geometry" });
      }
    } catch (e) { return engineErr(reply, e); }
    const aoi: AOI = { id: randomUUID(), ownerId: req.userId!, createdAt: now(), name: name || regionId!, regionId: regionId!, kind, state,
      description: b.description ?? "", areaKm2 };
    await store.putRecord("aoi", aoi);
    await audit(store, req.userId!, req.userId!, "aoi.create", `aoi:${aoi.id}`, { regionId }, await actorName(req));
    return reply.code(201).send(aoi);
  });

  app.delete<IdParams>("/api/aois/:id", auth, async (req, reply) => {
    const a = await owned<AOI>("aoi", req, reply);
    if (!a) return;
    const used = (await store.listRecords<Monitor>("monitor", req.userId!)).filter((m) => m.aoiId === a.id);
    if (used.length) return reply.code(409).send({ error: `used by ${used.length} monitor(s): ${used.map((m) => m.name).join(", ")}` });
    await store.deleteRecord("aoi", a.id);
    if (a.kind === "custom") { try { await engine.json(`/regions/${encodeURIComponent(a.regionId)}`, { method: "DELETE" }); } catch { /* already gone */ } }
    await audit(store, req.userId!, req.userId!, "aoi.delete", `aoi:${a.id}`, {}, await actorName(req));
    return { ok: true };
  });

  // ------------------------------------------------------------------ monitors
  const monitorSchema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120 }, aoiId: { type: "string" }, question: { type: "string", minLength: 3, maxLength: 1000 },
      schedule: { type: "object", required: ["type"], properties: { type: { enum: ["interval", "daily", "new_pass", "manual"] },
        hours: { type: "number", minimum: 1, maximum: 720 }, time: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" } } },
      threshold: { type: ["object", "null"], properties: { metric: { enum: ["value", "lo", "hi"] }, op: { enum: [">", ">=", "<", "<="] }, value: { type: "number" } } },
      recipientIds: { type: "array", items: { type: "string" }, maxItems: 200 }, groupIds: { type: "array", items: { type: "string" }, maxItems: 50 },
      escalation: { type: ["object", "null"], properties: { enabled: { type: "boolean" }, ackMinutes: { type: "number", minimum: 1, maximum: 10080 },
        severeValue: { type: ["number", "null"] }, criticalValue: { type: ["number", "null"] } } },
      autoReport: { type: "boolean" }, requireApproval: { type: "boolean" }, enabled: { type: "boolean" },
    },
  };

  app.get("/api/monitors", auth, async (req) => store.listRecords<Monitor>("monitor", req.userId!));

  app.post<{ Body: Partial<Monitor> }>("/api/monitors", { ...auth, schema: { body: { ...monitorSchema, required: ["name", "aoiId", "question", "schedule"] } } },
    async (req, reply) => {
      const b = req.body;
      const aoi = await store.getRecord<AOI>("aoi", b.aoiId!);
      if (!aoi || aoi.ownerId !== req.userId) return reply.code(400).send({ error: "unknown area of interest" });
      try {
        const c = await engine.post<any>("/compile", { question: b.question, region_id: aoi.regionId });
        if (!c.plan?.ok) return reply.code(422).send({ error: "the question cannot run on this area", plan: c.plan, compile: c.compile });
      } catch (e) { return engineErr(reply, e); }
      const m: Monitor = {
        id: randomUUID(), ownerId: req.userId!, createdAt: now(), name: b.name!.trim(), aoiId: aoi.id, regionId: aoi.regionId,
        question: b.question!.trim(), schedule: b.schedule!, threshold: b.threshold ?? null, recipientIds: b.recipientIds ?? [],
        groupIds: b.groupIds ?? [], escalation: normaliseEscalation(b.escalation), autoReport: b.autoReport ?? false, requireApproval: b.requireApproval ?? true,
        enabled: b.enabled ?? true, lastRunAt: null, lastQueryId: null, lastValue: null, lastStatus: null, lastError: null,
      };
      m.nextRunAt = nextRun(m);
      await store.putRecord("monitor", m);
      await audit(store, req.userId!, req.userId!, "monitor.create", `monitor:${m.id}`, { aoi: aoi.id, schedule: m.schedule }, await actorName(req));
      return reply.code(201).send(m);
    });

  app.patch<IdParams & { Body: Partial<Monitor> }>("/api/monitors/:id", { ...auth, schema: { body: monitorSchema } }, async (req, reply) => {
    const m = await owned<Monitor>("monitor", req, reply);
    if (!m) return;
    const b = req.body;
    const upd: Monitor = { ...m };
    for (const k of ["name", "question", "schedule", "threshold", "recipientIds", "groupIds", "autoReport", "requireApproval", "enabled"] as const) {
      if (k in b) (upd as any)[k] = (b as any)[k];
    }
    if ("escalation" in b) upd.escalation = normaliseEscalation(b.escalation);
    upd.nextRunAt = nextRun(upd);
    await store.putRecord("monitor", upd);
    await audit(store, req.userId!, req.userId!, "monitor.update", `monitor:${m.id}`, { fields: Object.keys(b) }, await actorName(req));
    return upd;
  });

  app.delete<IdParams>("/api/monitors/:id", auth, async (req, reply) => {
    const m = await owned<Monitor>("monitor", req, reply);
    if (!m) return;
    await store.deleteRecord("monitor", m.id);
    await audit(store, req.userId!, req.userId!, "monitor.delete", `monitor:${m.id}`, {}, await actorName(req));
    return { ok: true };
  });

  app.post<IdParams>("/api/monitors/:id/run", auth, async (req, reply) => {
    const m = await owned<Monitor>("monitor", req, reply);
    if (!m) return;
    void scheduler.run(m, req.userId!);
    return reply.code(202).send({ ok: true, message: "monitor run started" });
  });

  app.post<IdParams & { Body: { value?: number } }>("/api/monitors/:id/drill", {
    ...auth, schema: { body: { type: ["object", "null"], properties: { value: { type: "number" } } } },
  }, async (req, reply) => {
    const m = await owned<Monitor>("monitor", req, reply);
    if (!m) return;
    if (!m.escalation?.enabled) return reply.code(400).send({ error: "Turn on escalation for this monitor first." });
    return reply.code(201).send(await scheduler.drill(m, req.body?.value ?? m.threshold?.value ?? null, await actorName(req)));
  });

  // ------------------------------------------------------------------ alerts
  app.get("/api/alerts", auth, async (req) => store.listRecords<Alert>("alert", req.userId!));

  app.patch<IdParams & { Body: { status?: Alert["status"]; assignee?: string | null; note?: string } }>("/api/alerts/:id", {
    ...auth, schema: { body: { type: "object", properties: { status: { enum: ["open", "acknowledged", "resolved"] }, assignee: { type: ["string", "null"] }, note: { type: "string", maxLength: 1000 } } } },
  }, async (req, reply) => {
    const a = await owned<Alert>("alert", req, reply);
    if (!a) return;
    const by = await actorName(req);
    if (req.body.status && req.body.status !== a.status) {
      a.history.push({ at: now(), by, action: req.body.status, note: req.body.note });
      a.status = req.body.status;
    } else if (req.body.note) {
      a.history.push({ at: now(), by, action: "note", note: req.body.note });
    }
    if ("assignee" in req.body) a.assignee = req.body.assignee ?? null;
    await store.putRecord("alert", a);
    await audit(store, req.userId!, req.userId!, `alert.${req.body.status ?? "update"}`, `alert:${a.id}`, {}, by);
    return a;
  });

  const ctx = () => ({ store, secret: opts.secret ?? "dev", publicUrl: opts.publicUrl, appUrl: opts.appUrl ?? "" });

  app.post<IdParams>("/api/alerts/:id/escalate", auth, async (req, reply) => {
    const a = await owned<Alert>("alert", req, reply);
    if (!a) return;
    if (a.status === "resolved") return reply.code(400).send({ error: "This alert is already resolved." });
    const up = await escalate(ctx(), a, "manual", await actorName(req));
    return { alert: await store.getRecord<Alert>("alert", a.id), toldNow: up.map((r) => ({ id: r.id, name: r.name, level: r.level ?? 1 })) };
  });

  /** Opened from the email each official receives, so it needs no login. The signature ties it to one alert and one person. */
  app.get<{ Params: { id: string }; Querystring: { r?: string; s?: string } }>("/api/alerts/:id/ack", async (req, reply) => {
    const page = (code: number, title: string, body: string) => reply.code(code).type("text/html; charset=utf-8").header("cache-control", "no-store")
      .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
        `<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:1.3rem">${title}</h1><p>${body}</p></body>`);
    const { r, s } = req.query;
    const a = await store.getRecord<Alert>("alert", req.params.id);
    if (!a || !r || !s || !ackValid(opts.secret ?? "dev", a.id, r, s)) return page(400, "This link is not valid", "Ask the sender for a new one.");
    const person = await store.getRecord<Recipient>("recipient", r);
    if (!person || person.ownerId !== a.ownerId) return page(400, "This link is not valid", "Ask the sender for a new one.");
    const out = await confirmByRecipient(ctx(), a, person);
    return page(200, out === "confirmed" ? "Thank you, confirmed" : "Already confirmed", `${person.name}, your confirmation of “${a.title}” is recorded${a.drill ? " (this was a drill)" : ""}.`);
  });

  // ------------------------------------------------------------------ recipients & groups
  const recipientSchema = {
    type: "object",
    properties: {
      level: { type: "integer", minimum: 1, maximum: MAX_LEVEL }, reportsToId: { type: ["string", "null"] },
      name: { type: "string", minLength: 1, maxLength: 120 }, designation: { type: "string", maxLength: 120 }, department: { type: "string", maxLength: 120 },
      state: { type: "string", maxLength: 80 }, district: { type: "string", maxLength: 80 }, regionIds: { type: "array", items: { type: "string" }, maxItems: 100 },
      email: { type: "string", maxLength: 200 }, phone: { type: "string", maxLength: 30 }, channels: { type: "array", items: { enum: ["email", "whatsapp", "sms"] } },
      groupIds: { type: "array", items: { type: "string" }, maxItems: 50 }, active: { type: "boolean" },
    },
  };

  /** A reports-to link must point at one of this user's own recipients and must not make a loop. */
  async function checkChain(ownerId: string, id: string | undefined, reportsToId: string | null | undefined): Promise<string | null> {
    if (!reportsToId) return null;
    const all = await store.listRecords<Recipient>("recipient", ownerId);
    if (!all.some((r) => r.id === reportsToId)) return "The person this one reports to was not found.";
    if (id && wouldLoop(all, id, reportsToId)) return "That would make a loop: someone cannot report to themselves or to someone who reports to them.";
    return null;
  }

  app.get("/api/hierarchy-levels", auth, async () => LEVELS);

  app.get<{ Querystring: { area?: string; group?: string } }>("/api/recipients", auth, async (req) => {
    let rs = await store.listRecords<Recipient>("recipient", req.userId!);
    if (req.query.area) rs = rs.filter((r) => r.regionIds.includes(req.query.area!));
    if (req.query.group) rs = rs.filter((r) => r.groupIds.includes(req.query.group!));
    return rs;
  });

  app.post<{ Body: Partial<Recipient> }>("/api/recipients", { ...auth, schema: { body: { ...recipientSchema, required: ["name", "email"] } } }, async (req, reply) => {
    const b = req.body;
    const email = b.email!.trim().toLowerCase();
    if (!EMAIL.test(email)) return reply.code(400).send({ error: "invalid email" });
    const chain = await checkChain(req.userId!, undefined, b.reportsToId);
    if (chain) return reply.code(400).send({ error: chain });
    const r: Recipient = { id: randomUUID(), ownerId: req.userId!, createdAt: now(), level: b.level ?? 1, reportsToId: b.reportsToId ?? null, name: b.name!.trim(), designation: b.designation ?? "",
      department: b.department ?? "", state: b.state ?? "", district: b.district ?? "", regionIds: b.regionIds ?? [], email, phone: b.phone ?? "",
      channels: b.channels?.length ? b.channels : ["email"], groupIds: b.groupIds ?? [], active: b.active ?? true };
    await store.putRecord("recipient", r);
    await audit(store, req.userId!, req.userId!, "recipient.create", `recipient:${r.id}`, { email }, await actorName(req));
    return reply.code(201).send(r);
  });

  app.patch<IdParams & { Body: Partial<Recipient> }>("/api/recipients/:id", { ...auth, schema: { body: recipientSchema } }, async (req, reply) => {
    const r = await owned<Recipient>("recipient", req, reply);
    if (!r) return;
    const b = req.body;
    if (b.email !== undefined) {
      const email = b.email.trim().toLowerCase();
      if (!EMAIL.test(email)) return reply.code(400).send({ error: "invalid email" });
      b.email = email;
    }
    if ("reportsToId" in b) {
      const chain = await checkChain(req.userId!, r.id, b.reportsToId);
      if (chain) return reply.code(400).send({ error: chain });
    }
    const upd = { ...r, ...b, id: r.id, ownerId: r.ownerId, createdAt: r.createdAt } as Recipient;
    await store.putRecord("recipient", upd);
    await audit(store, req.userId!, req.userId!, "recipient.update", `recipient:${r.id}`, { fields: Object.keys(b) }, await actorName(req));
    return upd;
  });

  app.delete<IdParams>("/api/recipients/:id", auth, async (req, reply) => {
    const r = await owned<Recipient>("recipient", req, reply);
    if (!r) return;
    await store.deleteRecord("recipient", r.id);
    // nobody may keep reporting to someone who was removed: they move up to that person's own boss
    for (const x of await store.listRecords<Recipient>("recipient", req.userId!)) {
      if (x.reportsToId === r.id) await store.putRecord("recipient", { ...x, reportsToId: r.reportsToId ?? null });
    }
    await audit(store, req.userId!, req.userId!, "recipient.delete", `recipient:${r.id}`, { email: r.email }, await actorName(req));
    return { ok: true };
  });

  app.get("/api/groups", auth, async (req) => store.listRecords<Group>("group", req.userId!));
  app.post<{ Body: { name: string; description?: string } }>("/api/groups", {
    ...auth, schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 80 }, description: { type: "string", maxLength: 300 } } } },
  }, async (req, reply) => {
    const g: Group = { id: randomUUID(), ownerId: req.userId!, createdAt: now(), name: req.body.name.trim(), description: req.body.description ?? "" };
    await store.putRecord("group", g);
    return reply.code(201).send(g);
  });
  app.delete<IdParams>("/api/groups/:id", auth, async (req, reply) => {
    const g = await owned<Group>("group", req, reply);
    if (!g) return;
    await store.deleteRecord("group", g.id);
    for (const r of await store.listRecords<Recipient>("recipient", req.userId!)) {
      if (r.groupIds.includes(g.id)) await store.putRecord("recipient", { ...r, groupIds: r.groupIds.filter((x) => x !== g.id) });
    }
    return { ok: true };
  });

  // ------------------------------------------------------------------ reports
  app.get("/api/reports", auth, async (req) => store.listRecords<Report>("report", req.userId!));

  app.post<{ Body: { title?: string; queryIds: string[]; recipientIds?: string[]; groupIds?: string[]; requireApproval?: boolean } }>("/api/reports", {
    ...auth, schema: { body: { type: "object", required: ["queryIds"], properties: { title: { type: "string", maxLength: 200 },
      queryIds: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } }, recipientIds: { type: "array", items: { type: "string" } },
      groupIds: { type: "array", items: { type: "string" } }, requireApproval: { type: "boolean" } } } },
  }, async (req, reply) => {
    const sessions = [];
    for (const id of req.body.queryIds) {
      const s = await store.session(id);
      if (!s || s.userId !== req.userId) return reply.code(404).send({ error: `query ${id} not found` });
      if (s.status !== "done" && s.status !== "stopped") return reply.code(409).send({ error: `query ${id} has not finished` });
      sessions.push(s);
    }
    const r: Report = {
      id: randomUUID(), ownerId: req.userId!, createdAt: now(), title: req.body.title?.trim() || sessions[0].question.slice(0, 120),
      queryIds: req.body.queryIds, regionId: sessions[0].regionId, monitorId: null, origin: "user",
      status: req.body.requireApproval === false ? "approved" : "pending_approval", summary: reportSummary(sessions),
      recipientIds: req.body.recipientIds ?? [], groupIds: req.body.groupIds ?? [],
      approvedBy: req.body.requireApproval === false ? req.userId! : null, approvedAt: req.body.requireApproval === false ? now() : null,
    };
    await store.putRecord("report", r);
    await audit(store, req.userId!, req.userId!, "report.create", `report:${r.id}`, { queries: r.queryIds }, await actorName(req));
    const { emit } = await import("./webhooks.js");
    await emit(store, req.userId!, "report.ready", reportPayload(r, await reportRecipients(store, r), opts.publicUrl));
    void autoDeliver(store, engine, r, req.log);
    return reply.code(201).send(r);
  });

  app.get<IdParams>("/api/reports/:id", auth, async (req, reply) => {
    const r = await owned<Report>("report", req, reply);
    if (!r) return;
    const deliveries = (await store.listRecords<Delivery>("delivery", req.userId!)).filter((d) => d.reportId === r.id);
    const recipients = await reportRecipients(store, r);
    return { ...r, deliveries, recipients };
  });

  app.patch<IdParams & { Body: { title?: string; recipientIds?: string[]; groupIds?: string[]; summary?: string } }>("/api/reports/:id", {
    ...auth, schema: { body: { type: "object", properties: { title: { type: "string", maxLength: 200 }, summary: { type: "string", maxLength: 4000 },
      recipientIds: { type: "array", items: { type: "string" } }, groupIds: { type: "array", items: { type: "string" } } } } },
  }, async (req, reply) => {
    const r = await owned<Report>("report", req, reply);
    if (!r) return;
    if (["sending", "sent"].includes(r.status)) return reply.code(409).send({ error: "a sent report cannot be edited" });
    const upd = { ...r, ...req.body };
    if (r.status === "approved" && (req.body.summary || req.body.title)) { upd.status = "pending_approval"; upd.approvedBy = null; upd.approvedAt = null; }
    await store.putRecord("report", upd);
    return upd;
  });

  app.delete<IdParams>("/api/reports/:id", auth, async (req, reply) => {
    const r = await owned<Report>("report", req, reply);
    if (!r) return;
    await store.deleteRecord("report", r.id);
    await audit(store, req.userId!, req.userId!, "report.delete", `report:${r.id}`, {}, await actorName(req));
    return { ok: true };
  });

  app.get<IdParams & { Querystring: { style?: string } }>("/api/reports/:id/pdf", auth, async (req, reply) => {
    const r = await owned<Report>("report", req, reply);
    if (!r) return;
    const style = req.query.style === "simple" ? "simple" : "technical";
    const pdf = await buildReportPdf(store, engine, r, style);
    reply.header("content-type", "application/pdf");
    reply.header("content-disposition", `inline; filename="bhu-drishti-${style === "simple" ? "summary" : "technical"}-${r.id}.pdf"`);
    return reply.send(pdf);
  });

  app.get<IdParams>("/api/reports/:id/recipients", auth, async (req, reply) => {
    const r = await owned<Report>("report", req, reply);
    if (!r) return;
    return reportRecipients(store, r);
  });

  app.post<IdParams & { Body: { note?: string } | null }>("/api/reports/:id/approve", auth, async (req, reply) => {
    const r = await owned<Report>("report", req, reply);
    if (!r) return;
    if (r.status !== "pending_approval" && r.status !== "draft") return reply.code(409).send({ error: `report is already ${r.status}` });
    r.status = "approved";
    r.approvedBy = req.userId!;
    r.approvedAt = now();
    if (req.body?.note) r.note = req.body.note;
    await store.putRecord("report", r);
    await audit(store, req.userId!, req.userId!, "report.approve", `report:${r.id}`, { note: req.body?.note }, await actorName(req));
    if (deliveryMode() === "n8n") {
      try { return { ...r, delivery: await sendReport(store, engine, r, req.userId!, opts.publicUrl) }; }
      catch (e) { return reply.code((e as any).statusCode ?? 500).send({ error: (e as Error).message }); }
    }
    return r;
  });

  app.post<IdParams & { Body: { reason?: string } | null }>("/api/reports/:id/reject", auth, async (req, reply) => {
    const r = await owned<Report>("report", req, reply);
    if (!r) return;
    if (r.status !== "pending_approval") return reply.code(409).send({ error: `report is ${r.status}` });
    r.status = "draft";
    r.note = req.body?.reason ? `rejected: ${req.body.reason}` : "rejected";
    await store.putRecord("report", r);
    await audit(store, req.userId!, req.userId!, "report.reject", `report:${r.id}`, { reason: req.body?.reason }, await actorName(req));
    return r;
  });

  app.post<IdParams>("/api/reports/:id/send", auth, async (req, reply) => {
    const r = await owned<Report>("report", req, reply);
    if (!r) return;
    try {
      return await sendReport(store, engine, r, req.userId!, opts.publicUrl);
    } catch (e) {
      return reply.code((e as any).statusCode ?? 500).send({ error: (e as Error).message });
    }
  });

  /** Delivery callback for n8n (or any external sender). */
  app.post<IdParams & { Body: { recipient_id?: string; to?: string; status: Delivery["status"]; error?: string; provider_message_id?: string; channel?: Delivery["channel"] } }>(
    "/api/reports/:id/deliveries", {
      ...auth, schema: { body: { type: "object", required: ["status"], properties: { recipient_id: { type: "string" }, to: { type: "string", maxLength: 200 },
        status: { enum: ["queued", "sent", "failed", "opened"] }, error: { type: "string", maxLength: 1000 }, provider_message_id: { type: "string", maxLength: 300 },
        channel: { enum: ["email", "whatsapp", "sms"] } } } },
    }, async (req, reply) => {
      const r = await owned<Report>("report", req, reply);
      if (!r) return;
      const rec = req.body.recipient_id ? await store.getRecord<Recipient>("recipient", req.body.recipient_id) : null;
      const d = await logDelivery(store, r, rec && rec.ownerId === req.userId ? rec : null, req.body.status, "n8n", req.body.error ?? null,
        req.body.provider_message_id ?? null, req.body.to);
      const all = (await store.listRecords<Delivery>("delivery", req.userId!)).filter((x) => x.reportId === r.id && x.via === "n8n");
      const latest = new Map<string, Delivery>();
      for (const x of all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) latest.set(x.to || x.recipientId || x.id, x);
      const st = [...latest.values()].map((x) => x.status);
      if (st.length && st.every((s) => s === "sent" || s === "opened")) r.status = "sent";
      else if (st.some((s) => s === "sent" || s === "opened") && !st.includes("queued")) r.status = "partially_sent";
      else if (st.length && st.every((s) => s === "failed")) r.status = "failed";
      if (r.status === "sent") r.sentAt = now();
      await store.putRecord("report", r);
      return reply.code(201).send(d);
    });

  /** Daily bulletin: one report per enabled monitor from its latest finished run (n8n Cron calls this). */
  app.post<{ Body: { monitorIds?: string[] } | null }>("/api/reports/generate", auth, async (req) => {
    const ms = (await store.listRecords<Monitor>("monitor", req.userId!)).filter((m) => m.enabled && m.lastQueryId &&
      (!req.body?.monitorIds || req.body.monitorIds.includes(m.id)));
    const { emit } = await import("./webhooks.js");
    const made: Report[] = [];
    for (const m of ms) {
      const s = await store.session(m.lastQueryId!);
      if (!s || (s.status !== "done" && s.status !== "stopped")) continue;
      const r: Report = { id: randomUUID(), ownerId: req.userId!, createdAt: now(),
        title: `Daily bulletin — ${m.name} — ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}`,
        queryIds: [s.id], regionId: m.regionId, monitorId: m.id, origin: "schedule", status: "pending_approval",
        summary: s.answer ?? "", recipientIds: m.recipientIds, groupIds: m.groupIds, approvedBy: null, approvedAt: null };
      await store.putRecord("report", r);
      await emit(store, req.userId!, "report.ready", reportPayload(r, await reportRecipients(store, r), opts.publicUrl));
      made.push(r);
      void autoDeliver(store, engine, r, req.log);
    }
    await audit(store, req.userId!, req.userId!, "report.generate", "bulletin", { reports: made.length });
    return { created: made.length, reports: made };
  });

  // ------------------------------------------------------------------ webhooks
  app.get("/api/webhooks", auth, async (req) => (await store.listRecords<Webhook>("webhook", req.userId!)).map(({ secret: _s, ...h }) => h));

  app.post<{ Body: { url: string; events: Webhook["events"]; description?: string } }>("/api/webhooks", {
    ...auth, schema: { body: { type: "object", required: ["url", "events"], properties: { url: { type: "string", maxLength: 500 },
      events: { type: "array", minItems: 1, items: { enum: WEBHOOK_EVENTS } }, description: { type: "string", maxLength: 200 } } } },
  }, async (req, reply) => {
    if (!isAllowedUrl(req.body.url, opts.allowPrivateWebhooks)) {
      return reply.code(400).send({ error: "webhook URL must be https and public (set ALLOW_PRIVATE_WEBHOOKS=true for an n8n container on the same network)" });
    }
    const h: Webhook = { id: randomUUID(), ownerId: req.userId!, createdAt: now(), url: req.body.url, events: req.body.events, secret: newSecret(),
      active: true, description: req.body.description ?? "" };
    await store.putRecord("webhook", h);
    await audit(store, req.userId!, req.userId!, "webhook.create", `webhook:${h.id}`, { url: h.url, events: h.events }, await actorName(req));
    return reply.code(201).send(h); // secret shown once
  });

  app.delete<IdParams>("/api/webhooks/:id", auth, async (req, reply) => {
    const h = await owned<Webhook>("webhook", req, reply);
    if (!h) return;
    await store.deleteRecord("webhook", h.id);
    await audit(store, req.userId!, req.userId!, "webhook.delete", `webhook:${h.id}`, { url: h.url }, await actorName(req));
    return { ok: true };
  });

  app.post<IdParams>("/api/webhooks/:id/test", auth, async (req, reply) => {
    const h = await owned<Webhook>("webhook", req, reply);
    if (!h) return;
    const res = await deliver(h, h.events[0], { test: true, message: "Bhu-Drishti webhook test" });
    await store.putRecord("webhook", { ...h, lastStatus: res.status, lastError: res.error, lastDeliveredAt: now() });
    return res;
  });

  // ------------------------------------------------------------------ notifications & audit
  app.get("/api/notifications", auth, async (req) => (await store.listRecords<Notification>("notification", req.userId!)).slice(0, 100));
  app.post("/api/notifications/read-all", auth, async (req) => {
    for (const n of await store.listRecords<Notification>("notification", req.userId!)) if (!n.read) await store.putRecord("notification", { ...n, read: true });
    return { ok: true };
  });
  app.post<IdParams>("/api/notifications/:id/read", auth, async (req, reply) => {
    const n = await owned<Notification>("notification", req, reply);
    if (!n) return;
    await store.putRecord("notification", { ...n, read: true });
    return { ok: true };
  });

  app.get("/api/audit", auth, async (req) => (await store.listRecords<AuditEntry>("audit", req.userId!)).slice(0, 500));

  // ------------------------------------------------------------------ history, dashboard, usage, settings
  app.get<{ Querystring: { region?: string; status?: string; source?: string } }>("/api/history", auth, async (req) => {
    let s = await store.sessionsForUser(req.userId!, 500);
    if (req.query.region) s = s.filter((x) => x.regionId === req.query.region);
    if (req.query.status) s = s.filter((x) => x.status === req.query.status);
    if (req.query.source) s = s.filter((x) => (x.source ?? "user") === req.query.source);
    return s.map(({ result, ...x }) => ({ ...x, data_mode: (result as any)?.data_mode ?? null, stop_reason: (result as any)?.stop_reason ?? null }));
  });

  app.get("/api/dashboard", auth, async (req) => {
    const uid = req.userId!;
    const [alerts, monitors, aois, reports, sessions, notes] = await Promise.all([
      store.listRecords<Alert>("alert", uid), store.listRecords<Monitor>("monitor", uid), store.listRecords<AOI>("aoi", uid),
      store.listRecords<Report>("report", uid), store.sessionsForUser(uid, 10), store.listRecords<Notification>("notification", uid)]);
    return {
      counts: { open_alerts: alerts.filter((a) => a.status !== "resolved").length, monitors: monitors.length,
        active_monitors: monitors.filter((m) => m.enabled).length, aois: aois.length,
        reports_pending: reports.filter((r) => r.status === "pending_approval").length, unread_notifications: notes.filter((n) => !n.read).length },
      alerts: alerts.filter((a) => a.status !== "resolved").slice(0, 10), monitors: monitors.slice(0, 20), aois,
      recent_runs: sessions.map(({ result, ...x }) => ({ ...x, data_mode: (result as any)?.data_mode ?? null })),
      reports: reports.slice(0, 10),
    };
  });

  app.get("/api/usage", auth, async (req) => {
    const s = await store.sessionsForUser(req.userId!, 5000);
    const month = new Date().toISOString().slice(0, 7);
    const thisMonth = s.filter((x) => x.createdAt.startsWith(month));
    const sum = (xs: typeof s, k: string) => xs.reduce((a, x) => a + (Number((x.result as any)?.[k]) || 0), 0);
    return {
      month, runs: thisMonth.length, runs_total: s.length,
      model_runs: sum(thisMonth, "oracle_calls"), tiles_analysed: sum(thisMonth, "n"), cache_hits: sum(thisMonth, "cache_hits"),
      live_runs: thisMonth.filter((x) => (x.result as any)?.data_mode === "live").length,
      by_source: { user: thisMonth.filter((x) => (x.source ?? "user") === "user").length, monitor: thisMonth.filter((x) => x.source === "monitor").length },
    };
  });

  app.get("/api/settings/integrations", auth, async () => ({
    report_delivery: deliveryMode(), smtp_configured: smtpConfigured(), public_url: opts.publicUrl,
    webhook_events: WEBHOOK_EVENTS, allow_private_webhooks: opts.allowPrivateWebhooks,
    auto_email: autoEmailTargets(),
  }));

  app.post<{ Body: { email?: string } | null }>("/api/settings/test-email", auth, async (req, reply) => {
    const u = await store.userById(req.userId!);
    const to = (req.body?.email ?? u?.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(to) || to.endsWith("@guest.local")) return reply.code(400).send({ error: "give a valid email address" });
    if (!smtpConfigured()) return reply.code(503).send({ error: "SMTP is not configured" });
    try {
      const { sendMail } = await import("./email.js");
      await sendMail({ to, subject: "Bhu-Drishti test email", text: "Email delivery from Bhu-Drishti works." });
      await notify(store, req.userId!, "Test email sent", to);
      return { ok: true, to };
    } catch (e) {
      return reply.code(502).send({ error: `SMTP error: ${(e as Error).message}` });
    }
  });
}

/** Accept a Polygon/MultiPolygon, a Feature, or a FeatureCollection (first polygon feature, or all merged into a MultiPolygon). */
export function normaliseGeometry(g: any): any | null {
  if (!g || typeof g !== "object") return null;
  if (g.type === "Polygon" || g.type === "MultiPolygon") return g;
  if (g.type === "Feature") return normaliseGeometry(g.geometry);
  if (g.type === "FeatureCollection" && Array.isArray(g.features)) {
    const polys = g.features.map((f: any) => normaliseGeometry(f?.geometry)).filter(Boolean);
    if (!polys.length) return null;
    if (polys.length === 1) return polys[0];
    return { type: "MultiPolygon", coordinates: polys.flatMap((p: any) => (p.type === "Polygon" ? [p.coordinates] : p.coordinates)) };
  }
  return null;
}
