import { useState } from "react";
import { api, post } from "../api";
import { RegionPicker } from "../components/RegionPicker";
import { ago, fmtDate } from "../format";
import type { Region, SourceStatus } from "../types";
import { ErrorNote, Page, Pill, useAction, useData } from "./common";

const TONE: Record<string, "ok" | "warn" | "error" | "info" | "muted"> = {
  e2e_verified: "ok", retrieval_verified: "ok", discovery_verified: "info", authenticated: "info", configured: "muted",
  not_configured: "warn", blocked: "error",
};

interface Freshness { region_id: string; items: { product: string; source: string; latest?: string | null; error?: string; note?: string }[]; note?: string }

export function DataCatalogPage() {
  const sources = useData<SourceStatus[]>("/api/sources");
  const regions = useData<Region[]>("/api/regions");
  const [regionId, setRegionId] = useState("in-assam-barpeta");
  const [fresh, setFresh] = useState<Freshness | null>(null);
  const act = useAction();

  return (
    <Page title="Data catalog" lead="Where Bhu-Drishti's data comes from, whether each source works right now, and how fresh it is."
      actions={
        <button className="btn btn-primary btn-inline" disabled={act.busy === "check"} onClick={() => void act.run("check", async () => {
          sources.setData(await post<SourceStatus[]>("/api/sources/check"));
          return "Live checks finished.";
        })}>{act.busy === "check" ? "Running live checks (1–3 min)…" : "Run live checks"}</button>
      }>
      <ErrorNote error={sources.error ?? act.error} />
      {act.message && <p className="notice notice-ok">{act.message}</p>}
      <p className="muted small">A source only shows “verified” after a real request succeeded in this engine session: searching a catalogue is not the same as reading an image.</p>
      <div className="stack">
        {sources.data?.map((s) => (
          <section key={s.id} className="card">
            <div className="ev-head">
              <h2><a href={s.homepage} target="_blank" rel="noreferrer">{s.name}</a></h2>
              <Pill tone={TONE[s.status] ?? "muted"}>{s.status_label}</Pill>
            </div>
            <p className="small">{s.detail}{s.checked_at && <span className="muted"> · checked {ago(s.checked_at)}</span>}</p>
            {s.requires.length > 0 && <p className="muted small">Needs: {s.requires.join(", ")} {s.configured ? "(present)" : "(missing)"}</p>}
            <table className="tbl small">
              <thead><tr><th>Product</th><th>What</th><th>Coverage</th><th>Resolution</th><th>Latency</th><th>Limitations</th></tr></thead>
              <tbody>
                {s.capabilities.map((c) => (
                  <tr key={c.product}><td><code>{c.product}</code></td><td>{c.description}</td><td>{c.temporal}</td>
                    <td>{c.resolution_m ? `${c.resolution_m >= 1000 ? `${c.resolution_m / 1000} km` : `${c.resolution_m} m`}` : "–"}</td><td>{c.latency}</td><td>{c.limitations}</td></tr>
                ))}
              </tbody>
            </table>
            {s.steps.length > 0 && (
              <details>
                <summary className="small">Last check ({s.steps.filter((x) => x.ok).length}/{s.steps.length} steps passed)</summary>
                <ul className="small">
                  {s.steps.map((st) => (
                    <li key={st.step} className={st.ok ? "" : "error-text"}>{st.ok ? "✓" : "✕"} {st.step} ({st.seconds}s){!st.ok && st.error ? ` — ${st.error.message ?? JSON.stringify(st.error)}` : ""}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        ))}
      </div>

      <section className="card">
        <h2>Freshness for an area</h2>
        <p className="muted small">The newest acquisition each source has for the area. Satellite data are never instant: Sentinel-1 passes every 6–12 days, Sentinel-2 every ~5 days (cloud permitting), FIRMS within ~3 hours of an overpass.</p>
        <div className="row-actions">
          {regions.data && <RegionPicker regions={regions.data.filter((r) => !r.simulated)} value={regionId} onChange={setRegionId} label="Area" />}
          <button className="btn" disabled={act.busy === "fresh"} onClick={() => void act.run("fresh", async () => {
            setFresh(await api<Freshness>(`/api/regions/${encodeURIComponent(regionId)}/freshness`));
          })}>{act.busy === "fresh" ? "Checking…" : "Check freshness"}</button>
        </div>
        {fresh && (
          <table className="tbl">
            <thead><tr><th>Product</th><th>Source</th><th>Newest available</th></tr></thead>
            <tbody>
              {fresh.items.map((i) => (
                <tr key={i.product}><td>{i.product}</td><td>{i.source}</td>
                  <td>{i.error ? <span className="error-text small">{i.error}</span> : i.latest ? <>{fmtDate(i.latest)} <span className="muted small">({ago(i.latest)})</span></> : <span className="muted">{i.note ?? "none found"}</span>}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Page>
  );
}
