import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FastifyInstance, FastifyReply } from "fastify";
import { audit } from "./delivery.js";
import { notifyAuthorities, now, type HelpRequest, type Task } from "./disaster.js";
import { EngineError, type EngineClient } from "./engine-client.js";
import { fetchGrid, parseBbox, requestObservation, type HazardGrid } from "./hazard/index.js";
import { guard } from "./roles.js";
import type { Store, StoredRecord } from "./store/types.js";

/**
 * Maun runs: estimate the true need over an area, including need nobody reported, with an honest 95% range.
 * The run (cells, seed, every wave's allocation, the field-check results) is stored here; the engine recomputes the
 * estimate deterministically from it (POST /maun/compute), so nothing is lost when the engine restarts.
 * Each selected cell becomes a "field_check" task for volunteers. See engine/aeqe/maun/run.py for the statistics.
 */
export interface MaunCell {
  id: string; bbox: [number, number, number, number]; area_km2: number; hazard: number; population: number | null;
  reported: number; reported_recent: number; reported_earlier: number; area: string;
  /** each hazard layer on 0-1, so the model can learn its own weight (design version 2) */
  layers?: Record<string, number>;
}
type Result = { households: number } | { unreachable: true };

export interface MaunRun extends StoredRecord {
  name: string;
  bbox: [number, number, number, number];
  cellDeg: number;
  seed: number;
  conf: number;
  waveSize: number;
  cells: MaunCell[];
  waves: { alloc: number[]; cells: string[]; createdAt: string }[];
  results: Record<string, Result>;
  resultMeta: Record<string, { by: string; at: string; taskId: string | null }>;
  looks: number;
  hazardSources: HazardGrid["sources"];
  notes: string[];
  simulated: boolean;
  observationIds: string[];
  createdBy: string;
  last: Record<string, any> | null;
  history?: { n: number; looks: number; t: number; value: number; lo: number; hi: number }[];
  /** 1 = runs created before data-driven strata (replayed with their original design); 2 = current */
  designVersion?: number;
  regionId?: string | null;
}

const bus = new EventEmitter();
bus.setMaxListeners(200);
const locks = new Map<string, Promise<unknown>>();
/** Serialise read-modify-write of one run (two volunteers submitting at once must not lose a result). */
async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const p = prev.then(fn, fn);
  locks.set(id, p.catch(() => undefined));
  return p;
}

/** Same grid as engine/aeqe/hazard/grid.py (cell ids must match). */
export function makeGrid(bbox: [number, number, number, number], d: number) {
  const [w, s, e, n] = bbox;
  const cols = Math.max(1, Math.ceil((e - w) / d - 1e-9)), rows = Math.max(1, Math.ceil((n - s) / d - 1e-9));
  if (rows * cols > 2500) throw Object.assign(new Error(`${rows * cols} cells is too many (max 2500): use larger cells or a smaller area`), { statusCode: 400 });
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const out: { id: string; bbox: [number, number, number, number]; area_km2: number }[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x0 = w + c * d, y0 = s + r * d;
    const bb: [number, number, number, number] = [r6(x0), r6(y0), r6(Math.min(x0 + d, e)), r6(Math.min(y0 + d, n))];
    const km2 = Math.abs(bb[2] - bb[0]) * 111.32 * Math.cos(((bb[1] + bb[3]) / 2) * Math.PI / 180) * Math.abs(bb[3] - bb[1]) * 110.57;
    out.push({ id: `c${String(r).padStart(3, "0")}_${String(c).padStart(3, "0")}`, bbox: bb, area_km2: Math.round(km2 * 1000) / 1000 });
  }
  return out;
}

const inBox = (b: [number, number, number, number], lat: number, lng: number) => lng >= b[0] && lng < b[2] && lat >= b[1] && lat < b[3];
const center = (b: [number, number, number, number]) => ({ lat: (b[1] + b[3]) / 2, lng: (b[0] + b[2]) / 2 });

/** Requests (not cancelled) counted per cell: total, last 24 h, and 24-72 h ago (for "reports stopped" silent zones). */
export function countReports(cells: { id: string; bbox: [number, number, number, number] }[], reqs: HelpRequest[], at = Date.now()) {
  const out = new Map(cells.map((c) => [c.id, { reported: 0, reported_recent: 0, reported_earlier: 0 }]));
  for (const r of reqs) {
    if (r.status === "cancelled" || r.lat == null || r.lng == null) continue;
    const c = cells.find((x) => inBox(x.bbox, r.lat!, r.lng!));
    if (!c) continue;
    const o = out.get(c.id)!, age = at - Date.parse(r.createdAt);
    o.reported++;
    if (age <= 24 * 3600_000) o.reported_recent++;
    else if (age <= 72 * 3600_000) o.reported_earlier++;
  }
  return out;
}

function specOf(run: MaunRun, newWave = 0) {
  return { cells: run.cells, seed: run.seed, conf: run.conf, waves: run.waves.map((w) => ({ alloc: w.alloc })), results: run.results, looks: Math.max(1, run.looks),
    new_wave: newWave, design_version: run.designVersion ?? 1 };
}

type Geo = { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] };

/** Ray casting on the outer ring minus holes. */
function inRing(ring: number[][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function inGeometry(g: Geo, lng: number, lat: number): boolean {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some((p) => inRing(p[0], lng, lat) && !p.slice(1).some((hole) => inRing(hole, lng, lat)));
}

/**
 * Cells of a run with their covariates, all from data: the hazard layers (each layer separately, plus the combined
 * score), people per cell from the HRSL 30 m raster, and the requests already reported. A district limits the cells
 * to those whose centre lies inside its boundary.
 */
export async function buildCells(store: Store, engine: EngineClient, o: { bbox?: string | number[]; regionId?: string; cellDeg?: number; useHazard: boolean }) {
  let bbox: [number, number, number, number] | null = null;
  let geometry: Geo | null = null;
  let regionName: string | null = null;
  if (o.regionId) {
    const r = await engine.get<{ name: string; bbox: number[]; geometry?: Geo }>(`/regions/${encodeURIComponent(o.regionId)}`);
    bbox = r.bbox as [number, number, number, number];
    geometry = r.geometry ?? null;
    regionName = r.name;
    if (bbox[2] - bbox[0] > 4 || bbox[3] - bbox[1] > 4) throw Object.assign(new Error("this region is larger than 4° across; draw a smaller area"), { statusCode: 400 });
  } else {
    bbox = parseBbox(Array.isArray(o.bbox) ? o.bbox.join(",") : o.bbox);
    if (!bbox) throw Object.assign(new Error("choose a district, or give bbox=west,south,east,north (at most 2° on a side)"), { statusCode: 400 });
  }
  // cell size: as asked, but large enough that the area has at most 1500 cells
  const span = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
  const cellDeg = Math.max(o.cellDeg ?? 0.025, Math.ceil(Math.sqrt(span / 1500) * 1000) / 1000);
  const notes: string[] = [];
  if (regionName) notes.push(`Area: ${regionName} (cells whose centre lies inside the district boundary).`);
  if (cellDeg !== (o.cellDeg ?? 0.025)) notes.push(`Cell size raised to ${cellDeg}° so the area has at most 1500 cells.`);

  let base = makeGrid(bbox, cellDeg);
  if (geometry) base = base.filter((c) => { const m = center(c.bbox); return inGeometry(geometry!, m.lng, m.lat); });
  if (base.length < 12) throw Object.assign(new Error("the area must contain at least 12 cells: use smaller cells"), { statusCode: 400 });

  let grid: HazardGrid | null = null;
  if (o.useHazard) {
    try { grid = await fetchGrid(engine, bbox, 3, cellDeg); } catch (e) { notes.push(`Hazard layer unavailable (${(e as Error).message}); the model learns from reports and people only.`); }
  }
  const hz = new Map((grid?.cells ?? []).map((c) => [c.cell_id, c]));
  let pop: Record<string, number> = {};
  try {
    const p = await engine.json<{ population: Record<string, number>; missing: string[]; source: string; errors: string[] }>("/maun/population",
      { method: "POST", body: JSON.stringify({ cells: base.map((c) => ({ id: c.id, bbox: c.bbox })) }) }, 600_000);
    pop = p.population;
    notes.push(`Population: ${p.source}${p.missing.length ? `; ${p.missing.length} cell(s) could not be read and use a flat 400 people/km² fallback` : " for every cell"}.`);
  } catch (e) {
    notes.push(`Population raster unavailable (${(e as Error).message}); every cell uses a flat 400 people/km² fallback.`);
  }
  const counts = countReports(base, await store.listRecords<HelpRequest>("request"));
  const midLat = (bbox[1] + bbox[3]) / 2, midLng = (bbox[0] + bbox[2]) / 2;
  const cells: MaunCell[] = base.map((c) => {
    const ctr = center(c.bbox);
    const h = hz.get(c.id);
    const layers: Record<string, number> = {};
    for (const [k, l] of Object.entries(h?.layers ?? {})) if (l.norm != null) layers[k] = l.norm;
    return { ...c, hazard: h?.hazard_score ?? 0, layers, population: pop[c.id] ?? null, ...counts.get(c.id)!,
      area: `${ctr.lat >= midLat ? "North" : "South"}-${ctr.lng >= midLng ? "east" : "west"}` };
  });
  notes.push("Reported need counts each request, SOS or Drain Watch report in a cell as one household.");
  notes.push("How need relates to each hazard layer, people and reports is learned from the field checks, not assumed.");
  return { bbox, cellDeg, cells, notes, sources: grid?.sources ?? [] };
}

const summary = (run: MaunRun) => {
  const { cells: _c, results: _r, resultMeta: _m, ...rest } = run;
  return { ...rest, cellCount: run.cells.length, last: run.last ? { status: run.last.status, overall: run.last.overall, checks_done: run.last.checks_done,
    pending: run.last.pending?.length ?? 0, unreachable: run.last.unreachable?.length ?? 0, silent: run.last.silent_zones?.length ?? 0 } : null };
};

export async function computeAndStore(store: Store, engine: EngineClient, run: MaunRun, newWave = 0): Promise<MaunRun> {
  const out = await engine.post<Record<string, any>>("/maun/compute", specOf(run, newWave));
  if (newWave && out.new_wave) run.waves.push({ alloc: out.new_wave.alloc, cells: out.new_wave.cells, createdAt: now() });
  const { cells: _cells, trace: _t, ...rest } = out;
  run.last = { ...rest, cells: out.cells, computedAt: now() };
  // one point per look, for the convergence chart
  const o = out.overall;
  if (o && !(run.history ?? []).some((h) => h.n === out.checks_done && h.looks === run.looks)) {
    run.history = [...(run.history ?? []), { n: out.checks_done, looks: run.looks, t: Date.now(), value: o.estimate, lo: o.lo, hi: o.hi }];
  }
  run.updatedAt = now();
  await store.putRecord("maun_run", run);
  bus.emit(run.id, { type: "estimate", status: out.status, overall: out.overall, checks_done: out.checks_done, pending: out.pending.length });
  return run;
}

// ---------------------------------------------------------------------------- human names for areas

export interface PlaceName { label: string; place: string; km: number; direction: string | null }
const placeCache = new Map<string, PlaceName | null>();
const pkey = (lat: number, lon: number) => `${lat.toFixed(4)},${lon.toFixed(4)}`;

/** "Ganak Kuchi Gaon" or "4 km south-west of Budrutop" for each point (engine: GeoNames gazetteer). Never throws: points it
 *  cannot name are simply missing from the answer, and callers keep the grid code. */
export async function placeNames(engine: EngineClient, points: { id: string; lat: number; lon: number }[]): Promise<Record<string, PlaceName>> {
  const out: Record<string, PlaceName> = {};
  const todo = points.filter((p) => {
    const hit = placeCache.get(pkey(p.lat, p.lon));
    if (hit) out[p.id] = hit;
    return hit === undefined;
  });
  if (todo.length) {
    try {
      // the first call may download the GeoNames list (15 MB) into the engine's data folder
      const r = await engine.json<{ names: Record<string, PlaceName> }>("/places/names",
        { method: "POST", body: JSON.stringify({ points: todo.map((p) => ({ id: p.id, lat: p.lat, lon: p.lon })) }) }, 400_000);
      for (const p of todo) {
        const n = r.names[p.id] ?? null;
        placeCache.set(pkey(p.lat, p.lon), n);
        if (n) out[p.id] = n;
      }
    } catch { /* engine unavailable: no names this time */ }
  }
  return out;
}

export const areaTaskTitle = (place: PlaceName | undefined, cellId: string, quadrant: string) =>
  place ? `Area check: ${place.label}` : `Field check: cell ${cellId} (${quadrant})`;

/** Name the area-check tasks that do not have a place name yet (tasks created before names existed). */
export async function nameAreaTasks(store: Store, engine: EngineClient, tasks: Task[]): Promise<Task[]> {
  const unnamed = tasks.filter((t) => t.type === "field_check" && !t.placeName && t.lat != null && t.lng != null);
  if (!unnamed.length) return tasks;
  const names = await placeNames(engine, unnamed.map((t) => ({ id: t.id, lat: t.lat!, lon: t.lng! })));
  const updated = new Map<string, Task>();
  for (const t of unnamed) {
    const n = names[t.id];
    if (!n) continue;
    const next: Task = { ...t, placeName: n.label, title: `Area check: ${n.label}` };
    await store.putRecord("task", next);
    updated.set(t.id, next);
  }
  return tasks.map((t) => updated.get(t.id) ?? t);
}

export async function createTasks(store: Store, run: MaunRun, cellIds: string[], by: string, engine?: EngineClient) {
  const byId = new Map(run.cells.map((c) => [c.id, c]));
  const names = engine ? await placeNames(engine, cellIds.map((id) => { const m = center(byId.get(id)!.bbox); return { id, lat: m.lat, lon: m.lng }; })) : {};
  for (const id of cellIds) {
    const c = byId.get(id)!;
    const ctr = center(c.bbox);
    const t: Task = { id: `task-${randomUUID()}`, ownerId: by, createdAt: now(), title: areaTaskTitle(names[id], id, c.area), type: "field_check",
      placeName: names[id]?.label ?? null,
      description: `Visit this ~${c.area_km2.toFixed(1)} km² cell and count households that need rescue, food or water, shelter or medical help. ` +
        `This cell was chosen at random: please do not swap it for an easier one. If you cannot reach it, mark it unreachable.`,
      requestId: null, offerId: null, runId: run.id, cellId: id, lat: ctr.lat, lng: ctr.lng, status: "open", claimedBy: null, claimedByName: null,
      claimedAt: null, completedAt: null, note: null, result: null, createdBy: by };
    await store.putRecord("task", t);
  }
}

/** Record one field-check result (from a completed task or the results route). Rejects cells that were not selected. */
export async function recordFieldCheck(store: Store, engine: EngineClient, task: Pick<Task, "id" | "runId" | "cellId" | "claimedBy">,
  result: { households: number; detail?: Record<string, unknown> } | { unreachable: true }, by?: string): Promise<MaunRun> {
  if (!task.runId || !task.cellId) throw Object.assign(new Error("this task is not part of a Maun run"), { statusCode: 400 });
  return withLock(task.runId, async () => {
    const run = await store.getRecord<MaunRun>("maun_run", task.runId!);
    if (!run) throw Object.assign(new Error("run not found"), { statusCode: 404 });
    if (!run.waves.some((w) => w.cells.includes(task.cellId!))) throw Object.assign(new Error("this cell was not selected; checks elsewhere would break the random sample"), { statusCode: 409 });
    if (run.results[task.cellId!]) throw Object.assign(new Error("a result for this cell is already recorded"), { statusCode: 409 });
    run.results[task.cellId!] = "unreachable" in result ? { unreachable: true } : { households: Math.max(0, Math.round(result.households)) };
    run.resultMeta[task.cellId!] = { by: by ?? task.claimedBy ?? "unknown", at: now(), taskId: task.id };
    run.looks = (run.looks ?? 0) + 1;
    try {
      await computeAndStore(store, engine, run);
    } catch (e) {
      await store.putRecord("maun_run", run);   // keep the result even if the engine is down; it is recomputed later
      if (!(e instanceof EngineError)) throw e;
    }
    // a wave is complete and the range is widest somewhere: ask for sharper observation there (SIMULATED adapter)
    const last = run.last;
    if (last && last.pending?.length === 0 && last.observation_suggestion?.cells?.length) {
      const o = await requestObservation(store, last.observation_suggestion.cells, "high",
        `Maun run "${run.name}": stratum ${last.observation_suggestion.stratum}, ${last.observation_suggestion.reason}`, run.id, run.createdBy);
      run.observationIds = [...(run.observationIds ?? []), o.id];
      await store.putRecord("maun_run", run);
    }
    return run;
  });
}

export function maunRoutes(app: FastifyInstance, store: Store, engine: EngineClient) {
  const authority = guard(app, "authority");
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof EngineError) return reply.code(e.status).send(e.body ?? { error: e.message });
    const code = (e as { statusCode?: number }).statusCode;
    if (code) return reply.code(code).send({ error: (e as Error).message });
    throw e;
  };

  app.post<{ Body: { name: string; bbox?: string | number[]; regionId?: string; cellDeg?: number; waveSize?: number; useHazard?: boolean; seed?: number } }>("/api/maun/runs", {
    ...authority,
    schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 2, maxLength: 120 },
      bbox: { anyOf: [{ type: "string" }, { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 }] }, regionId: { type: "string", maxLength: 120 },
      cellDeg: { type: "number", minimum: 0.005, maximum: 0.2 }, waveSize: { type: "integer", minimum: 1, maximum: 200 }, useHazard: { type: "boolean" }, seed: { type: "integer" } } } },
  }, async (req, reply) => {
    let built;
    try {
      built = await buildCells(store, engine, { bbox: req.body.bbox, regionId: req.body.regionId, cellDeg: req.body.cellDeg, useHazard: req.body.useHazard !== false });
    } catch (e) {
      return fail(reply, e);
    }
    const { bbox, cellDeg, cells, notes, sources } = built;
    const run: MaunRun = { id: `maun-${randomUUID()}`, ownerId: req.userId!, createdAt: now(), name: req.body.name.trim(), bbox, cellDeg,
      seed: req.body.seed ?? Math.floor(Math.random() * 1e9), conf: 0.95, waveSize: req.body.waveSize ?? 30, cells, waves: [], results: {}, resultMeta: {},
      looks: 0, hazardSources: sources, notes, simulated: false, observationIds: [], createdBy: req.userId!, last: null, designVersion: 2,
      regionId: req.body.regionId ?? null };
    try {
      await computeAndStore(store, engine, run, run.waveSize);
    } catch (e) {
      return fail(reply, e);
    }
    await createTasks(store, run, run.waves.at(-1)?.cells ?? [], req.userId!, engine);
    await audit(store, req.userId!, req.userId!, "maun.run.create", `maun_run:${run.id}`, { cells: cells.length, wave: run.waves.at(-1)?.cells.length });
    return reply.code(201).send(summary(run));
  });

  app.get("/api/maun/runs", authority, async () =>
    (await store.listRecords<MaunRun>("maun_run")).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summary));

  app.get<{ Params: { id: string } }>("/api/maun/runs/:id", authority, async (req, reply) => {
    let run = await store.getRecord<MaunRun>("maun_run", req.params.id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    try { run = await computeAndStore(store, engine, run); } catch { /* engine down: show the last stored estimate */ }
    const trace = await engine.post<Record<string, any>>("/maun/compute", specOf(run)).then((o) => o.trace).catch(() => null);
    const names = await placeNames(engine, run.cells.map((c) => { const m = center(c.bbox); return { id: c.id, lat: m.lat, lon: m.lng }; }));
    const places = Object.fromEntries(Object.entries(names).map(([k, v]) => [k, v.label]));
    return { ...summary(run), cells: run.cells, results: run.results, resultMeta: run.resultMeta, last: run.last, trace, places };
  });

  app.post<{ Params: { id: string }; Body: { size?: number } | null }>("/api/maun/runs/:id/waves", authority, async (req, reply) => {
    try {
      const run = await withLock(req.params.id, async () => {
        const r = await store.getRecord<MaunRun>("maun_run", req.params.id);
        if (!r) throw Object.assign(new Error("run not found"), { statusCode: 404 });
        await computeAndStore(store, engine, r, Math.max(1, Math.min(200, req.body?.size ?? r.waveSize)));
        await createTasks(store, r, r.waves.at(-1)!.cells, req.userId!, engine);
        return r;
      });
      await audit(store, req.userId!, req.userId!, "maun.wave", `maun_run:${run.id}`, { cells: run.waves.at(-1)!.cells.length });
      return summary(run);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** Enter a field-check result directly (authority, or the volunteer who claimed that cell's task). */
  app.post<{ Params: { id: string }; Body: { cellId: string; households?: number; unreachable?: boolean } }>("/api/maun/runs/:id/results", {
    ...guard(app, "volunteer", "authority"),
    schema: { body: { type: "object", required: ["cellId"], properties: { cellId: { type: "string" }, households: { type: "number", minimum: 0, maximum: 100000 }, unreachable: { type: "boolean" } } } },
  }, async (req, reply) => {
    const { cellId, households, unreachable } = req.body;
    if (!unreachable && households === undefined) return reply.code(400).send({ error: "give households (0 if none) or unreachable: true" });
    const task = (await store.listRecords<Task>("task")).find((t) => t.runId === req.params.id && t.cellId === cellId && t.type === "field_check");
    if (req.role !== "authority" && task?.claimedBy !== req.userId) return reply.code(403).send({ error: "claim this cell's field-check task first" });
    try {
      const run = await recordFieldCheck(store, engine, { id: task?.id ?? "direct", runId: req.params.id, cellId, claimedBy: req.userId! },
        unreachable ? { unreachable: true } : { households: households! }, req.userId!);
      if (task && (task.status === "open" || task.status === "claimed")) {
        await store.putRecord("task", { ...task, status: unreachable ? "unreachable" : "done", completedAt: now(), result: unreachable ? null : { households },
          claimedBy: task.claimedBy ?? req.userId!, updatedAt: now() });
      }
      if (unreachable) await notifyAuthorities(store, app.roles, "Field check: cell unreachable", `${cellId} in run "${run.name}". It stays in the sample and is a priority.`, "warning", "/app/estimates");
      return summary(run);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>("/api/maun/runs/:id/events", authority, async (req, reply) => {
    const run = await store.getRecord<MaunRun>("maun_run", req.params.id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: "hello", status: run.last?.status, overall: run.last?.overall ?? null, checks_done: run.last?.checks_done ?? 0 });
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
    bus.on(run.id, send);
    req.raw.on("close", () => { clearInterval(ping); bus.off(run.id, send); });
  });

  app.get<{ Querystring: { runId?: string } }>("/api/maun/silent-zones", authority, async (req) => {
    const runs = (await store.listRecords<MaunRun>("maun_run")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const run = req.query.runId ? runs.find((r) => r.id === req.query.runId) : runs[0];
    if (!run) return { run: null, zones: [] };
    const zones = (run.last?.silent_zones ?? []) as { id: string; bbox: [number, number, number, number] | null }[];
    const names = await placeNames(engine, zones.filter((z) => z.bbox).map((z) => { const m = center(z.bbox!); return { id: z.id, lat: m.lat, lon: m.lng }; }));
    return { run: { id: run.id, name: run.name, simulated: run.simulated }, zones: zones.map((z) => ({ ...z, place: names[z.id]?.label ?? null })) };
  });
}
