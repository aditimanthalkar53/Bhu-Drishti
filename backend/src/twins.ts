import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Detection } from "./detections.js";
import { audit } from "./delivery.js";
import { EngineClient, EngineError } from "./engine-client.js";
import type { Store, StoredRecord } from "./store/types.js";

type IdParams = { Params: { id: string } };

const ASSET_TYPES = ["bridge", "road", "building", "embankment", "dam", "other"];
const RECORD_TYPES = ["design", "inspection", "maintenance", "damage", "sensor", "note"];
const TERRAIN_TIMEOUT_MS = 300_000;

/** Something a person recorded about the asset. Satellite observations are computed, never stored here. */
export interface TwinRecord {
  id: string;
  type: string;
  date: string;
  title: string;
  notes: string;
  value: number | null;
  unit: string;
  author: string;
  createdAt: string;
}

export interface Twin extends StoredRecord {
  name: string;
  assetType: string;
  geometry: Record<string, unknown>;
  osmId: string | null;
  attributes: Record<string, string>;
  records: TwinRecord[];
}

const attributesSchema = { type: "object", maxProperties: 30, additionalProperties: { type: "string", maxLength: 300 } };

export function twinRoutes(app: FastifyInstance, store: Store, engine: EngineClient) {
  const auth = { preHandler: app.authenticate };

  const engineErr = (reply: FastifyReply, e: unknown) => {
    if (e instanceof EngineError) return reply.code(e.status).send(e.body ?? { error: e.message });
    throw e;
  };

  async function owned(req: FastifyRequest<IdParams>, reply: FastifyReply): Promise<Twin | undefined> {
    const t = await store.getRecord<Twin>("twin", req.params.id);
    if (!t || t.ownerId !== req.userId) {
      reply.code(404).send({ error: "asset not found" });
      return undefined;
    }
    return t;
  }

  const author = async (req: FastifyRequest) => (await store.userById(req.userId!))?.name ?? "Unknown";

  app.get("/api/twins", auth, async (req) => store.listRecords<Twin>("twin", req.userId!));

  app.get<{ Querystring: { lat: string; lon: string; radius?: string } }>("/api/twins/osm", auth, async (req, reply) => {
    const qs = new URLSearchParams({ lat: String(Number(req.query.lat)), lon: String(Number(req.query.lon)), radius_m: String(Number(req.query.radius ?? 500)) });
    try { return await engine.get(`/twins/osm?${qs}`); } catch (e) { return engineErr(reply, e); }
  });

  app.post<{ Body: { name: string; assetType: string; geometry: Record<string, unknown>; osmId?: string; attributes?: Record<string, string> } }>("/api/twins", {
    ...auth,
    schema: { body: { type: "object", required: ["name", "assetType", "geometry"], properties: {
      name: { type: "string", minLength: 1, maxLength: 120 }, assetType: { enum: ASSET_TYPES }, geometry: { type: "object" },
      osmId: { type: "string", maxLength: 60 }, attributes: attributesSchema } } },
  }, async (req, reply) => {
    try {
      await engine.post("/twins/observations", { geometry: req.body.geometry, detection_ids: [] });   // validates the shape and its size
    } catch (e) { return engineErr(reply, e); }
    const t: Twin = {
      id: randomUUID(), ownerId: req.userId!, createdAt: new Date().toISOString(), name: req.body.name.trim(), assetType: req.body.assetType,
      geometry: req.body.geometry, osmId: req.body.osmId ?? null, attributes: req.body.attributes ?? {}, records: [],
    };
    await store.putRecord("twin", t);
    await audit(store, req.userId!, req.userId!, "twin.create", `twin:${t.id}`, { name: t.name, assetType: t.assetType }, await author(req));
    return reply.code(201).send(t);
  });

  /** The asset with every finished analysis of this user that covered it. An unreachable engine still shows the records. */
  app.get<IdParams>("/api/twins/:id", auth, async (req, reply) => {
    const t = await owned(req, reply);
    if (!t) return;
    const ids = (await store.listRecords<Detection>("detection", req.userId!)).filter((d) => d.status === "done").map((d) => d.id);
    try {
      return { twin: t, observations: await engine.post("/twins/observations", { geometry: t.geometry, detection_ids: ids }), observationsError: null };
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
      return { twin: t, observations: [], observationsError: "Satellite observations are unavailable right now." };
    }
  });

  app.patch<IdParams & { Body: { name?: string; assetType?: string; attributes?: Record<string, string> } }>("/api/twins/:id", {
    ...auth,
    schema: { body: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 120 }, assetType: { enum: ASSET_TYPES }, attributes: attributesSchema } } },
  }, async (req, reply) => {
    const t = await owned(req, reply);
    if (!t) return;
    return store.putRecord("twin", { ...t, ...req.body, updatedAt: new Date().toISOString() });
  });

  app.delete<IdParams>("/api/twins/:id", auth, async (req, reply) => {
    const t = await owned(req, reply);
    if (!t) return;
    await store.deleteRecord("twin", t.id);
    await audit(store, req.userId!, req.userId!, "twin.delete", `twin:${t.id}`, { name: t.name }, await author(req));
    return { ok: true };
  });

  app.post<IdParams & { Body: { type: string; date: string; title: string; notes?: string; value?: number; unit?: string } }>("/api/twins/:id/records", {
    ...auth,
    schema: { body: { type: "object", required: ["type", "date", "title"], properties: {
      type: { enum: RECORD_TYPES }, date: { type: "string", format: "date" }, title: { type: "string", minLength: 1, maxLength: 200 },
      notes: { type: "string", maxLength: 4000 }, value: { type: "number" }, unit: { type: "string", maxLength: 30 } } } },
  }, async (req, reply) => {
    const t = await owned(req, reply);
    if (!t) return;
    const now = new Date().toISOString();
    const rec: TwinRecord = { id: randomUUID(), type: req.body.type, date: req.body.date, title: req.body.title.trim(), notes: req.body.notes ?? "",
      value: req.body.value ?? null, unit: req.body.unit ?? "", author: await author(req), createdAt: now };
    await store.putRecord("twin", { ...t, records: [...t.records, rec], updatedAt: now });
    await audit(store, req.userId!, req.userId!, "twin.record", `twin:${t.id}`, { type: rec.type, title: rec.title }, rec.author);
    return reply.code(201).send(rec);
  });

  app.delete<{ Params: { id: string; recordId: string } }>("/api/twins/:id/records/:recordId", auth, async (req, reply) => {
    const t = await owned(req as unknown as FastifyRequest<IdParams>, reply);
    if (!t) return;
    await store.putRecord("twin", { ...t, records: t.records.filter((r) => r.id !== req.params.recordId), updatedAt: new Date().toISOString() });
    return { ok: true };
  });

  app.post<IdParams & { Body: { detectionId?: string } }>("/api/twins/:id/terrain", auth, async (req, reply) => {
    const t = await owned(req, reply);
    if (!t) return;
    const detectionId = req.body?.detectionId;
    if (detectionId) {
      const d = await store.getRecord<Detection>("detection", detectionId);
      if (!d || d.ownerId !== req.userId) return reply.code(404).send({ error: "analysis not found" });
    }
    try {
      return await engine.json("/twins/terrain", { method: "POST", body: JSON.stringify({ geometry: t.geometry, detection_id: detectionId }) }, TERRAIN_TIMEOUT_MS);
    } catch (e) { return engineErr(reply, e); }
  });
}
