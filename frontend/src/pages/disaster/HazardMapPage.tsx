import { useCallback, useEffect, useState } from "react";
import type { Map as LeafletMap } from "leaflet";
import { api } from "../../api";
import { ErrorNote, Page, Pill, useAction } from "../common";
import { age, heat, HazardCells, MapFrame, type HazardGrid } from "./shared";

const STATE_TONE: Record<string, "ok" | "warn" | "error" | "muted"> = { ok: "ok", no_data: "muted", not_configured: "warn", error: "error", timeout: "warn" };

/** The "virtual constellation": independent hazard sources on one grid, each with its real freshness. */
export function HazardMapPage() {
  const [grid, setGrid] = useState<HazardGrid | null>(null);
  const [layer, setLayer] = useState("combined");
  const [map, setMap] = useState<LeafletMap | null>(null);
  const act = useAction();
  useEffect(() => { void api<HazardGrid>("/api/hazard/latest").then((g) => { if (g.cells.length) setGrid(g); }).catch(() => undefined); }, []);
  const onReady = useCallback((m: LeafletMap) => setMap(m), []);

  const load = () => act.run("load", async () => {
    if (!map) return;
    const b = map.getBounds();
    const w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
    if (e - w > 2 || n - s > 2) throw new Error("Zoom in: the view must be at most 2 degrees across (about 200 km).");
    const cell = Math.max(0.01, Math.min(0.1, Math.round(Math.max(e - w, n - s) / 30 * 100) / 100));
    setGrid(await api<HazardGrid>(`/api/hazard?bbox=${[w, s, e, n].map((v) => v.toFixed(4)).join(",")}&cell=${cell}&days=3`));
  });

  const okLayers = (grid?.sources ?? []).filter((s) => s.state === "ok").map((s) => s.id);
  const bounds = grid?.bbox ? [[grid.bbox[1], grid.bbox[0]], [grid.bbox[3], grid.bbox[2]]] as [[number, number], [number, number]] : undefined;
  return (
    <Page title="Hazard map" lead="Fires, rainfall, flood and river forecasts from several independent satellites and models, on one grid. Each source shows when it last observed; none is continuous."
      actions={<button className="btn btn-primary" disabled={!!act.busy} onClick={() => void load()}>{act.busy ? "Loading sources… (up to 2 min)" : "Load hazard for this view"}</button>}>
      <ErrorNote error={act.error} />
      <div className="row-actions">
        <div className="seg" role="group" aria-label="Colour by">
          {["combined", ...okLayers].map((k) => <button key={k} className={layer === k ? "active" : ""} onClick={() => setLayer(k)}>{k === "combined" ? "Combined score" : k.replace(/_/g, " ")}</button>)}
        </div>
        <span className="small legend-row"><span className="legend-swatch" style={{ background: heat(0.2) }} /> low <span className="legend-swatch" style={{ background: heat(0.6) }} /> medium <span className="legend-swatch" style={{ background: heat(1) }} /> high</span>
      </div>
      <section className="card">
        <MapFrame height={480} bounds={bounds} onReady={onReady}>{grid && <HazardCells cells={grid.cells} layer={layer} />}</MapFrame>
      </section>
      {grid && (
        <section className="card">
          <h2>Sources</h2>
          <div className="table-scroll">
            <table className="tbl">
              <thead><tr><th>Source</th><th>State</th><th>Last observed</th><th>Age</th><th>Delay after observation</th><th>Note</th></tr></thead>
              <tbody>
                {grid.sources.map((s) => (
                  <tr key={s.id}>
                    <td><strong>{s.name}</strong>{s.kind === "forecast" && <div><Pill tone="info">model forecast</Pill></div>}</td>
                    <td><Pill tone={STATE_TONE[s.state] ?? "muted"}>{s.state.replace(/_/g, " ")}</Pill></td>
                    <td className="small">{s.observed_at ? new Date(s.observed_at).toLocaleString() : "–"}</td>
                    <td>{s.observed_at ? age(s.age_s) : "–"}</td>
                    <td>{s.latency_s != null ? age(s.latency_s) : "–"}</td>
                    <td className="small">{s.note}{s.area_level ? " (one value for the whole view)" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {grid.score_doc && <p className="muted small">{grid.score_doc}</p>}
        </section>
      )}
    </Page>
  );
}
