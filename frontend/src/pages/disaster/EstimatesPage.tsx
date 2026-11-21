import { useCallback, useEffect, useState } from "react";
import type { Map as LeafletMap } from "leaflet";
import { Rectangle, Tooltip } from "react-leaflet";
import { Link, useSearchParams } from "react-router-dom";
import { authUrl, post } from "../../api";
import { ConvergenceChart } from "../../components/ConvergenceChart";
import { cssVar } from "../../theme";
import { Empty, ErrorNote, Page, Pill, useAction, useData } from "../common";
import type { Region } from "../../types";
import { heat, MapFrame, SILENT_BASIS, SilentCells, type SilentZone } from "./shared";

interface Overall { estimate: number; lo: number; hi: number; reported: number; hidden: number; hidden_lo: number; hidden_hi: number; method: string; n: number; bounded_by_unreachable: boolean; area?: string; cells?: number }
interface RunCell { id: string; stratum: number; design_score: number; status: string; measured: number | null; estimated_need: number | null; hidden_need: number | null; reported: number; hazard: number; households: number }
interface Rate { rate: number; lo: number; hi: number; checks: number }
interface Last {
  status: "collecting" | "estimating"; message: string | null; overall: Overall | null; by_area: Overall[]; checks_done: number; min_checks: number;
  pending: string[]; unreachable: string[]; strata: { stratum: number; cells: number; checked: number; pending: number; unreachable: number; mean_reported: number; mean_measured: number | null; reporting_rate: Rate | null; variance_share: number | null }[];
  reporting_rate: Rate | null; population_fallback_cells: number;
  silent_zones: SilentZone[]; observation_suggestion: { stratum: number; reason: string; cells: string[] }; cells: RunCell[]; covers: string; confidence_used: number;
}
interface RunSummary { id: string; name: string; createdAt: string; simulated: boolean; cellCount: number; waveSize: number; bbox: [number, number, number, number]; notes: string[];
  hazardSources: { id: string; state: string }[]; observationIds: string[]; history?: { n: number; t: number; value: number; lo: number; hi: number }[];
  last: { status: string; overall: Overall | null; checks_done: number; pending: number; unreachable: number; silent: number } | null }
interface RunDetail extends Omit<RunSummary, "last"> { cells: { id: string; bbox: [number, number, number, number]; area: string }[]; last: Last | null }

const n0 = (v: number) => Math.round(v).toLocaleString("en-IN");
const fmtRate = (r: Rate | null | undefined) => (r ? `${Math.round(r.rate * 100)}% (${Math.round(r.lo * 100)}–${Math.round(r.hi * 100)}%)` : "–");

/** Maun estimates: reported need vs estimated true need with its 95% range, from random field checks. */
export function EstimatesPage() {
  const runs = useData<RunSummary[]>("/api/maun/runs");
  const [params, setParams] = useSearchParams();
  const id = params.get("run") ?? runs.data?.[0]?.id ?? null;
  return (
    <Page title="Estimates" lead="Every platform counts the people who asked. Maun also estimates the need nobody reported, with an honest 95% range, from field checks in randomly chosen cells.">
      <ErrorNote error={runs.error} />
      <NewRun onCreated={(rid) => { void runs.reload(); setParams({ run: rid }); }} />
      {runs.data && runs.data.length === 0 && <Empty title="No estimation runs yet">Start one for the affected area above.</Empty>}
      {!!runs.data?.length && (
        <div className="seg" role="group" aria-label="Run">
          {runs.data.map((r) => <button key={r.id} className={r.id === id ? "active" : ""} onClick={() => setParams({ run: r.id })}>{r.name}{r.simulated && !/SIMULATED/i.test(r.name) ? " (SIMULATED)" : ""}</button>)}
        </div>
      )}
      {id && <RunView key={id} id={id} />}
    </Page>
  );
}

function NewRun({ onCreated }: { onCreated(id: string): void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", bbox: "", cellDeg: "0.025", waveSize: "30" });
  const [mode, setMode] = useState<"district" | "map">("district");
  const [district, setDistrict] = useState("");
  const regions = useData<Region[]>(open ? "/api/regions" : null, [open]);
  const [map, setMap] = useState<LeafletMap | null>(null);
  const act = useAction();
  const onReady = useCallback((m: LeafletMap) => setMap(m), []);
  if (!open) return <div className="row-actions"><button className="btn btn-primary" onClick={() => setOpen(true)}>Start a new estimation run</button></div>;
  const useView = () => { if (map) { const b = map.getBounds(); setF({ ...f, bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(4)).join(",") }); } };
  const districts = (regions.data ?? []).filter((r) => r.kind === "district").sort((a, b) => `${a.state} ${a.name}`.localeCompare(`${b.state} ${b.name}`));
  const label = (r: Region) => `${r.name}${r.state ? `, ${r.state}` : ""}`;
  const chosen = districts.find((r) => label(r) === district) ?? null;
  const ready = !!f.name && (mode === "district" ? !!chosen : !!f.bbox);
  return (
    <section className="card">
      <h2>New estimation run</h2>
      <p className="muted small">Choose a district (cells are kept inside its boundary) or use the map view. For every cell the run reads people from the HRSL 30 m
        population map and the hazard layers; each wave sends volunteers to randomly chosen cells.</p>
      <div className="seg" role="group" aria-label="Area by">
        <button className={mode === "district" ? "active" : ""} onClick={() => setMode("district")}>District</button>
        <button className={mode === "map" ? "active" : ""} onClick={() => setMode("map")}>Map view</button>
      </div>
      {mode === "map" && <MapFrame height={260} onReady={onReady} />}
      <div className="form-grid">
        <label className="field"><span>Name</span><input value={f.name} maxLength={120} placeholder="e.g. Barpeta flood, week 1" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        {mode === "district" ? (
          <label className="field"><span>District</span>
            <input list="maun-districts" value={district} placeholder={regions.loading ? "Loading districts…" : "Type to search, e.g. Barpeta"}
              onChange={(e) => { setDistrict(e.target.value); const r = districts.find((x) => label(x) === e.target.value); if (r && !f.name) setF({ ...f, name: `${r.name} estimate` }); }} />
            <datalist id="maun-districts">{districts.map((r) => <option key={r.id} value={label(r)} />)}</datalist>
          </label>
        ) : (
          <label className="field"><span>Area (west,south,east,north)</span>
            <div className="row-actions"><input className="input" value={f.bbox} onChange={(e) => setF({ ...f, bbox: e.target.value })} /><button type="button" className="btn btn-small" onClick={useView}>Use map view</button></div></label>
        )}
        <label className="field"><span>Cell size (degrees, 0.025 ≈ 2.5 km)</span><input type="number" step="0.005" min="0.005" max="0.2" value={f.cellDeg} onChange={(e) => setF({ ...f, cellDeg: e.target.value })} /></label>
        <label className="field"><span>Field checks per wave</span><input type="number" min="6" max="200" value={f.waveSize} onChange={(e) => setF({ ...f, waveSize: e.target.value })} /></label>
      </div>
      <ErrorNote error={act.error} />
      <div className="row-actions">
        <button className="btn btn-primary" disabled={!ready || !!act.busy} onClick={() => void act.run("go", async () => {
          const area = mode === "district" ? { regionId: chosen!.id } : { bbox: f.bbox };
          const r = await post<{ id: string }>("/api/maun/runs", { name: f.name, ...area, cellDeg: Number(f.cellDeg), waveSize: Number(f.waveSize) });
          setOpen(false); onCreated(r.id);
        })}>{act.busy ? "Reading population and hazard, choosing cells… (a few minutes for a district)" : "Start run and create field-check tasks"}</button>
        <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </section>
  );
}

function RunView({ id }: { id: string }) {
  const run = useData<RunDetail & { history?: RunSummary["history"] }>(`/api/maun/runs/${id}`, [id]);
  const act = useAction();
  const [show, setShow] = useState<"hidden" | "status" | "hazard">("hidden");
  // live: the estimate and its range update as volunteers enter results
  useEffect(() => {
    const es = new EventSource(authUrl(`/api/maun/runs/${id}/events`));
    es.onmessage = (e) => { try { if (JSON.parse(e.data).type === "estimate") void run.reload(); } catch { /* ignore */ } };
    return () => es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const r = run.data;
  if (!r) return run.error ? <ErrorNote error={run.error} /> : <p className="muted">Loading…</p>;
  const L = r.last;
  const o = L?.overall;
  const byId = new Map((L?.cells ?? []).map((c) => [c.id, c]));
  const maxHidden = Math.max(1, ...(L?.cells ?? []).map((c) => c.hidden_need ?? 0));
  const bounds: [[number, number], [number, number]] = [[r.bbox[1], r.bbox[0]], [r.bbox[3], r.bbox[2]]];
  const statusColor = (s: string) => cssVar(s === "checked" ? "--ok" : s === "pending" ? "--cyan" : s === "unreachable" ? "--error" : "--muted");

  return (
    <div className="stack">
      {r.simulated && <p className="notice notice-warn"><strong>SIMULATED.</strong> This run uses generated reports and simulated field checks for demonstration. No real need is shown.</p>}
      <div className="kpis">
        <div className="kpi"><span className="kpi-value">{n0(o?.reported ?? r.cells.reduce((s, c) => s + (byId.get(c.id)?.reported ?? 0), 0))}</span><span className="kpi-label">Reported need (households)</span></div>
        <div className="kpi"><span className="kpi-value">{o ? n0(o.estimate) : "–"}</span><span className="kpi-label">Estimated true need {o && <span className="muted">95% range {n0(o.lo)}–{n0(o.hi)}</span>}</span></div>
        <div className="kpi kpi-warn"><span className="kpi-value">{o ? n0(o.hidden) : "–"}</span><span className="kpi-label">Hidden need {o && <span className="muted">{n0(o.hidden_lo)}–{n0(o.hidden_hi)}</span>}</span></div>
        <div className="kpi"><span className="kpi-value">{L?.checks_done ?? 0}</span><span className="kpi-label">Field checks done <span className="muted">{L?.pending.length ?? 0} pending · {L?.unreachable.length ?? 0} unreachable</span></span></div>
        <div className="kpi"><span className="kpi-value">{L?.reporting_rate ? `${Math.round(L.reporting_rate.rate * 100)}%` : "–"}</span>
          <span className="kpi-label">Reporting rate, learned {L?.reporting_rate ? <span className="muted">95% {Math.round(L.reporting_rate.lo * 100)}–{Math.round(L.reporting_rate.hi * 100)}% from {L.reporting_rate.checks} checks</span> : <span className="muted">after the first checks</span>}</span></div>
      </div>
      {!!L?.population_fallback_cells && <p className="notice notice-warn">{L.population_fallback_cells} cell(s) have no population from the HRSL map and use a flat 400 people/km² fallback{r.simulated ? "" : "; see Assumptions below"}.</p>}
      {L?.status === "collecting" && <p className="notice notice-warn">{L.message}</p>}
      {o?.bounded_by_unreachable && <p className="notice notice-warn">Some selected cells could not be reached. They stay in the sample (never swapped); the range covers both no need and every household in need there.</p>}
      <p className="muted small">Method: {o?.method === "crossfit_difference" ? "cross-fitted difference estimator" : "stratified estimator"} · confidence per look {L ? (L.confidence_used * 100).toFixed(2) : "–"}% (alpha spending, so the 95% holds however often you look) · covers {L?.covers ?? "sampling error only"}.</p>

      <div className="dash-grid">
        <section className="card">
          <div className="ev-head"><h2>Map</h2>
            <div className="seg" role="group" aria-label="Show">{([["hidden", "Hidden need"], ["status", "Checks"], ["hazard", "Hazard"]] as const).map(([k, v]) => <button key={k} className={show === k ? "active" : ""} onClick={() => setShow(k)}>{v}</button>)}</div>
          </div>
          <MapFrame height={420} bounds={bounds}>
            {r.cells.map((c) => {
              const s = byId.get(c.id);
              if (!s) return null;
              const fill = show === "hidden" ? heat((s.hidden_need ?? 0) / maxHidden) : show === "hazard" ? heat(s.hazard) : statusColor(s.status);
              const op = show === "status" ? (s.status === "not_selected" ? 0.05 : 0.55) : 0.1 + 0.5 * (show === "hidden" ? (s.hidden_need ?? 0) / maxHidden : s.hazard);
              return (
                <Rectangle key={c.id} bounds={[[c.bbox[1], c.bbox[0]], [c.bbox[3], c.bbox[2]]]} pathOptions={{ weight: s.status === "pending" || s.status === "unreachable" ? 1.5 : 0.3, color: statusColor(s.status), fillColor: fill, fillOpacity: op }}>
                  <Tooltip>{c.id} ({c.area}) · stratum {s.stratum} · {s.status.replace(/_/g, " ")}<br />{Math.round(s.households)} households · reported {s.reported} · {s.measured != null ? `measured ${s.measured}` : s.estimated_need != null ? `estimated ${s.estimated_need.toFixed(1)}` : "not estimated yet"}{s.hidden_need != null ? ` · hidden ${s.hidden_need.toFixed(1)}` : ""} · hazard {s.hazard.toFixed(2)}</Tooltip>
                </Rectangle>
              );
            })}
            <SilentCells zones={L?.silent_zones ?? []} />
          </MapFrame>
        </section>
        <section className="card">
          <h2>Estimate as checks arrive</h2>
          {r.history && r.history.length > 0
            ? <ConvergenceChart history={r.history.map((h) => ({ n: h.n, t: h.t, value: h.value, lo: h.lo, hi: h.hi }))} digits={0} unit="households" population={null} />
            : <p className="muted small">The chart starts once every stratum has two completed checks (at least {L?.min_checks ?? 18} checks in the first wave).</p>}
          <div className="row-actions">
            <button className="btn btn-primary" disabled={!!act.busy} onClick={() => void act.run("wave", async () => { await post(`/api/maun/runs/${id}/waves`, { size: r.waveSize }); await run.reload(); return `Next wave created: ${r.waveSize} field-check tasks.`; })}>Send the next wave</button>
            <Link className="btn" to="/app/tasks">Field-check tasks</Link>
          </div>
          <ErrorNote error={act.error} />
          {act.message && <p className="notice notice-ok">{act.message}</p>}
          {L?.observation_suggestion?.cells.length ? <p className="small">Widest range: stratum {L.observation_suggestion.stratum} ({L.observation_suggestion.reason}). {r.observationIds.length} sharper-observation request(s) sent <Pill tone="warn">SIMULATED adapter</Pill>.</p> : null}
        </section>
      </div>

      {!!L?.by_area.length && (
        <section className="card">
          <h2>By area</h2>
          <table className="tbl">
            <thead><tr><th>Area</th><th className="num">Cells</th><th className="num">Reported</th><th className="num">Estimated</th><th className="num">95% range</th><th className="num">Hidden</th></tr></thead>
            <tbody>{L.by_area.map((a) => <tr key={a.area}><td>{a.area}</td><td className="num">{a.cells}</td><td className="num">{n0(a.reported)}</td><td className="num">{n0(a.estimate)}</td><td className="num">{n0(a.lo)}–{n0(a.hi)}</td><td className="num">{n0(a.hidden)}</td></tr>)}</tbody>
          </table>
        </section>
      )}
      {!!L?.strata.length && (
        <section className="card">
          <h2>Strata</h2>
          <p className="muted small">Cells are grouped by the average percentile rank of households exposed to the hazard and of reports (no weights). Reporting rate = reports ÷ measured need in the checked cells, with its 95% interval.</p>
          <table className="tbl small">
            <thead><tr><th>Stratum</th><th className="num">Cells</th><th className="num">Checked</th><th className="num">Pending</th><th className="num">Unreachable</th><th className="num">Mean reported</th><th className="num">Mean measured</th><th className="num">Reporting rate</th><th className="num">Share of uncertainty</th></tr></thead>
            <tbody>{L.strata.map((s) => <tr key={s.stratum}><td>{s.stratum}</td><td className="num">{s.cells}</td><td className="num">{s.checked}</td><td className="num">{s.pending}</td><td className="num">{s.unreachable}</td><td className="num">{s.mean_reported}</td><td className="num">{s.mean_measured ?? "–"}</td><td className="num">{fmtRate(s.reporting_rate)}</td><td className="num">{s.variance_share != null ? `${Math.round(s.variance_share * 100)}%` : "–"}</td></tr>)}</tbody>
          </table>
        </section>
      )}
      {!!r.notes.length && <section className="card"><h2>Assumptions</h2><ul className="small">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        <p className="muted small">Nothing about need is assumed: how need relates to each hazard layer, people and reports is learned from the field checks by the cross-fitted model. The design only decides which cells are checked; it cannot bias the estimate.</p></section>}
    </div>
  );
}

export function SilentZonesPage() {
  const res = useData<{ run: { id: string; name: string; simulated: boolean } | null; zones: SilentZone[] }>("/api/maun/silent-zones");
  const z = res.data?.zones ?? [];
  const boxes = z.map((x) => x.bbox).filter(Boolean) as [number, number, number, number][];
  const bounds = boxes.length ? [[Math.min(...boxes.map((b) => b[1])), Math.min(...boxes.map((b) => b[0]))], [Math.max(...boxes.map((b) => b[3])), Math.max(...boxes.map((b) => b[2]))]] as [[number, number], [number, number]] : null;
  return (
    <Page title="Silent zones" lead="Cells where the need is significantly higher than what people reported, measured by field checks or tested statistically (false discoveries held at 10%), and cells where reports suddenly stopped. Silence is not safety.">
      <ErrorNote error={res.error} />
      {res.data?.run?.simulated && <p className="notice notice-warn">From a SIMULATED demo run.</p>}
      {res.data && !res.data.run && <Empty title="No estimation run yet"><Link to="/app/estimates">Start one</Link> to look for silent zones.</Empty>}
      {res.data?.run && (
        <>
          <p className="muted small">From run “{res.data.run.name}”. <Link to={`/app/estimates?run=${res.data.run.id}`}>Open the run</Link>.</p>
          <section className="card"><MapFrame height={380} bounds={bounds}><SilentCells zones={z} /></MapFrame></section>
          <div className="table-scroll card">
            <table className="tbl">
              <thead><tr><th>Cell</th><th>Why</th><th>Evidence</th><th className="num">Unreported need</th><th className="num">p-value</th><th className="num">Reports</th><th>Check</th><th>Suggested action</th></tr></thead>
              <tbody>{z.map((x) => <tr key={x.id}><td>{x.id}</td><td className="small">{x.reason}</td><td className="small">{SILENT_BASIS[x.basis] ?? x.basis}</td><td className="num">{x.estimated_gap != null ? `~${Math.round(x.estimated_gap)} households` : "–"}</td><td className="num">{x.p_value != null ? x.p_value.toFixed(3) : "–"}</td><td className="num">{x.reported}</td><td>{x.status.replace(/_/g, " ")}</td><td className="small">{x.action}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </Page>
  );
}
