import "leaflet/dist/leaflet.css";
import { useEffect, useState } from "react";
import { GeoJSON, MapContainer, TileLayer, useMap } from "react-leaflet";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ago, fmt } from "../format";
import type { AOI, Alert, Monitor, Region, Report, Session } from "../types";
import { ErrorNote, Page, Pill, ReportStatus, useData } from "./common";

interface Dash {
  counts: { open_alerts: number; monitors: number; active_monitors: number; aois: number; reports_pending: number; unread_notifications: number };
  alerts: Alert[];
  monitors: Monitor[];
  aois: AOI[];
  recent_runs: (Session & { data_mode: string | null })[];
  reports: Report[];
}

export function DashboardPage() {
  const { data, error } = useData<Dash>("/api/dashboard");
  const c = data?.counts;
  const firstRun = data && data.aois.length === 0 && data.monitors.length === 0;
  return (
    <Page title="Dashboard" lead="Active alerts, monitored areas and the latest satellite analyses at a glance.">
      <ErrorNote error={error} />
      {firstRun && <SetupGuide />}
      <div className="kpis">
        <Kpi label="Open alerts" value={c?.open_alerts} tone={c?.open_alerts ? "error" : undefined} to="/app/alerts" />
        <Kpi label="Active monitors" value={c?.active_monitors} sub={c ? `of ${c.monitors}` : ""} to="/app/monitors" />
        <Kpi label="Areas of interest" value={c?.aois} to="/app/areas" />
        <Kpi label="Reports awaiting approval" value={c?.reports_pending} tone={c?.reports_pending ? "warn" : undefined} to="/app/reports" />
      </div>
      <div className="dash-grid">
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
    </Page>
  );
}

function Kpi({ label, value, sub, tone, to }: { label: string; value?: number; sub?: string; tone?: "error" | "warn"; to: string }) {
  return (
    <Link to={to} className={`kpi ${tone ? `kpi-${tone}` : ""}`}>
      <span className="kpi-value">{value ?? "–"}</span>
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
  const status = (a: AOI) => monitors.filter((m) => m.aoiId === a.id).some((m) => m.lastStatus === "triggered") ? "alert" : "ok";
  return (
    <div className="mini-map">
      <MapContainer center={[22.5, 79]} zoom={4} className="map" preferCanvas>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
        <FitAll bounds={bounds} />
        {shapes.map(({ aoi, region }) => region.geometry && (
          <GeoJSON key={aoi.id} data={{ type: "Feature", properties: {}, geometry: region.geometry } as GeoJSON.Feature}
            style={{ color: status(aoi) === "alert" ? "#a33a2e" : "#1d5fb4", weight: 2, fillOpacity: 0.12 }}
            onEachFeature={(_f, l) => l.bindTooltip(`${aoi.name}${region.state ? `, ${region.state}` : ""}`)} />
        ))}
      </MapContainer>
    </div>
  );
}
