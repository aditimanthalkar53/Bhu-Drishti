import { ErrorNote, Page, useData } from "./common";

interface Usage { month: string; runs: number; runs_total: number; model_runs: number; tiles_analysed: number; cache_hits: number; live_runs: number;
  by_source: { user: number; monitor: number } }

export function UsagePage() {
  const u = useData<Usage>("/api/usage");
  const d = u.data;
  return (
    <Page title="Usage" lead={`This month (${d?.month ?? "…"}): how much analysis your account ran.`}>
      <ErrorNote error={u.error} />
      <div className="kpis">
        <div className="kpi"><span className="kpi-value">{d?.runs ?? "–"}</span><span className="kpi-label">Analyses this month <span className="muted">({d?.runs_total ?? "–"} total)</span></span></div>
        <div className="kpi"><span className="kpi-value">{d?.live_runs ?? "–"}</span><span className="kpi-label">On live satellite data</span></div>
        <div className="kpi"><span className="kpi-value">{d?.model_runs?.toLocaleString("en-IN") ?? "–"}</span><span className="kpi-label">Specialist model runs</span></div>
        <div className="kpi"><span className="kpi-value">{d?.tiles_analysed?.toLocaleString("en-IN") ?? "–"}</span><span className="kpi-label">Tiles analysed</span></div>
        <div className="kpi"><span className="kpi-value">{d?.cache_hits?.toLocaleString("en-IN") ?? "–"}</span><span className="kpi-label">Results reused from cache</span></div>
        <div className="kpi"><span className="kpi-value">{d ? `${d.by_source.user} / ${d.by_source.monitor}` : "–"}</span><span className="kpi-label">People / monitors</span></div>
      </div>
      <p className="muted small">Provider quotas (Copernicus processing units, FIRMS transactions, Earth Engine) are tracked per source on the Data page.</p>
    </Page>
  );
}
