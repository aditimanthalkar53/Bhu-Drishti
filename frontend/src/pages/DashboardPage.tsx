import "leaflet/dist/leaflet.css";
import { useEffect, useState } from "react";
import { GeoJSON, MapContainer, useMap } from "react-leaflet";
import { BaseLayers } from "../components/BaseLayers";
import { cssVar, useTheme } from "../theme";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ago, fmt } from "../format";
import type { AOI, Alert, Monitor, Region, Report, Session, SourceStatus } from "../types";
import { ErrorNote, Pill, ReportStatus, useData } from "./common";

interface Dash {
  counts: { open_alerts: number; monitors: number; active_monitors: number; aois: number; reports_pending: number; unread_notifications: number };
  alerts: Alert[];
  monitors: Monitor[];
  aois: AOI[];
  recent_runs: (Session & { data_mode: string | null })[];
  reports: Report[];
}

export function DashboardPage() {
  const { data, error, loading, reload } = useData<Dash>("/api/dashboard");
  const c = data?.counts;
  const firstRun = data && data.aois.length === 0 && data.monitors.length === 0;
  return (
    <main className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">Satellite flood intelligence · India</p>
          <h1>Bhu-Drishti dashboard</h1>
          <p>Error-bounded answers on flooded cropland, fires and construction for any district, computed from Sentinel, NASA and Copernicus data, with the uncertainty stated.</p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-primary btn-inline" to="/app">Ask a question</Link>
          <button className="btn" onClick={() => void reload()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
        </div>
      </section>
      <ErrorNote error={error} />
      {firstRun && <SetupGuide />}
      {loading && !data ? (
        <div className="kpis" aria-busy="true" aria-label="Loading">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton sk-kpi" />)}</div>
      ) : (
        <div className="kpis">
          <Kpi label="Open alerts" value={c?.open_alerts} tone={c?.open_alerts ? "error" : undefined} to="/app/alerts" />
          <Kpi label="Active monitors" value={c?.active_monitors} sub={c ? `of ${c.monitors}` : ""} to="/app/monitors" />
          <Kpi label="Areas of interest" value={c?.aois} to="/app/areas" />
          <Kpi label="Reports awaiting approval" value={c?.reports_pending} tone={c?.reports_pending ? "warn" : undefined} to="/app/reports" />
        </div>
      )}
      <div className="dash-grid">
        <SourcesCard />
        <section className="card dash-map-card">
          <h2>Monitored areas</h2>
          {data && data.aois.length > 0 ? <AoiMap aois={data.aois} monitors={data.monitors} /> : <p className="muted small">Add an area of interest to see it here.</p>}
        </section>
        <section className="card">
          <h2>Open alerts</h2>
          {data && data.alerts.length === 0 && <p className="muted small">No open alerts. Monitors raise one when a threshold is crossed.</p>}
          <ul className="list">
            {data?.alerts.map((a) => (
              <li key={a.id}>
                <Link to="/app/alerts"><strong>{a.title}</strong></Link>
                <span className="muted small"> · {a.status} · {ago(a.createdAt)}</span>
                <p className="small">{a.message}</p>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Latest runs</h2>
          {data && data.recent_runs.length === 0 && <p className="muted small">No analyses yet — <Link to="/app">ask a question</Link>.</p>}
          <ul className="list">
            {data?.recent_runs.map((s) => (
              <li key={s.id}>
                <Link to={`/app?open=${s.id}`}>{s.question}</Link>
                <div className="muted small">
                  {s.source === "monitor" ? "monitor · " : ""}{s.data_mode === "live" ? "live" : s.data_mode === "simulated" ? "simulated" : ""} · {s.status} · {ago(s.createdAt)}
                </div>
                {s.answer && <p className="small">{s.answer}</p>}
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Monitors</h2>
          {data && data.monitors.length === 0 && <p className="muted small">No monitors yet.</p>}
          <table className="tbl">
            <tbody>
              {data?.monitors.map((m) => (
                <tr key={m.id}>
                  <td><Link to="/app/monitors">{m.name}</Link></td>
                  <td>{m.lastStatus ? <Pill tone={m.lastStatus === "triggered" ? "error" : m.lastStatus === "failed" ? "warn" : m.lastStatus === "running" ? "info" : "ok"}>{m.lastStatus}</Pill> : <Pill tone="muted">not run</Pill>}</td>
                  <td className="num">{m.lastValue != null ? fmt(m.lastValue, 1) : "–"}</td>
                  <td className="muted small">{ago(m.lastRunAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2>Reports</h2>
          {data && data.reports.length === 0 && <p className="muted small">Reports created from runs and monitors appear here.</p>}
          <ul className="list">
            {data?.reports.map((r) => (
              <li key={r.id}><Link to={`/app/reports/${r.id}`}>{r.title}</Link> <ReportStatus status={r.status} /> <span className="muted small">{ago(r.createdAt)}</span></li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}

/** Counts up from 0 on first value; jumps straight to the value under prefers-reduced-motion. */
function useCountUp(target: number | undefined): number | undefined {
  const [shown, setShown] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (target == null) { setShown(undefined); return; }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || target === 0) { setShown(target); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 700);
      setShown(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

const SRC_TONE: Record<string, "ok" | "warn" | "error" | "info" | "muted"> = {
  e2e_verified: "ok", retrieval_verified: "ok", discovery_verified: "info", authenticated: "info", configured: "muted", not_configured: "warn", blocked: "error",
};
const SRC_DOT: Record<string, string> = { ok: "", warn: "dot-warning", error: "dot-critical", info: "", muted: "" };

/** Live status of each data provider, straight from /api/sources (no invented values). */
function SourcesCard() {
  const { data, error, loading } = useData<SourceStatus[]>("/api/sources");
  return (
    <section className="card src-card">
      <div className="ev-head"><h2>Data sources</h2><Link className="small" to="/app/data">Details &amp; live checks</Link></div>
      {loading && !data && <div aria-busy="true"><div className="skeleton sk-line" /><div className="skeleton sk-line" /><div className="skeleton sk-line" /></div>}
      {error && <p className="notice notice-error" role="alert">Could not load source status: {error}</p>}
      {data && data.length === 0 && <p className="muted small">The engine reports no data sources.</p>}
      <div className="src-grid">
        {data?.map((s) => {
          const tone = SRC_TONE[s.status] ?? "muted";
          return (
            <div key={s.id} className="src-row">
              <div className="src-left">
                <span className={`dot ${SRC_DOT[tone]}`} aria-hidden="true" />
                <div><strong>{s.name}</strong><small>{s.checked_at ? `checked ${ago(s.checked_at)}` : "not checked this session"}</small></div>
              </div>
              <Pill tone={tone}>{s.status_label}</Pill>
            </div>
          );
        })}
      </div>
      <p className="muted small">“Verified” means a real request succeeded in this engine session. Open-Meteo river discharge is a modelled forecast, not a gauge reading.</p>
    </section>
  );
}

function Kpi({ label, value, sub, tone, to }: { label: string; value?: number; sub?: string; tone?: "error" | "warn"; to: string }) {
  const shown = useCountUp(value);
  return (
    <Link to={to} className={`kpi ${tone ? `kpi-${tone}` : ""}`}>
      <span className="kpi-value">{shown ?? "–"}</span>
      <span className="kpi-label">{label} {sub && <span className="muted">{sub}</span>}</span>
    </Link>
  );
}

function SetupGuide() {
  return (
    <section className="card setup">
      <h2>Get set up in four steps</h2>
      <ol>
        <li><Link to="/app/areas">Add an area of interest</Link> — any Indian district, or draw/upload your own boundary.</li>
        <li><Link to="/app">Ask a question</Link> about it in Explore, e.g. “What percentage of cropland was flooded in the last 14 days?”.</li>
        <li><Link to="/app/recipients">Add the officials</Link> who should receive reports (DDMA, agriculture, revenue).</li>
        <li><Link to="/app/monitors">Create a monitor</Link> so the question re-runs on every new satellite pass and alerts you above a threshold.</li>
      </ol>
    </section>
  );
}

function FitAll({ bounds }: { bounds: [number, number, number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (bounds) map.fitBounds([[bounds[1], bounds[0]], [bounds[3], bounds[2]]], { padding: [20, 20] });
  }, [bounds, map]);
  return null;
}

function AoiMap({ aois, monitors }: { aois: AOI[]; monitors: Monitor[] }) {
  const [shapes, setShapes] = useState<{ aoi: AOI; region: Region }[]>([]);
  useEffect(() => {
    void Promise.all(aois.map((a) => api<Region>(`/api/regions/${encodeURIComponent(a.regionId)}`).then((region) => ({ aoi: a, region })).catch(() => null)))
      .then((xs) => setShapes(xs.filter(Boolean) as { aoi: AOI; region: Region }[]));
  }, [aois]);
  const bounds = shapes.length ? shapes.reduce<[number, number, number, number]>((b, s) =>
    [Math.min(b[0], s.region.bbox[0]), Math.min(b[1], s.region.bbox[1]), Math.max(b[2], s.region.bbox[2]), Math.max(b[3], s.region.bbox[3])],
  [180, 90, -180, -90]) : null;
  const { mode } = useTheme();
  const status = (a: AOI) => monitors.filter((m) => m.aoiId === a.id).some((m) => m.lastStatus === "triggered") ? "alert" : "ok";
  return (
    <div className="mini-map">
      <MapContainer center={[22.5, 79]} zoom={4} className="map" preferCanvas>
        <BaseLayers />
        <FitAll bounds={bounds} />
        {shapes.map(({ aoi, region }) => region.geometry && (
          <GeoJSON key={`${aoi.id}-${mode}`} data={{ type: "Feature", properties: {}, geometry: region.geometry } as GeoJSON.Feature}
            style={{ color: cssVar(status(aoi) === "alert" ? "--error" : "--water"), weight: 2, fillOpacity: 0.12 }}
            onEachFeature={(_f, l) => l.bindTooltip(`${aoi.name}${region.state ? `, ${region.state}` : ""}`)} />
        ))}
      </MapContainer>
    </div>
  );
}
