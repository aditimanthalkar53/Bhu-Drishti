import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, GeoJSON, ImageOverlay, MapContainer, Tooltip, useMap } from "react-leaflet";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, authUrl, del, post } from "../api";
import { BaseLayers } from "../components/BaseLayers";
import { RegionPicker } from "../components/RegionPicker";
import { ago, fmt, fmtDate, fmtInt } from "../format";
import { cssVar, useTheme } from "../theme";
import type { Region } from "../types";
import { Empty, ErrorNote, Page, Pill, useData } from "./common";

type Tone = "ok" | "warn" | "error" | "info" | "muted";

interface Model { id: string; name: string; method: string; limitations: string[]; parameters: Record<string, unknown>; evaluation: { status: string; note?: string } }
interface Analysis { kind: string; label: string; sensor: string; noun: string; exposure: boolean; default_before: string; default_after: string; model: Model }
interface Catalog { analyses: Analysis[]; max_span_deg: number; insar_configured: boolean }
interface Step { key: string; label: string; status: string; detail: string }
interface Row { id: string; label: string; name: string; before: string; after: string; status: string; error: string | null; createdAt: string; summary: { detected: boolean; area_km2: number; noun: string; risk: string; confidence: string } | null }
interface RiskPart { name: string; label: string; basis: string; status: string }
interface DetectionRecord {
  id: string; kind: string; name: string; label: string; noun: string; sensor: string; bbox: { west: number; south: number; east: number; north: number };
  before: any; after: any; model: Model; grid: { res_m: number; width: number; height: number }; detected: boolean; confidence: string;
  confidence_reasons: string[]; quality_flags: string[]; valid_fraction: number; area_km2: number; area_low_km2: number; area_high_km2: number; aoi_km2: number;
  metrics: Record<string, unknown>; geometry: GeoJSON.FeatureCollection & { patch_count: number; truncated: boolean }; overlays: { id: string; label: string; date: string | null; file: string }[];
  deformation?: { max_toward_mm: number | null; max_away_mm: number | null; median_abs_mm: number | null; vertical_if_purely_vertical_mm: number | null; threshold_mm: number; noise_mm: number; reference: string; coherent_share: number; baseline_days: number; note: string };
  forest: any; population: { value: number; low: number; high: number; notes: string[] } | null; population_error: string | null; exposure_applicable: boolean;
  assets_in_extent: { status: string; reason?: string; total: number; counts: Record<string, number>; truncated?: boolean; geojson: GeoJSON.FeatureCollection } | null;
  risk: { level: string; explanation: string; components: RiskPart[]; range: { low: string; high: string } | null }; processing: { seconds: number };
}
interface Job { id: string; label: string; name: string; before: string; after: string; status: string; error: string | null; steps: Step[]; record: DetectionRecord | null }

const STEP_TONE: Record<string, Tone> = { ok: "ok", running: "info", partial: "warn", unavailable: "warn", skipped: "muted", not_run: "muted", pending: "muted" };
const STATUS_TONE: Record<string, Tone> = { done: "ok", running: "info", queued: "info", failed: "error" };
const RISK_TONE: Record<string, Tone> = { low: "ok", medium: "info", high: "warn", critical: "error" };
const CONF_TONE: Record<string, Tone> = { high: "ok", probable: "info", detected: "info", uncertain: "warn", not_detected: "muted" };
const LAYER_NAME: Record<string, string> = { change: "Change", before: "Before", after: "After", coherence: "Coherence" };
const CONF_TEXT: Record<string, string> = { high: "High confidence", probable: "Probable", detected: "Detected", uncertain: "Uncertain", not_detected: "Nothing detected" };
const words = (s: string) => s.replace(/_/g, " ");
const day = (iso?: string) => (iso ? fmtDate(iso, false) : "–");

export function DetectionsPage() {
  const [params, setParams] = useSearchParams();
  const catalog = useData<Catalog>("/api/detections/analyses");
  const regions = useData<Region[]>("/api/regions");
  const rows = useData<Row[]>("/api/detections");
  const openId = params.get("open");

  const [kind, setKind] = useState("sar_flood");
  const [regionId, setRegionId] = useState(params.get("region") ?? "");
  const [before, setBefore] = useState("");
  const [after, setAfter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analysis = catalog.data?.analyses.find((a) => a.kind === kind);
  const live = useMemo(() => (regions.data ?? []).filter((r) => !r.simulated), [regions.data]);
  const region = live.find((r) => r.id === regionId);
  const maxSpan = catalog.data?.max_span_deg ?? 1.5;
  const tooLarge = !!region && (region.bbox[2] - region.bbox[0] > maxSpan || region.bbox[3] - region.bbox[1] > maxSpan);

  useEffect(() => {
    if (analysis) { setBefore(analysis.default_before); setAfter(analysis.default_after); }
  }, [analysis]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await post<Row>("/api/detections", { kind, regionId, before: before || undefined, after: after || undefined });
      await rows.reload();
      setParams((p) => { p.set("open", d.id); return p; });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: Row) => {
    if (!confirm(`Delete the ${r.label} analysis for ${r.name}?`)) return;
    try {
      await del(`/api/detections/${r.id}`);
      if (openId === r.id) setParams((p) => { p.delete("open"); return p; });
      await rows.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Page title="Change detection" lead="Compare two dates and map exactly where the land changed: floods, surface water, vegetation and forest loss, from real satellite images.">
      <ErrorNote error={catalog.error ?? regions.error ?? rows.error} />
      <section className="card">
        <h2>New analysis</h2>
        <div className="form-grid">
          <label className="field">
            <span>What to detect</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {catalog.data?.analyses.map((a) => <option key={a.kind} value={a.kind}>{a.label} · {a.sensor}</option>)}
            </select>
          </label>
          <RegionPicker regions={live} value={regionId} onChange={setRegionId} label="District or your own area" />
          <label className="field"><span>Before</span><input type="date" value={before} max={after || undefined} onChange={(e) => setBefore(e.target.value)} /></label>
          <label className="field"><span>After</span><input type="date" value={after} min={before || undefined} onChange={(e) => setAfter(e.target.value)} /></label>
        </div>
        {analysis && <p className="muted small">{analysis.model.method}</p>}
        {tooLarge && <p className="notice notice-warn" role="alert">{region!.name} is larger than {maxSpan}° per side. Draw a smaller area under Areas and pick it here.</p>}
        {kind === "ground_deformation" && (
          <p className={catalog.data?.insar_configured ? "muted small" : "notice notice-warn"}>
            {catalog.data?.insar_configured
              ? "Computed by NASA ASF, so it takes about 20 to 90 minutes and uses 10 to 15 of the free monthly credits on the server's Earthdata account. Sentinel-1 returns every 12 days, so the nearest images to your dates are used. Closer dates keep more signal."
              : "This needs a free NASA Earthdata login: set EARTHDATA_TOKEN in the server settings."}
          </p>
        )}
        {kind === "sar_flood" && <p className="muted small">For the full extent of a monsoon flood, set “Before” in the dry season (February to April). A monsoon “Before” date only shows what changed since then.</p>}
        <div className="row-actions">
          <button className="btn btn-primary btn-inline" disabled={busy || !regionId || tooLarge || (kind === "ground_deformation" && !catalog.data?.insar_configured)} onClick={() => void start()}>{busy ? "Starting…" : "Run analysis"}</button>
          <span className="muted small">{kind === "ground_deformation" ? "You can leave this page, and it keeps running even if the server restarts." : "Usually takes 2 to 5 minutes. You can leave this page while it runs."}</span>
        </div>
        <ErrorNote error={error} />
      </section>

      {openId && <Result key={openId} id={openId} onChange={() => void rows.reload()} />}

      <section className="card">
        <h2>Your analyses</h2>
        {rows.data?.length === 0 && <Empty title="No analyses yet">Choose what to detect and an area above.</Empty>}
        {!!rows.data?.length && (
          <table className="tbl">
            <thead><tr><th>Analysis</th><th>Area</th><th>Dates</th><th>Result</th><th>Started</th><th /></tr></thead>
            <tbody>
              {rows.data.map((r) => (
                <tr key={r.id} aria-selected={r.id === openId}>
                  <td><strong>{r.label}</strong></td>
                  <td>{r.name}</td>
                  <td>{day(r.before)} → {day(r.after)}</td>
                  <td>
                    {r.status === "done" && r.summary
                      ? (r.summary.detected ? `${fmt(r.summary.area_km2, 2)} km²${r.summary.risk === "not_rated" ? "" : `, ${r.summary.risk} risk`}` : "Nothing detected")
                      : <Pill tone={STATUS_TONE[r.status] ?? "muted"}>{r.status}</Pill>}
                  </td>
                  <td>{ago(r.createdAt)}</td>
                  <td className="row-actions">
                    <button className="btn btn-small" onClick={() => setParams((p) => { p.set("open", r.id); return p; })}>Open</button>
                    <button className="btn btn-small btn-danger" disabled={r.status === "running" || r.status === "queued"} onClick={() => void remove(r)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Page>
  );
}

function Result({ id, onChange }: { id: string; onChange(): void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const j = await api<Job>(`/api/detections/${id}`);
        if (!alive) return;
        setJob(j);
        setError(null);
        if (j.status === "queued" || j.status === "running") timer = setTimeout(load, 2500);
        else changed.current();
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [id]);

  if (error) return <ErrorNote error={error} />;
  if (!job) return <p className="muted">Loading…</p>;
  const running = job.status === "queued" || job.status === "running";
  return (
    <section className="card det-result" aria-live="polite">
      <div className="ev-head">
        <h2>{job.label}: {job.name}</h2>
        <Pill tone={STATUS_TONE[job.status] ?? "muted"}>{job.status}</Pill>
      </div>
      {job.error && <p className="notice notice-error" role="alert">{job.error}</p>}
      {(running || job.status === "failed") && <Steps steps={job.steps} />}
      {job.record && <Done rec={job.record} id={job.id} steps={job.steps} />}
    </section>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="det-steps">
      {steps.map((s) => (
        <li key={s.key}>
          <Pill tone={STEP_TONE[s.status] ?? "muted"}>{words(s.status)}</Pill>
          <span><strong>{s.label}</strong>{s.detail && <span className="muted small"> {s.detail}</span>}</span>
        </li>
      ))}
    </ol>
  );
}

function FitBox({ bbox }: { bbox: DetectionRecord["bbox"] }) {
  const map = useMap();
  useEffect(() => { map.fitBounds([[bbox.south, bbox.west], [bbox.north, bbox.east]], { padding: [12, 12] }); }, [bbox, map]);
  return null;
}

function DetectionMap({ rec, id }: { rec: DetectionRecord; id: string }) {
  const { mode } = useTheme();
  const [layer, setLayer] = useState("change");
  const [patches, setPatches] = useState(true);
  const overlay = rec.overlays.find((o) => o.id === layer);
  const bounds: [[number, number], [number, number]] = [[rec.bbox.south, rec.bbox.west], [rec.bbox.north, rec.bbox.east]];
  const facilities = rec.assets_in_extent?.geojson?.features ?? [];
  return (
    <div className="det-map-col">
      <div className="legend-toggles" role="group" aria-label="Map layer">
        {rec.overlays.map((o) => (
          <button key={o.id} className="chip" aria-pressed={layer === o.id} onClick={() => setLayer(o.id)}>{LAYER_NAME[o.id] ?? o.id}</button>
        ))}
        <button className="chip" aria-pressed={layer === "none"} onClick={() => setLayer("none")}>Base map</button>
        <button className="chip" aria-pressed={patches} onClick={() => setPatches((v) => !v)}>Detected patches</button>
      </div>
      <div className="det-map">
        <MapContainer center={[(rec.bbox.south + rec.bbox.north) / 2, (rec.bbox.west + rec.bbox.east) / 2]} zoom={9} className="map">
          <BaseLayers />
          <FitBox bbox={rec.bbox} />
          {overlay && <ImageOverlay key={overlay.id} url={authUrl(`/api/detections/${id}/overlays/${overlay.file}`)} bounds={bounds} opacity={0.92} />}
          {patches && rec.geometry.features.length > 0 && (
            <GeoJSON key={`patches-${id}-${mode}`} data={rec.geometry} style={{ color: cssVar("--error"), weight: 1.2, fillOpacity: 0.25 }} />
          )}
          {facilities.map((f) => {
            const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
            const p = f.properties as { asset_type: string; name: string };
            return (
              <CircleMarker key={String(f.id)} center={[lat, lon]} radius={5} pathOptions={{ color: cssVar("--ink"), fillOpacity: 0.9 }}>
                <Tooltip>{p.name || words(p.asset_type)} ({words(p.asset_type)})</Tooltip>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>
      {overlay && <p className="muted small">{overlay.label}{overlay.date ? `, ${day(overlay.date)}` : ""}.{overlay.id === "change" && (rec.deformation ? " Teal: toward the satellite. Brown: away from it. Blank: too little coherence to measure." : " Brown: decrease. Teal: increase.")}</p>}
      {rec.geometry.truncated && <p className="muted small">Showing the largest {rec.geometry.features.length} of {fmtInt(rec.geometry.patch_count)} patches. Areas count all of them.</p>}
    </div>
  );
}

function sceneText(s: any): string {
  if (s.scenes > 1) return `${day(s.first_acquired)} to ${day(s.last_acquired)} (${s.scenes} scenes, ${Math.round(s.clear_fraction * 100)}% clear)`;
  if (s.clear_fraction !== undefined) return `${day(s.acquired)} (${Math.round(s.clear_fraction * 100)}% clear)`;
  return `${day(s.acquired)} (${s.platform}, orbit ${s.relative_orbit}, ${Math.round((s.coverage ?? 0) * 100)}% coverage)`;
}

function Done({ rec, id, steps }: { rec: DetectionRecord; id: string; steps: Step[] }) {
  const unavailable = steps.filter((s) => s.status === "unavailable" || s.status === "partial");
  return (
    <div className="det-grid">
      <div className="det-side">
        <p className="det-headline">
          {rec.detected
            ? <><strong>{fmt(rec.area_km2, 2)} km²</strong> of {rec.noun} <span className="muted">(range {fmt(rec.area_low_km2, 2)} to {fmt(rec.area_high_km2, 2)} km²)</span></>
            : <>No {rec.noun} detected.</>}
        </p>
        <div className="row-actions">
          <Pill tone={CONF_TONE[rec.confidence] ?? "muted"}>{CONF_TEXT[rec.confidence] ?? rec.confidence}</Pill>
          {rec.risk.level !== "not_rated" && <Pill tone={RISK_TONE[rec.risk.level] ?? "muted"}>{rec.risk.level} risk</Pill>}
        </div>
        <p className="small">{rec.risk.explanation}</p>
        <p className="muted small">The range comes from re-running with stricter and looser thresholds. It is not a statistical confidence interval, and this method has not been checked against ground truth.</p>
        {rec.deformation && <Movement d={rec.deformation} />}

        <dl className="stats">
          <div><dt>Before</dt><dd className="small">{sceneText(rec.before)}</dd></div>
          <div><dt>After</dt><dd className="small">{sceneText(rec.after)}</dd></div>
          <div><dt>Area analysed</dt><dd>{fmtInt(rec.aoi_km2)} km²</dd></div>
          <div><dt>{rec.deformation ? "Could be measured" : "Could be assessed"}</dt><dd>{Math.round(rec.valid_fraction * 100)}%</dd></div>
          <div><dt>Resolution</dt><dd>{rec.grid.res_m} m per pixel</dd></div>
          <div><dt>Patches</dt><dd>{fmtInt(rec.geometry.patch_count)}</dd></div>
        </dl>

        {rec.confidence_reasons.length > 0 && <><h3>Why this confidence</h3><ul className="small">{rec.confidence_reasons.map((r) => <li key={r}>{r}</li>)}</ul></>}
        {rec.quality_flags.length > 0 && <><h3>Check before relying on this</h3><ul className="small">{rec.quality_flags.map((r) => <li key={r}>{r}</li>)}</ul></>}
        {unavailable.length > 0 && <><h3>Data that could not be used</h3><ul className="small">{unavailable.map((s) => <li key={s.key}>{s.label}: {s.detail}</li>)}</ul></>}
      </div>
      <DetectionMap rec={rec} id={id} />
      <div className="det-wide">
        {rec.exposure_applicable && <Exposure rec={rec} />}
        {rec.forest && <ForestEvidence forest={rec.forest} />}
        {rec.risk.components.length > 0 && <details className="det-details">
          <summary>Risk breakdown</summary>
          <ul className="small">{rec.risk.components.map((c) => <li key={c.name}><strong>{c.name}: {c.label}.</strong> {c.basis}</li>)}</ul>
        </details>}
        <details className="det-details">
          <summary>Method and limitations: {rec.model.name}</summary>
          <p className="small">{rec.model.method}</p>
          <ul className="small">{rec.model.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
          <p className="muted small">{rec.model.evaluation.note} Finished in {Math.round(rec.processing.seconds)} s.</p>
        </details>
      </div>
    </div>
  );
}

function Movement({ d }: { d: NonNullable<DetectionRecord["deformation"]> }) {
  return (
    <div className="det-block">
      <h3>Ground movement</h3>
      <dl className="stats">
        <div><dt>Most away from the satellite</dt><dd>{d.max_away_mm === null ? "–" : `${fmt(d.max_away_mm, 0)} mm`}</dd></div>
        <div><dt>Most toward the satellite</dt><dd>{d.max_toward_mm === null ? "–" : `${fmt(d.max_toward_mm, 0)} mm`}</dd></div>
        <div><dt>Typical in the patches</dt><dd>{d.median_abs_mm === null ? "–" : `${fmt(d.median_abs_mm, 0)} mm`}</dd></div>
        <div><dt>Detection limit</dt><dd>{fmt(d.threshold_mm, 0)} mm (noise {fmt(d.noise_mm, 0)} mm)</dd></div>
        <div><dt>Vertical, only if there was no sideways movement</dt><dd>{d.vertical_if_purely_vertical_mm === null ? "–" : `${fmt(d.vertical_if_purely_vertical_mm, 0)} mm`}</dd></div>
        <div><dt>Days between images</dt><dd>{d.baseline_days}</dd></div>
      </dl>
      <p className="small">{d.note} Zero is {d.reference}. This is a reason to send someone to inspect. It does not show that any road, bridge or building is damaged.</p>
    </div>
  );
}

function Exposure({ rec }: { rec: DetectionRecord }) {
  const a = rec.assets_in_extent;
  return (
    <div className="det-block">
      <h3>People and facilities inside the extent</h3>
      {rec.population
        ? <p className="small"><strong>About {fmtInt(rec.population.value)} people</strong>{rec.population.low !== rec.population.high && ` (range ${fmtInt(rec.population.low)} to ${fmtInt(rec.population.high)})`}. {rec.population.notes.join(" ")}</p>
        : <p className="small muted">{rec.population_error ?? "Not assessed: nothing was detected."}</p>}
      {a?.status === "available" && (a.total > 0
        ? <p className="small">{Object.entries(a.counts).map(([k, n]) => `${n} ${words(k)}`).join(", ")}. From OpenStreetMap, which may be incomplete{a.truncated ? " and was truncated for this area" : ""}.</p>
        : <p className="small muted">No mapped facilities inside the extent. OpenStreetMap is often incomplete in rural areas, so this does not prove there are none.</p>)}
      {a?.status === "unavailable" && <p className="small muted">Facilities could not be checked: {a.reason}</p>}
    </div>
  );
}

function ForestEvidence({ forest }: { forest: any }) {
  const { hansen, firms, protected_areas: prot, fusion, hotspots } = forest;
  return (
    <div className="det-block">
      <h3>Independent forest evidence</h3>
      <p className="small"><strong>Corroboration: {fusion.corroboration}.</strong> {fusion.interpretation} This counts agreeing datasets; it is not a probability.</p>
      <ul className="small">
        <li><strong>Hansen annual forest loss ({words(hansen.status)}).</strong> {hansen.matching_annual_loss_km2 !== null && hansen.matching_annual_loss_km2 !== undefined && `${fmt(hansen.matching_annual_loss_km2, 2)} km² recorded in ${hansen.years.join(", ")}, ${fmt(hansen.overlap_km2, 2)} km² overlapping this detection. `}{hansen.reason ?? ""} {hansen.note}</li>
        <li><strong>NASA FIRMS fires ({words(firms.status)}).</strong> {firms.fire_detections !== null && `${fmtInt(firms.fire_detections)} detections, ${day(firms.window.start)} to ${day(firms.window.end)}. `}{firms.reason ?? ""} {firms.note}</li>
        <li><strong>Protected areas ({words(prot.status)}).</strong> {prot.status === "available"
          ? (prot.overlapping_total ? `Overlaps ${prot.overlapping.map((p: any) => p.name).join(", ")}. ` : `${prot.in_area} in the area, none overlapping. `)
          : `${prot.reason} `}{prot.note}</li>
      </ul>
      {hotspots.length > 0 && (
        <details className="det-details">
          <summary>Largest patches ({hotspots.length})</summary>
          <table className="tbl small">
            <thead><tr><th className="num">km²</th><th>Latitude</th><th>Longitude</th></tr></thead>
            <tbody>{hotspots.map((h: any) => <tr key={h.id}><td className="num">{fmt(h.area_km2, 2)}</td><td>{h.latitude}</td><td>{h.longitude}</td></tr>)}</tbody>
          </table>
        </details>
      )}
    </div>
  );
}
