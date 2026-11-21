import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit, logDelivery, notify, reportRecipients } from "./delivery.js";
import { confidenceOf, fitConfidence, haversineM, notifyAuthorities, now, OFFER_TYPES, REQUEST_STATUSES, REQUEST_TYPES, SERVES, validLatLng,
  type HelpRequest, type Match, type Offer, type OfficialUpdate, type RequestSource, type RequestType, type Task } from "./disaster.js";
import type { Report } from "./domain.js";
import { sendMail, smtpConfigured } from "./email.js";
import type { EngineClient } from "./engine-client.js";
import { recordFieldCheck } from "./maun.js";
import { detectLanguage, runIntake } from "./intake.js";
import { RateLimiter } from "./ratelimit.js";
import { guard, type Profile } from "./roles.js";
import type { Store } from "./store/types.js";

type IdParams = { Params: { id: string } };

/** SOS: at most 3 new ones per user in 10 minutes (retries of the same SOS do not count). */

/** Language of a citizen's own words when the client did not say: detected, never asked for. */
const languageOf = (text: string | null) => { const l = text ? detectLanguage(text) : "und"; return l === "und" ? null : l; };
export const sosLimiter = new RateLimiter(3, 10 * 60_000);
const requestLimiter = new RateLimiter(30, 60 * 60_000);
const offerLimiter = new RateLimiter(30, 60 * 60_000);
export const SOS_CANCEL_WINDOW_MS = 60_000;

const clip = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");
const sev = (v: unknown): 1 | 2 | 3 | 4 => { const n = Math.round(Number(v)); return (n >= 1 && n <= 4 ? n : 2) as 1 | 2 | 3 | 4; };
const idFor = (prefix: string, userId: string, clientId: string) => `${prefix}-${createHash("sha256").update(`${userId}:${clientId}`).digest("hex").slice(0, 20)}`;

export interface CoordOptions { appUrl: string }

export function coordRoutes(app: FastifyInstance, store: Store, engine: EngineClient, opts: CoordOptions) {
  const roles = app.roles;
  const anyone = guard(app);
  const authority = guard(app, "authority");
  const responders = guard(app, "volunteer", "authority");

  const userName = async (id: string) => {
    const p = await store.getRecord<Profile>("profile", id);
    return p?.displayName || (await store.userById(id))?.name || "Someone";
  };
  const actor = async (req: FastifyRequest) => ({ id: req.userId!, name: await userName(req.userId!) });

  async function load<T extends { ownerId: string }>(kind: "request" | "offer" | "update" | "task", id: string, reply: FastifyReply): Promise<T | undefined> {
    const r = await store.getRecord<T & { id: string; createdAt: string }>(kind, id);
    if (!r) { reply.code(404).send({ error: `${kind} not found` }); return undefined; }
    return r;
  }

  const withConfidence = (r: HelpRequest, all: HelpRequest[], model = fitConfidence(all)) => ({ ...r, confidence: confidenceOf(r, all, model) });

  // ------------------------------------------------------------------ requests (ask for help, SOS)
  app.post<{ Body: Partial<HelpRequest> & { clientId?: string } }>("/api/requests", {
    ...anyone,
    schema: { body: { type: "object", properties: {
      type: { type: "string", enum: [...REQUEST_TYPES] }, description: { type: "string", maxLength: 4000 }, originalText: { type: "string", maxLength: 4000 },
      originalLanguage: { type: "string", maxLength: 10 }, summaryEn: { type: "string", maxLength: 1000 }, needs: { type: "array", maxItems: 10, items: { type: "string", maxLength: 60 } },
      lat: { type: ["number", "null"] }, lng: { type: ["number", "null"] }, accuracyM: { type: ["number", "null"] }, locationAt: { type: ["string", "null"], maxLength: 40 },
      area: { type: ["string", "null"], maxLength: 120 }, severity: { type: "integer", minimum: 1, maximum: 4 }, peopleAffected: { type: ["integer", "null"], minimum: 0, maximum: 100000 },
      contact: { type: ["string", "null"], maxLength: 120 }, source: { type: "string", enum: ["form", "sos", "local_language"] },
      clientId: { type: "string", minLength: 8, maxLength: 64 }, intake: { type: ["object", "null"] } } } },
  }, async (req, reply) => {
    const b = req.body ?? {};
    const source: RequestSource = b.source ?? "form";
    const uid = req.userId!;
    // idempotent: the same client id from the same user is the same request (network retries)
    const id = b.clientId ? idFor("req", uid, b.clientId) : `req-${randomUUID()}`;
    const existing = await store.getRecord<HelpRequest>("request", id);
    if (existing) return reply.code(200).send({ ...existing, duplicate: true });

    const flags: string[] = [];
    const mineRecent = (await store.listRecords<HelpRequest>("request", uid)).filter((r) => r.source === "sos" && Date.now() - Date.parse(r.createdAt) < 10 * 60_000);
    if (source === "sos") {
      if (!b.clientId) return reply.code(400).send({ error: "an SOS needs a clientId so retries are not counted twice" });
      if (!sosLimiter.check(`sos:${uid}`)) return reply.code(429).send({ error: "You have sent 3 SOS in 10 minutes. Authorities already have them; call 112 if you can." });
      if (mineRecent.length) flags.push("repeated");
    } else if (!requestLimiter.check(`req:${uid}`)) {
      return reply.code(429).send({ error: "too many requests from this account — try again later" });
    }
    const description = clip(b.description, 4000);
    const originalText = clip(b.originalText, 4000) || null;
    if (source !== "sos" && !description && !originalText) return reply.code(400).send({ error: "describe the situation (or use SOS)" });

    const hasLoc = validLatLng(b.lat, b.lng);
    const profile = await roles.profile((await store.userById(uid))!);
    if (!hasLoc) flags.push("location_missing");
    const r: HelpRequest = {
      id, ownerId: uid, createdAt: now(),
      type: (source === "sos" ? b.type ?? "rescue" : b.type ?? "other") as RequestType,
      description: description || (source === "sos" ? "SOS: help needed (no text)" : originalText ?? ""),
      originalText, originalLanguage: clip(b.originalLanguage, 10) || languageOf(originalText), summaryEn: clip(b.summaryEn, 1000) || null,
      needs: (b.needs ?? []).map((n) => clip(n, 60)).filter(Boolean),
      lat: hasLoc ? b.lat! : null, lng: hasLoc ? b.lng! : null,
      accuracyM: hasLoc && typeof b.accuracyM === "number" ? Math.round(b.accuracyM) : null,
      locationAt: hasLoc ? clip(b.locationAt, 40) || now() : null,
      area: clip(b.area, 120) || profile.ward || null,
      severity: source === "sos" ? 4 : sev(b.severity), peopleAffected: b.peopleAffected ?? null, contact: clip(b.contact, 120) || profile.phone || null,
      source, status: "new", priority: null, assigneeId: null, offerIds: [], flags, clientId: b.clientId ?? null,
      reporterName: profile.displayName, intake: (b.intake as HelpRequest["intake"]) ?? null, drain: null,
      history: [{ at: now(), by: uid, action: "created", detail: { source } }],
    };
    await store.putRecord("request", r);
    // "Send as it is": the citizen did not wait for the model, so it reads the text now, in the background
    if (source === "local_language" && !r.intake && originalText) void readLater(r.id, originalText, profile.displayName);
    await audit(store, uid, uid, `request.create`, `request:${r.id}`, { source, type: r.type, severity: r.severity, flags }, profile.displayName);
    if (source === "sos") {
      await notifyAuthorities(store, roles, `SOS${flags.includes("repeated") ? " (repeated)" : ""}: ${profile.displayName}`,
        `${r.lat != null ? `at ${r.lat.toFixed(5)}, ${r.lng!.toFixed(5)} (±${r.accuracyM ?? "?"} m)` : `location unknown${r.area ? `; area ${r.area}` : ""}`}`, "critical", `/app/requests?open=${r.id}`);
    } else if (r.severity >= 3) {
      await notifyAuthorities(store, roles, `New ${r.severity === 4 ? "critical" : "high-severity"} request: ${r.type.replace(/_/g, " ")}`,
        (r.summaryEn || r.description).slice(0, 200), r.severity === 4 ? "critical" : "warning", `/app/requests?open=${r.id}`);
    }
    return reply.code(201).send(r);
  });

  /**
   * Fill in what the model reads from a request the citizen sent without waiting for it. Only adds: the English summary
   * and needs when missing, the type when the citizen left it as "other", and the urgency only upwards (a model must
   * never make a request look less urgent than the person said). Never throws; the request stands without it.
   */
  async function readLater(id: string, text: string, who: string) {
    try {
      const res = await runIntake(text);
      if (!res.ok) return;
      const d = res.draft;
      const cur = await store.getRecord<HelpRequest>("request", id);
      if (!cur || cur.intake) return;
      const severity = Math.max(cur.severity, d.severity) as HelpRequest["severity"];
      const next: HelpRequest = {
        ...cur, summaryEn: cur.summaryEn ?? d.summary_en, needs: cur.needs.length ? cur.needs : d.needs,
        type: cur.type === "other" ? d.type : cur.type, severity, originalLanguage: cur.originalLanguage ?? (d.language === "und" ? null : d.language),
        area: cur.area ?? (d.location_hint || null),
        intake: { provider: res.provider, confidence: d.confidence, edited: false },
        history: [...cur.history, { at: now(), by: "system", action: "read_by_model", detail: { type: d.type, severity: d.severity } }],
      };
      await store.putRecord("request", next);
      if (severity >= 3 && cur.severity < 3) {
        await notifyAuthorities(store, roles, `New ${severity === 4 ? "critical" : "high-severity"} request: ${next.type.replace(/_/g, " ")}`,
          `${who}: ${(next.summaryEn || next.description).slice(0, 200)}`, severity === 4 ? "critical" : "warning", `/app/requests?open=${id}`);
      }
    } catch { /* the reading is optional */ }
  }

  app.get<{ Querystring: { mine?: string; status?: string; source?: string; sort?: string } }>("/api/requests", anyone, async (req) => {
    const all = await store.listRecords<HelpRequest>("request");
    const own = req.role !== "authority" || req.query.mine === "1";
    let list = own ? all.filter((r) => r.ownerId === req.userId) : all;
    if (req.query.status) list = list.filter((r) => r.status === req.query.status);
    if (req.query.source) list = list.filter((r) => r.source === req.query.source);
    const model = fitConfidence(all);       // learned once per listing from the authorities' decisions
    const out = list.map((r) => withConfidence(r, all, model));
    if (req.query.sort === "priority") out.sort((a, b) => b.severity * b.confidence.score - a.severity * a.confidence.score || b.createdAt.localeCompare(a.createdAt));
    else out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  });

  app.get<IdParams>("/api/requests/:id", anyone, async (req, reply) => {
    const r = await load<HelpRequest>("request", req.params.id, reply);
    if (!r) return;
    if (req.role !== "authority" && r.ownerId !== req.userId && r.assigneeId !== req.userId) return reply.code(404).send({ error: "request not found" });
    return withConfidence(r, await store.listRecords<HelpRequest>("request"));
  });

  app.patch<IdParams & { Body: { status?: HelpRequest["status"]; priority?: number | null; assigneeId?: string | null; severity?: number; type?: RequestType; note?: string } }>("/api/requests/:id", {
    ...authority,
    schema: { body: { type: "object", properties: { status: { type: "string", enum: [...REQUEST_STATUSES] }, priority: { type: ["integer", "null"], minimum: 1, maximum: 4 },
      assigneeId: { type: ["string", "null"] }, severity: { type: "integer", minimum: 1, maximum: 4 }, type: { type: "string", enum: [...REQUEST_TYPES] }, note: { type: "string", maxLength: 500 } } } },
  }, async (req, reply) => {
    const r = await load<HelpRequest>("request", req.params.id, reply);
    if (!r) return;
    const a = await actor(req);
    const b = req.body;
    const change: Record<string, unknown> = {};
    for (const k of ["status", "priority", "assigneeId", "severity", "type"] as const) if (b[k] !== undefined && b[k] !== r[k]) change[k] = b[k];
    if (b.note) change.note = b.note;
    const next: HelpRequest = { ...r, ...(change as Partial<HelpRequest>), updatedAt: now(), history: [...r.history, { at: now(), by: a.id, action: "triage", detail: change }] };
    delete (next as Record<string, unknown>).note;
    await store.putRecord("request", next);
    await audit(store, a.id, a.id, "request.triage", `request:${r.id}`, change, a.name);
    if (b.status && b.status !== r.status) await notify(store, r.ownerId, `Your request is now ${b.status.replace(/_/g, " ")}`, r.description.slice(0, 160), "info", "/app/my-requests");
    return next;
  });

  /** The reporter cancels: an SOS within 60 s ("sent by mistake"), any other request while it is still new. */
  app.post<IdParams & { Body: { reason?: string } | null }>("/api/requests/:id/cancel", anyone, async (req, reply) => {
    const r = await load<HelpRequest>("request", req.params.id, reply);
    if (!r) return;
    if (r.ownerId !== req.userId) return reply.code(404).send({ error: "request not found" });
    if (r.status === "cancelled") return r;
    const age = Date.now() - Date.parse(r.createdAt);
    if (r.source === "sos" && age > SOS_CANCEL_WINDOW_MS) return reply.code(409).send({ error: "The 60-second cancel window has passed. Authorities can close it after checking." });
    if (r.source !== "sos" && r.status !== "new") return reply.code(409).send({ error: "This request is already being handled; ask the authority to close it." });
    const flags = [...new Set([...r.flags, "cancelled_by_reporter", ...(r.source === "sos" ? ["possible_accidental"] : [])])];
    const next: HelpRequest = { ...r, status: "cancelled", flags, updatedAt: now(), history: [...r.history, { at: now(), by: req.userId!, action: "cancelled", detail: { reason: clip(req.body?.reason, 200) || null, after_s: Math.round(age / 1000) } }] };
    await store.putRecord("request", next);
    await audit(store, req.userId!, req.userId!, "request.cancel", `request:${r.id}`, { source: r.source, after_s: Math.round(age / 1000) }, r.reporterName);
    await notifyAuthorities(store, roles, `${r.source === "sos" ? "SOS" : "Request"} cancelled by the reporter`, `${r.reporterName}: marked as sent by mistake`, "info", `/app/requests?open=${r.id}`);
    return next;
  });

  // ------------------------------------------------------------------ offers of help
  app.post<{ Body: Partial<Offer> }>("/api/offers", {
    ...anyone,
    schema: { body: { type: "object", required: ["type"], properties: {
      type: { type: "string", enum: [...OFFER_TYPES] }, quantity: { type: "number", minimum: 0, maximum: 1e6 }, unit: { type: "string", maxLength: 30 },
      description: { type: "string", maxLength: 1000 }, lat: { type: ["number", "null"] }, lng: { type: ["number", "null"] },
      availableFrom: { type: ["string", "null"], maxLength: 40 }, availableTo: { type: ["string", "null"], maxLength: 40 }, contact: { type: ["string", "null"], maxLength: 120 } } } },
  }, async (req, reply) => {
    if (!offerLimiter.check(`offer:${req.userId}`)) return reply.code(429).send({ error: "too many offers — try again later" });
    const b = req.body;
    const a = await actor(req);
    const loc = validLatLng(b.lat, b.lng);
    const o: Offer = { id: `off-${randomUUID()}`, ownerId: a.id, createdAt: now(), type: b.type!, quantity: b.quantity ?? 1, unit: clip(b.unit, 30) || "units",
      description: clip(b.description, 1000), lat: loc ? b.lat! : null, lng: loc ? b.lng! : null, availableFrom: b.availableFrom ?? null, availableTo: b.availableTo ?? null,
      contact: clip(b.contact, 120) || null, status: "available", offeredByName: a.name, matchIds: [] };
    await store.putRecord("offer", o);
    await audit(store, a.id, a.id, "offer.create", `offer:${o.id}`, { type: o.type, quantity: o.quantity }, a.name);
    return reply.code(201).send(o);
  });

  app.get<{ Querystring: { mine?: string; status?: string } }>("/api/offers", anyone, async (req) => {
    let list = await store.listRecords<Offer>("offer");
    if (req.role !== "authority" || req.query.mine === "1") list = list.filter((o) => o.ownerId === req.userId);
    if (req.query.status) list = list.filter((o) => o.status === req.query.status);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  app.patch<IdParams & { Body: { status?: Offer["status"]; quantity?: number; availableTo?: string | null } }>("/api/offers/:id", {
    ...anyone,
    schema: { body: { type: "object", properties: { status: { type: "string", enum: ["available", "matched", "used", "withdrawn"] }, quantity: { type: "number", minimum: 0 }, availableTo: { type: ["string", "null"] } } } },
  }, async (req, reply) => {
    const o = await load<Offer>("offer", req.params.id, reply);
    if (!o) return;
    if (o.ownerId !== req.userId && req.role !== "authority") return reply.code(404).send({ error: "offer not found" });
    const next: Offer = { ...o, ...req.body, updatedAt: now() };
    await store.putRecord("offer", next);
    return next;
  });

  // ------------------------------------------------------------------ matching offers to requests
  // No weighted score: offers are ordered by what matters first: a resource that serves this kind of request, then the
  // nearest, then the one that covers the most people. Unknown distance sorts after known distances.
  const rankOffers = (r: HelpRequest, offers: Offer[]) => offers.filter((o) => o.status === "available").map((o) => {
    const km = r.lat != null && o.lat != null ? haversineM(r.lat, r.lng!, o.lat, o.lng!) / 1000 : null;
    return { offer: o, km: km == null ? null : Math.round(km * 10) / 10, typeFits: SERVES[r.type].includes(o.type),
      covers: r.peopleAffected ? Math.min(1, o.quantity / r.peopleAffected) : null, score: null as number | null };
  }).sort((a, b) => Number(b.typeFits) - Number(a.typeFits) || (a.km ?? Infinity) - (b.km ?? Infinity) || (b.covers ?? 0) - (a.covers ?? 0));

  app.get<{ Querystring: { requestId: string } }>("/api/matches/suggest", authority, async (req, reply) => {
    const r = await store.getRecord<HelpRequest>("request", req.query.requestId ?? "");
    if (!r) return reply.code(404).send({ error: "request not found" });
    return rankOffers(r, await store.listRecords<Offer>("offer")).slice(0, 10);
  });

  app.post<{ Body: { requestId: string; offerId: string; createTask?: boolean } }>("/api/matches", {
    ...authority,
    schema: { body: { type: "object", required: ["requestId", "offerId"], properties: { requestId: { type: "string" }, offerId: { type: "string" }, createTask: { type: "boolean" } } } },
  }, async (req, reply) => {
    const r = await store.getRecord<HelpRequest>("request", req.body.requestId);
    const o = await store.getRecord<Offer>("offer", req.body.offerId);
    if (!r || !o) return reply.code(404).send({ error: "request or offer not found" });
    if (o.status !== "available") return reply.code(409).send({ error: `offer is ${o.status}` });
    const a = await actor(req);
    const score = rankOffers(r, [o])[0]?.score ?? null;
    let taskId: string | null = null;
    if (req.body.createTask !== false) {
      const t: Task = { id: `task-${randomUUID()}`, ownerId: a.id, createdAt: now(), title: `Deliver ${o.type} to ${r.reporterName}`, type: "delivery",
        description: `${o.quantity} ${o.unit} of ${o.type} (offered by ${o.offeredByName}) for: ${(r.summaryEn || r.description).slice(0, 300)}`,
        requestId: r.id, offerId: o.id, runId: null, cellId: null, lat: r.lat, lng: r.lng, status: "open", claimedBy: null, claimedByName: null,
        claimedAt: null, completedAt: null, note: null, result: null, createdBy: a.id };
      await store.putRecord("task", t);
      taskId = t.id;
    }
    const m: Match = { id: `match-${randomUUID()}`, ownerId: a.id, createdAt: now(), requestId: r.id, offerId: o.id, taskId, score, createdBy: a.id };
    await store.putRecord("match", m);
    await store.putRecord("offer", { ...o, status: "matched", matchIds: [...o.matchIds, m.id], updatedAt: now() });
    await store.putRecord("request", { ...r, status: r.status === "new" || r.status === "verified" ? "assigned" : r.status, offerIds: [...r.offerIds, o.id], updatedAt: now(),
      history: [...r.history, { at: now(), by: a.id, action: "matched", detail: { offerId: o.id, taskId } }] });
    await audit(store, a.id, a.id, "match.create", `request:${r.id}`, { offerId: o.id, taskId, score }, a.name);
    await notify(store, o.ownerId, "Your offer was matched", `${o.type} for ${r.reporterName}. A volunteer task was created.`, "info", "/app/offers");
    await notify(store, r.ownerId, "Help is being arranged", `${o.type} from ${o.offeredByName} was matched to your request.`, "info", "/app/my-requests");
    return reply.code(201).send(m);
  });

  app.get("/api/matches", authority, async () => store.listRecords<Match>("match"));

  // ------------------------------------------------------------------ official updates: drafted, approved by a second authority, published
  app.post<{ Body: Partial<OfficialUpdate> }>("/api/updates", {
    ...authority,
    schema: { body: { type: "object", required: ["title", "body"], properties: {
      title: { type: "string", minLength: 3, maxLength: 160 }, body: { type: "string", minLength: 3, maxLength: 5000 }, area: { type: "string", maxLength: 160 },
      severity: { type: "string", enum: ["info", "advisory", "warning", "emergency"] }, expiresAt: { type: ["string", "null"], maxLength: 40 },
      recipientIds: { type: "array", items: { type: "string" } }, groupIds: { type: "array", items: { type: "string" } } } } },
  }, async (req, reply) => {
    const a = await actor(req);
    const b = req.body;
    const u: OfficialUpdate = { id: `upd-${randomUUID()}`, ownerId: a.id, createdAt: now(), title: clip(b.title, 160), body: clip(b.body, 5000), area: clip(b.area, 160) || "All areas",
      severity: b.severity ?? "info", expiresAt: b.expiresAt ?? null, status: "pending_approval", authorId: a.id, authorName: a.name, approvedBy: null, approvedByName: null,
      publishedAt: null, rejectedNote: null, recipientIds: b.recipientIds ?? [], groupIds: b.groupIds ?? [], delivery: null };
    await store.putRecord("update", u);
    await audit(store, a.id, a.id, "update.draft", `update:${u.id}`, { title: u.title, severity: u.severity }, a.name);
    for (const id of await roles.authorityIds()) if (id !== a.id) await notify(store, id, "Bulletin waiting for a second approval", u.title, "warning", "/app/updates");
    return reply.code(201).send(u);
  });

  app.get<{ Querystring: { all?: string } }>("/api/updates", anyone, async (req) => {
    const list = await store.listRecords<OfficialUpdate>("update");
    const live = (u: OfficialUpdate) => u.status === "published" && (!u.expiresAt || Date.parse(u.expiresAt) > Date.now() || req.query.all === "1");
    const visible = req.role === "authority" ? list.filter((u) => u.status !== "published" || live(u)) : list.filter(live);
    return visible.sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt));
  });

  app.post<IdParams>("/api/updates/:id/approve", authority, async (req, reply) => {
    const u = await load<OfficialUpdate>("update", req.params.id, reply);
    if (!u) return;
    if (u.status !== "pending_approval") return reply.code(409).send({ error: `bulletin is already ${u.status.replace(/_/g, " ")}` });
    if (u.authorId === req.userId) return reply.code(409).send({ error: "A second authority must approve. You drafted this bulletin." });
    const a = await actor(req);
    const pub: OfficialUpdate = { ...u, status: "published", approvedBy: a.id, approvedByName: a.name, publishedAt: now(), updatedAt: now() };
    await store.putRecord("update", pub);
    await audit(store, a.id, a.id, "update.approve", `update:${u.id}`, { author: u.authorName }, a.name);
    pub.delivery = await deliverUpdate(pub);
    await store.putRecord("update", pub);
    return pub;
  });

  app.post<IdParams & { Body: { note?: string } | null }>("/api/updates/:id/reject", authority, async (req, reply) => {
    const u = await load<OfficialUpdate>("update", req.params.id, reply);
    if (!u) return;
    if (u.status !== "pending_approval") return reply.code(409).send({ error: `bulletin is already ${u.status.replace(/_/g, " ")}` });
    if (u.authorId === req.userId) return reply.code(409).send({ error: "A second authority must review this bulletin." });
    const a = await actor(req);
    const next: OfficialUpdate = { ...u, status: "rejected", rejectedNote: clip(req.body?.note, 500) || null, updatedAt: now() };
    await store.putRecord("update", next);
    await audit(store, a.id, a.id, "update.reject", `update:${u.id}`, { note: next.rejectedNote }, a.name);
    await notify(store, u.authorId, "Bulletin not approved", `${u.title}${next.rejectedNote ? `: ${next.rejectedNote}` : ""}`, "warning", "/app/updates");
    return next;
  });

  /** Email a published bulletin to the author's chosen recipients and groups; every attempt is logged. */
  async function deliverUpdate(u: OfficialUpdate): Promise<OfficialUpdate["delivery"]> {
    const asReport = { id: `update:${u.id}`, ownerId: u.authorId, recipientIds: u.recipientIds, groupIds: u.groupIds, title: u.title } as unknown as Report;
    const people = await reportRecipients(store, asReport);
    if (!people.length) return { sent: 0, failed: 0, note: "published to the Updates feed; no email recipients were chosen" };
    if (!smtpConfigured()) {
      for (const p of people) await logDelivery(store, asReport, p, "failed", "smtp", "SMTP is not configured");
      return { sent: 0, failed: people.length, note: "SMTP is not configured; published to the Updates feed only" };
    }
    let sent = 0, failed = 0;
    const text = `${u.title}\n\nArea: ${u.area}\nSeverity: ${u.severity}${u.expiresAt ? `\nValid until: ${u.expiresAt}` : ""}\n\n${u.body}\n\n` +
      `Drafted by ${u.authorName}, approved by ${u.approvedByName}, on the Maun coordination platform (${opts.appUrl}/app/updates).\n` +
      `This is a coordination bulletin from the response team. For official government warnings follow NDMA SACHET and your district administration.`;
    for (const p of people) {
      try {
        const r = await sendMail({ to: p.email, subject: `[${u.severity.toUpperCase()}] ${u.title}`, text });
        await logDelivery(store, asReport, p, "sent", "smtp", null, r.messageId);
        sent++;
      } catch (e) {
        await logDelivery(store, asReport, p, "failed", "smtp", (e as Error).message);
        failed++;
      }
    }
    await audit(store, u.approvedBy!, "system", "update.deliver", `update:${u.id}`, { sent, failed });
    return { sent, failed, note: null };
  }

  // ------------------------------------------------------------------ volunteer tasks
  app.post<{ Body: Partial<Task> }>("/api/tasks", {
    ...authority,
    schema: { body: { type: "object", required: ["title"], properties: {
      title: { type: "string", minLength: 3, maxLength: 160 }, type: { type: "string", enum: ["field_check", "rescue", "delivery", "assessment", "general"] },
      description: { type: "string", maxLength: 2000 }, requestId: { type: ["string", "null"] }, lat: { type: ["number", "null"] }, lng: { type: ["number", "null"] } } } },
  }, async (req, reply) => {
    const a = await actor(req);
    const b = req.body;
    let lat = validLatLng(b.lat, b.lng) ? b.lat! : null, lng = lat != null ? b.lng! : null;
    if (b.requestId) {
      const r = await store.getRecord<HelpRequest>("request", b.requestId);
      if (!r) return reply.code(404).send({ error: "request not found" });
      if (lat == null) { lat = r.lat; lng = r.lng; }
    }
    const t: Task = { id: `task-${randomUUID()}`, ownerId: a.id, createdAt: now(), title: clip(b.title, 160), type: b.type ?? "general", description: clip(b.description, 2000),
      requestId: b.requestId ?? null, offerId: null, runId: null, cellId: null, lat, lng, status: "open", claimedBy: null, claimedByName: null, claimedAt: null,
      completedAt: null, note: null, result: null, createdBy: a.id };
    await store.putRecord("task", t);
    await audit(store, a.id, a.id, "task.create", `task:${t.id}`, { type: t.type, requestId: t.requestId }, a.name);
    return reply.code(201).send(t);
  });

  app.get<{ Querystring: { status?: string; runId?: string } }>("/api/tasks", responders, async (req) => {
    let list = await store.listRecords<Task>("task");
    if (req.role !== "authority") list = list.filter((t) => t.status === "open" || t.claimedBy === req.userId);
    if (req.query.status) list = list.filter((t) => t.status === req.query.status);
    if (req.query.runId) list = list.filter((t) => t.runId === req.query.runId);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  app.post<IdParams>("/api/tasks/:id/claim", responders, async (req, reply) => {
    const t = await load<Task>("task", req.params.id, reply);
    if (!t) return;
    if (t.status !== "open") return reply.code(409).send({ error: `task is ${t.status}` });
    const a = await actor(req);
    const next: Task = { ...t, status: "claimed", claimedBy: a.id, claimedByName: a.name, claimedAt: now(), updatedAt: now() };
    await store.putRecord("task", next);
    if (t.requestId) {
      const r = await store.getRecord<HelpRequest>("request", t.requestId);
      if (r && r.status !== "resolved" && r.status !== "cancelled") await store.putRecord("request", { ...r, status: "in_progress", assigneeId: a.id, updatedAt: now(),
        history: [...r.history, { at: now(), by: a.id, action: "task_claimed", detail: { taskId: t.id } }] });
    }
    await audit(store, a.id, a.id, "task.claim", `task:${t.id}`, {}, a.name);
    return next;
  });

  app.post<IdParams>("/api/tasks/:id/release", responders, async (req, reply) => {
    const t = await load<Task>("task", req.params.id, reply);
    if (!t) return;
    if (t.status !== "claimed" || (t.claimedBy !== req.userId && req.role !== "authority")) return reply.code(409).send({ error: "only the person who claimed it can release it" });
    const next: Task = { ...t, status: "open", claimedBy: null, claimedByName: null, claimedAt: null, updatedAt: now() };
    await store.putRecord("task", next);
    return next;
  });

  app.post<IdParams & { Body: { note?: string; unreachable?: boolean; result?: Record<string, unknown> } | null }>("/api/tasks/:id/complete", {
    ...responders,
    schema: { body: { type: ["object", "null"], properties: { note: { type: "string", maxLength: 1000 }, unreachable: { type: "boolean" }, result: { type: "object" } } } },
  }, async (req, reply) => {
    const t = await load<Task>("task", req.params.id, reply);
    if (!t) return;
    if (t.status !== "claimed") return reply.code(409).send({ error: t.status === "open" ? "claim the task first" : `task is ${t.status}` });
    if (t.claimedBy !== req.userId && req.role !== "authority") return reply.code(403).send({ error: "this task is claimed by someone else" });
    const b = req.body ?? {};
    const a = await actor(req);
    let result = b.result ?? null;
    if (t.type === "field_check") {
      // a field check must report a count (households in need) or that the cell could not be reached; never a swap
      if (!b.unreachable) {
        const hh = Number(result?.households);
        if (!Number.isFinite(hh) || hh < 0) return reply.code(400).send({ error: "enter the number of households in need (0 if none), or mark the cell unreachable" });
        result = { ...result, households: Math.round(hh) };
      }
      try {
        await recordFieldCheck(store, engine, t, b.unreachable ? { unreachable: true } : { households: Number(result!.households), detail: result! });
      } catch (e) {
        return reply.code((e as { statusCode?: number }).statusCode ?? 502).send({ error: `could not record the check: ${(e as Error).message}` });
      }
    }
    const next: Task = { ...t, status: b.unreachable ? "unreachable" : "done", completedAt: now(), note: clip(b.note, 1000) || null, result, updatedAt: now() };
    await store.putRecord("task", next);
    await audit(store, a.id, a.id, b.unreachable ? "task.unreachable" : "task.complete", `task:${t.id}`, { type: t.type, result }, a.name);
    if (b.unreachable) await notifyAuthorities(store, roles, "Field check: cell unreachable", `${t.title}. It stays in the sample and is flagged as a priority.`, "warning", "/app/estimates");
    return next;
  });
}
