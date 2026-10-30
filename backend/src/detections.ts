import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit } from "./delivery.js";
import { EngineClient, EngineError } from "./engine-client.js";
import { queryLimiter } from "./ratelimit.js";
import type { Store, StoredRecord } from "./store/types.js";

type IdParams = { Params: { id: string } };

/** One change-detection run. The result itself stays on the engine; this record says who owns it. */
export interface Detection extends StoredRecord {
  kind: string;
  label: string;
  regionId: string;
  name: string;
  before: string;
  after: string;
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
  summary: Record<string, unknown> | null;
}

const RUNNING = new Set(["queued", "running"]);
const INSAR = "ground_deformation";
const MAX_WAITING_INSAR = 5;   // these mostly wait for NASA, so they have their own limit and do not block other analyses

export function detectionRoutes(app: FastifyInstance, store: Store, engine: EngineClient, opts: { maxConcurrentRuns: number }) {
  const auth = { preHandler: app.authenticate };

  const engineErr = (reply: FastifyReply, e: unknown) => {
    if (e instanceof EngineError) return reply.code(e.status).send(e.body ?? { error: e.message });
    throw e;
  };

  async function owned(req: FastifyRequest<IdParams>, reply: FastifyReply): Promise<Detection | undefined> {
    const d = await store.getRecord<Detection>("detection", req.params.id);
    if (!d || d.ownerId !== req.userId) {
      reply.code(404).send({ error: "analysis not found" });
      return undefined;
    }
    return d;
  }

  /** Bring the stored status up to date. An engine that has lost the job means the run is gone. */
  async function refresh(d: Detection): Promise<Detection> {
    if (!RUNNING.has(d.status)) return d;
    try {
      const j = await engine.get<any>(`/detections/${d.id}`);
      if (j.status === d.status) return d;
      return store.putRecord("detection", { ...d, status: j.status, error: j.error ?? null, summary: j.summary ?? null, updatedAt: new Date().toISOString() });
    } catch (e) {
      if (e instanceof EngineError && e.status === 404) {
        return store.putRecord("detection", { ...d, status: "failed" as const, error: "The engine no longer has this analysis.", updatedAt: new Date().toISOString() });
      }
      return d;   // engine unreachable: keep what we know
    }
  }

  app.get("/api/detections/analyses", auth, async (_req, reply) => {
    try { return await engine.get("/detections/analyses"); } catch (e) { return engineErr(reply, e); }
  });

  app.get("/api/detections", auth, async (req) => {
    const rows = await store.listRecords<Detection>("detection", req.userId!);
    return Promise.all(rows.map(refresh));
  });

  app.post<{ Body: { kind: string; regionId: string; before?: string; after?: string } }>("/api/detections", {
    ...auth,
    schema: { body: { type: "object", required: ["kind", "regionId"], properties: {
      kind: { type: "string", maxLength: 40 }, regionId: { type: "string", maxLength: 120 },
      before: { type: "string", format: "date" }, after: { type: "string", format: "date" } } } },
  }, async (req, reply) => {
    if (!queryLimiter.check(req.userId!)) return reply.code(429).send({ error: "too many requests — wait a moment" });
    // each run reads satellite imagery for minutes: cap them per user
    const mine = await Promise.all((await store.listRecords<Detection>("detection", req.userId!)).filter((d) => RUNNING.has(d.status)).map(refresh));
    const active = mine.filter((d) => RUNNING.has(d.status));
    const waiting = active.filter((d) => d.kind === INSAR).length;
    const working = active.length - waiting;
    if (req.body.kind === INSAR ? waiting >= MAX_WAITING_INSAR : working >= opts.maxConcurrentRuns) {
      const count = req.body.kind === INSAR ? waiting : working;
      return reply.code(429).send({ error: `You already have ${count} analyses of this kind in progress. Wait for one to finish before starting another.` });
    }
    let j: any;
    try {
      j = await engine.post("/detections", { kind: req.body.kind, region_id: req.body.regionId, before: req.body.before, after: req.body.after });
    } catch (e) { return engineErr(reply, e); }
    const d: Detection = {
      id: j.id, ownerId: req.userId!, createdAt: new Date().toISOString(), kind: j.kind, label: j.label, regionId: j.region_id, name: j.name,
      before: j.before, after: j.after, status: j.status, error: j.error ?? null, summary: null,
    };
    await store.putRecord("detection", d);
    await audit(store, req.userId!, req.userId!, "detection.start", `detection:${d.id}`, { kind: d.kind, regionId: d.regionId, before: d.before, after: d.after });
    return reply.code(201).send(d);
  });

  app.get<IdParams>("/api/detections/:id", auth, async (req, reply) => {
    const d = await owned(req, reply);
    if (!d) return;
    try {
      const j = await engine.get<any>(`/detections/${d.id}`);
      await refresh(d);
      return j;
    } catch (e) {
      if (e instanceof EngineError && e.status === 404) await refresh(d);
      return engineErr(reply, e);
    }
  });

  /** Map overlays are requested by <img>, so the token arrives as ?token= (see authUrl). */
  app.get<{ Params: { id: string; file: string } }>("/api/detections/:id/overlays/:file", auth, async (req, reply) => {
    const d = await owned(req as unknown as FastifyRequest<IdParams>, reply);
    if (!d) return;
    let r: Response;
    try {
      r = await engine.raw(`/detections/${d.id}/overlays/${encodeURIComponent(req.params.file)}`);
    } catch (e) {
      return reply.code(503).send({ error: `engine unreachable: ${(e as Error).message}` });
    }
    if (!r.ok) return reply.code(r.status).send({ error: "overlay not found" });
    reply.header("content-type", "image/png");
    reply.header("cache-control", "private, max-age=3600");
    return reply.send(Buffer.from(await r.arrayBuffer()));
  });

  app.delete<IdParams>("/api/detections/:id", auth, async (req, reply) => {
    const d = await owned(req, reply);
    if (!d) return;
    try {
      await engine.json(`/detections/${d.id}`, { method: "DELETE" });
    } catch (e) {
      if (!(e instanceof EngineError && e.status === 404)) return engineErr(reply, e);
    }
    await store.deleteRecord("detection", d.id);
    await audit(store, req.userId!, req.userId!, "detection.delete", `detection:${d.id}`, {});
    return { ok: true };
  });
}
