import { useEffect, useRef, useState } from "react";
import { api, authUrl, post } from "../api";
import type { QueryIR } from "../types";

export interface MapOverlay { url: string; bounds: [[number, number], [number, number]]; label: string }

interface Job {
  id: string; status: string; error: string | null; kind: string; region_id: string; before: string; after: string;
  steps: { key: string; label: string; status: string; detail: string }[];
  record: { bbox: { west: number; south: number; east: number; north: number }; overlays: { id: string; label: string; date: string | null }[]; area_km2: number; noun: string; detected: boolean } | null;
}
interface Row { id: string; kind: string; regionId: string; before: string; after: string; status: string }

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const shift = (d: string, days: number) => iso(Date.parse(d) + days * DAY);

/** The satellite comparison that matches what the question measures: two dates, picture first. */
export function plan(ir: QueryIR): { kind: string; before: string; after: string; what: string } {
  const after = ir.end;
  if (ir.target === "flooded_cropland") {
    // radar floods are measured against dry ground: the dry season (Feb to Apr) before the event
    const year = new Date(ir.start).getUTCMonth() >= 5 ? new Date(ir.start).getUTCFullYear() : new Date(ir.start).getUTCFullYear() - 1;
    return { kind: "sar_flood", before: ir.baseline_start ?? `${year}-03-15`, after, what: "Radar before and after, with the flooded land marked" };
  }
  if (ir.target === "new_builtup") return { kind: "vegetation_change", before: ir.baseline_start ?? shift(ir.start, -365), after, what: "Sentinel-2 before and after, with land that lost its green cover marked" };
  return { kind: "vegetation_change", before: shift(ir.start, -30), after, what: "Sentinel-2 before and after, with land that lost its green cover marked" };
}

const LAYERS = [{ id: "before", label: "Before" }, { id: "after", label: "After" }, { id: "change", label: "Change" }];
const day = (s: string) => new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export function ChangeImages({ ir, simulated, onMap }: { ir: QueryIR; simulated: boolean; onMap(o: MapOverlay | null): void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layer, setLayer] = useState("change");
  const [onMapNow, setOnMapNow] = useState(true);
  const mapRef = useRef(onMap);
  mapRef.current = onMap;
  const p = plan(ir);
  const key = `${ir.region_id}|${p.kind}|${p.before}|${p.after}`;

  useEffect(() => {
    if (simulated) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setJob(null);
    setError(null);
    const poll = async (id: string) => {
      try {
        const j = await api<Job>(`/api/detections/${id}`);
        if (!alive) return;
        setJob(j);
        if (j.status === "queued" || j.status === "running") timer = setTimeout(() => void poll(id), 2500);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    (async () => {
      try {
        // reuse the same comparison when the answer is reopened, instead of reading the satellites again
        const rows = await api<Row[]>("/api/detections");
        const same = rows.find((r) => r.regionId === ir.region_id && r.kind === p.kind && r.before === p.before && r.after === p.after && r.status !== "failed");
        const id = same?.id ?? (await post<Row>("/api/detections", { kind: p.kind, regionId: ir.region_id, before: p.before, after: p.after })).id;
        if (alive) await poll(id);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; clearTimeout(timer); mapRef.current(null); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, simulated]);

  const rec = job?.record;
  useEffect(() => {
    if (!rec || !job || !onMapNow) { onMap(null); return; }
    const o = rec.overlays.find((x) => x.id === layer) ?? rec.overlays[0];
    onMap({ url: authUrl(`/api/detections/${job.id}/overlays/${o.id}.png`), bounds: [[rec.bbox.south, rec.bbox.west], [rec.bbox.north, rec.bbox.east]], label: o.label });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec, job?.id, layer, onMapNow]);

  if (simulated) {
    return <section className="det-block change-images"><h3>Satellite change</h3><p className="small muted">This is a simulated demo district, so there are no satellite images. Pick a real district to see them.</p></section>;
  }
  const running = !job || job.status === "queued" || job.status === "running";
  const step = job?.steps.find((s) => s.status === "running");
  return (
    <section className="det-block change-images" aria-label="Satellite change images">
      <h3>Satellite change, {day(p.before)} to {day(p.after)}</h3>
      {running && !error && (
        <div className="change-wait" role="status">
          <span className="pulse" aria-hidden="true" />
          <span>Preparing the satellite images{step ? `: ${step.label.toLowerCase()}` : ""}. This takes a few minutes and runs alongside the tile analysis.</span>
        </div>
      )}
      {error && <p className="notice notice-error" role="alert">Satellite images could not be started: {error}</p>}
      {job?.status === "failed" && <p className="notice notice-error" role="alert">No satellite images for these dates: {job.error}</p>}
      {rec && job && (
        <>
          <div className="legend-toggles" role="group" aria-label="Image">
            {LAYERS.filter((l) => rec.overlays.some((o) => o.id === l.id)).map((l) => (
              <button key={l.id} className="chip" aria-pressed={layer === l.id} onClick={() => setLayer(l.id)}>{l.label}</button>
            ))}
            <button className="chip" aria-pressed={onMapNow} onClick={() => setOnMapNow((v) => !v)}>Show on map</button>
          </div>
          <div className="change-frame">
            {layer === "change" && <img src={authUrl(`/api/detections/${job.id}/overlays/after.png`)} alt="" aria-hidden="true" className="change-base" />}
            <img src={authUrl(`/api/detections/${job.id}/overlays/${layer}.png`)} alt={`${rec.overlays.find((o) => o.id === layer)?.label ?? layer}, ${day(p.before)} to ${day(p.after)}`} className={layer === "change" ? "change-top" : "change-base"} />
          </div>
          <p className="muted small">{p.what}. {rec.detected ? `About ${rec.area_km2.toFixed(2)} km² of ${rec.noun} found.` : `No ${rec.noun} found.`} Brown means a decrease, teal an increase; faint changes are left out.</p>
        </>
      )}
    </section>
  );
}
