import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { audit } from "../delivery.js";
import { now } from "../disaster.js";
import { EngineError, type EngineClient } from "../engine-client.js";
import { guard } from "../roles.js";
import type { Store, StoredRecord } from "../store/types.js";

/**
 * The hazard layer ("virtual constellation"): we do not analyse imagery ourselves any more; the engine's hazard
 * adapters (engine/aeqe/hazard/) read several independent sources (NASA FIRMS fires, GPM IMERG rainfall, MODIS NRT
 * flood, Open-Meteo rainfall forecast and GloFAS river discharge), each with its own observation time, and combine
 * them per grid cell into a documented hazard_score. This file relays that grid and keeps the latest one so other
 * features (request confidence, Maun cells) can look up the hazard at a point.
 *
 * Dedicated constellation: an ObservationRequest asks for sharper imagery over chosen cells. Real satellite tasking is
 * not available to us, so the only adapter shipped is SIMULATED and says so in every response.
 */
export interface HazardCell {
  cell_id: string;
  bbox: [number, number, number, number];
  hazard_score: number;
  layers: Record<string, { value: number | null; norm: number | null; unit: string; observed_at: string | null }>;
}
export interface HazardGrid {
  bbox: [number, number, number, number];
  cell_deg: number;
  cells: HazardCell[];
  sources: { id: string; name: string; state: string; observed_at: string | null; age_s: number | null; latency_s: number | null; note: string; area_level?: boolean }[];
  score_doc: string;
  generated_at: string;
}

let last: HazardGrid | null = null;
export const setLastGrid = (g: HazardGrid | null) => { last = g; };

/** Combined hazard score (0..1) of the cell containing the point, from the most recently loaded grid. */
export function hazardAt(lat: number, lng: number): number | null {
  if (!last) return null;
  const c = last.cells.find((x) => lng >= x.bbox[0] && lng < x.bbox[2] && lat >= x.bbox[1] && lat < x.bbox[3]);
  return c ? c.hazard_score : null;
}

export function parseBbox(s: string | undefined): [number, number, number, number] | null {
  const v = (s ?? "").split(",").map(Number);
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) return null;
  const [w, so, e, n] = v;
  if (w >= e || so >= n || e - w > 2 || n - so > 2 || Math.abs(so) > 90 || Math.abs(n) > 90) return null;
  return [w, so, e, n];
}

export async function fetchGrid(engine: EngineClient, bbox: [number, number, number, number], days = 3, cellDeg = 0.05): Promise<HazardGrid> {
  const g = await engine.json<HazardGrid>("/hazard/grid", { method: "POST", body: JSON.stringify({ bbox, days, cell_deg: cellDeg }) }, 240_000);
  setLastGrid(g);
  return g;
}

// ---------------------------------------------------------------------------- observation requests

export interface ObservationRequest extends StoredRecord {
  cellIds: string[];
  priority: "normal" | "high";
  reason: string;
  runId: string | null;
  adapter: string;
  simulated: boolean;
  status: "requested" | "delivered" | "failed";
  etaAt: string | null;
  result: { cell_id: string; sharper_score: number; resolution_m: number }[] | null;
  note: string;
}

export interface ObservationAdapter {
  id: string;
  simulated: boolean;
  /** Ask for an observation; returns when it should be ready. */
  request(cellIds: string[], priority: "normal" | "high"): { etaAt: string; note: string };
  /** Current state of an earlier request. */
  poll(o: ObservationRequest, hazardOf: (cellId: string) => number | null): Pick<ObservationRequest, "status" | "result">;
}

/**
 * SIMULATED tasking: "delivers" after OBS_SIM_DELAY_S seconds (default 30; high priority in half the time) a sharper
 * proxy per cell: the cell's hazard score nudged by a fixed pseudo-random amount. It shows the workflow only; it is
 * not an observation of anything. A real provider implements ObservationAdapter and replaces this in pickAdapter().
 */
export class SimulatedObservationAdapter implements ObservationAdapter {
  id = "simulated";
  simulated = true;
  constructor(private delayS = Number(process.env.OBS_SIM_DELAY_S ?? 30)) {}
  request(_cells: string[], priority: "normal" | "high") {
    const s = priority === "high" ? this.delayS / 2 : this.delayS;
    return { etaAt: new Date(Date.now() + s * 1000).toISOString(), note: "SIMULATED: no satellite is tasked. This adapter returns a synthetic sharper proxy." };
  }
  poll(o: ObservationRequest, hazardOf: (cellId: string) => number | null) {
    if (o.status !== "requested" || !o.etaAt || Date.parse(o.etaAt) > Date.now()) return { status: o.status, result: o.result };
    const result = o.cellIds.map((cell_id) => {
      const h = hazardOf(cell_id) ?? 0.3;
      const jitter = (parseInt(createHash("sha256").update(`${o.id}:${cell_id}`).digest("hex").slice(0, 6), 16) / 0xffffff - 0.5) * 0.3;
      return { cell_id, sharper_score: Math.round(Math.max(0, Math.min(1, h + jitter)) * 1000) / 1000, resolution_m: 10 };
    });
    return { status: "delivered" as const, result };
  }
}

const pickAdapter = (): ObservationAdapter => new SimulatedObservationAdapter();

export function hazardRoutes(app: FastifyInstance, store: Store, engine: EngineClient) {
  const adapter = pickAdapter();

  app.get<{ Querystring: { bbox?: string; days?: string; cell?: string } }>("/api/hazard", guard(app), async (req, reply) => {
    const bbox = parseBbox(req.query.bbox);
    if (!bbox) return reply.code(400).send({ error: "bbox=west,south,east,north is required (at most 2 degrees on a side)" });
    const days = Math.min(7, Math.max(1, Number(req.query.days ?? 3) || 3));
    const cell = Math.min(0.2, Math.max(0.01, Number(req.query.cell ?? 0.05) || 0.05));
    try {
      return await fetchGrid(engine, bbox, days, cell);
    } catch (e) {
      if (e instanceof EngineError) return reply.code(e.status).send(e.body ?? { error: e.message });
      throw e;
    }
  });

  app.get("/api/hazard/latest", guard(app), async () => last ?? { cells: [], sources: [], bbox: null });

  const cellHazard = (id: string) => last?.cells.find((c) => c.cell_id === id)?.hazard_score ?? null;
  const refresh = async (o: ObservationRequest) => {
    const p = adapter.poll(o, cellHazard);
    if (p.status !== o.status) {
      const next = { ...o, ...p, updatedAt: now() };
      await store.putRecord("observation", next);
      return next;
    }
    return o;
  };

  app.post<{ Body: { cellIds: string[]; priority?: "normal" | "high"; reason?: string; runId?: string } }>("/api/observations", {
    ...guard(app, "authority"),
    schema: { body: { type: "object", required: ["cellIds"], properties: { cellIds: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", maxLength: 40 } },
      priority: { type: "string", enum: ["normal", "high"] }, reason: { type: "string", maxLength: 300 }, runId: { type: "string" } } } },
  }, async (req, reply) => {
    const o = await requestObservation(store, req.body.cellIds, req.body.priority ?? "normal", req.body.reason ?? "requested by an authority", req.body.runId ?? null, req.userId!);
    return reply.code(201).send(o);
  });

  app.get("/api/observations", guard(app, "authority"), async () => {
    const out = [];
    for (const o of await store.listRecords<ObservationRequest>("observation")) out.push(await refresh(o));
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export async function requestObservation(store: Store, cellIds: string[], priority: "normal" | "high", reason: string, runId: string | null, by: string) {
  const adapter = pickAdapter();
  const r = adapter.request(cellIds, priority);
  const o: ObservationRequest = { id: `obs-${randomUUID()}`, ownerId: by, createdAt: now(), cellIds, priority, reason, runId, adapter: adapter.id,
    simulated: adapter.simulated, status: "requested", etaAt: r.etaAt, result: null, note: r.note };
  await store.putRecord("observation", o);
  await audit(store, by, by, "observation.request", `observation:${o.id}`, { cells: cellIds.length, priority, simulated: adapter.simulated });
  return o;
}
