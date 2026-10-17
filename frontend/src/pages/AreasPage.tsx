import "leaflet/dist/leaflet.css";
import { useState } from "react";
import { CircleMarker, MapContainer, Polygon, Polyline, useMapEvents } from "react-leaflet";
import { BaseLayers } from "../components/BaseLayers";
import { cssVar, useTheme } from "../theme";
import { Link } from "react-router-dom";
import { del, post } from "../api";
import { RegionPicker } from "../components/RegionPicker";
import type { AOI, Region } from "../types";
import { Empty, ErrorNote, Page, Pill, useAction, useData } from "./common";

type Mode = "district" | "draw" | "upload";

export function AreasPage() {
  const aois = useData<AOI[]>("/api/aois");
  const regions = useData<Region[]>("/api/regions");
  useTheme(); // re-render on theme change so the drawn shape picks up the new accent colour
  const [mode, setMode] = useState<Mode>("district");
  const [regionId, setRegionId] = useState("");
  const [name, setName] = useState("");
  const [pts, setPts] = useState<[number, number][]>([]);
  const [uploaded, setUploaded] = useState<any>(null);
  const act = useAction();

  const districts = (regions.data ?? []).filter((r) => r.kind !== "custom");

  const save = () => act.run("save", async () => {
    let body: Record<string, unknown>;
    if (mode === "district") {
      if (!regionId) throw new Error("Pick a district first.");
      body = { regionId, name: name || undefined };
    } else if (mode === "draw") {
      if (pts.length < 3) throw new Error("Click at least three points on the map to outline the area.");
      const ring = [...pts.map(([lat, lon]) => [lon, lat]), [pts[0][1], pts[0][0]]];
      body = { name: name || "Drawn area", geometry: { type: "Polygon", coordinates: [ring] } };
    } else {
      if (!uploaded) throw new Error("Choose a GeoJSON or KML file first.");
      body = { name: name || "Uploaded area", geometry: uploaded };
    }
    await post("/api/aois", body);
    setName(""); setPts([]); setUploaded(null); setRegionId("");
    await aois.reload();
    return "Area saved.";
  });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    act.setError(null);
    try {
      const text = await f.text();
      const g = f.name.toLowerCase().endsWith(".kml") ? kmlToGeoJSON(text) : JSON.parse(text);
      if (!g) throw new Error("No polygon found in the KML file.");
      setUploaded(g);
      if (!name) setName(f.name.replace(/\.(geo)?json$|\.kml$/i, ""));
    } catch (e) {
      act.setError(`Could not read ${f.name}: ${(e as Error).message}`);
    }
  };

  return (
    <Page title="Areas of interest" lead="Saved districts and your own boundaries. Monitors and reports are built on these.">
      <ErrorNote error={aois.error ?? regions.error} />
      <section className="card">
        <h2>Add an area</h2>
        <div className="seg" role="tablist" aria-label="How to add the area">
          {(["district", "draw", "upload"] as Mode[]).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
              {{ district: "Indian district", draw: "Draw on map", upload: "Upload GeoJSON / KML" }[m]}
            </button>
          ))}
        </div>
        <div className="form-grid">
          {mode === "district" && <RegionPicker regions={districts} value={regionId} onChange={setRegionId} label="District" />}
          <label className="field">
            <span>Name {mode === "district" && <span className="muted">(optional)</span>}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={mode === "district" ? "defaults to the district name" : "e.g. Beki river embankment"} maxLength={120} />
          </label>
          {mode === "upload" && (
            <label className="field">
              <span>File</span>
              <input type="file" accept=".geojson,.json,.kml,application/geo+json,application/vnd.google-earth.kml+xml" onChange={(e) => void onFile(e.target.files?.[0])} />
              {uploaded && <span className="muted small">Loaded {uploaded.type}{uploaded.features ? ` with ${uploaded.features.length} feature(s)` : ""}.</span>}
            </label>
          )}
        </div>
        {mode === "draw" && (
          <>
            <p className="muted small">Click on the map to add corners; the outline closes automatically. Areas up to 120,000 km².</p>
            <div className="draw-map">
              <MapContainer center={[26.3, 91.0]} zoom={8} className="map">
                <BaseLayers />
                <Clicker onClick={(p) => setPts((x) => [...x, p])} />
                {pts.length >= 3 ? <Polygon positions={pts} pathOptions={{ color: cssVar("--water") }} /> : pts.length === 2 ? <Polyline positions={pts} /> : null}
                {pts.map((p, i) => <CircleMarker key={i} center={p} radius={4} pathOptions={{ color: cssVar("--water-deep") }} />)}
              </MapContainer>
            </div>
            <div className="row-actions">
              <button className="btn" onClick={() => setPts((x) => x.slice(0, -1))} disabled={!pts.length}>Undo last point</button>
              <button className="btn" onClick={() => setPts([])} disabled={!pts.length}>Clear</button>
              <span className="muted small">{pts.length} point(s)</span>
            </div>
          </>
        )}
        <div className="row-actions">
          <button className="btn btn-primary btn-inline" onClick={() => void save()} disabled={act.busy === "save"}>{act.busy === "save" ? "Saving…" : "Save area"}</button>
        </div>
        <ErrorNote error={act.error} />
        {act.message && <p className="notice notice-ok">{act.message}</p>}
      </section>

      <section className="card">
        <h2>Your areas</h2>
        {aois.data && aois.data.length === 0 && <Empty title="No areas yet">Add a district above to start monitoring it.</Empty>}
        {aois.data && aois.data.length > 0 && (
          <table className="tbl">
            <thead><tr><th>Name</th><th>Type</th><th>State</th><th className="num">Area (km²)</th><th /></tr></thead>
            <tbody>
              {aois.data.map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.name}</strong></td>
                  <td><Pill tone={a.kind === "demo" ? "warn" : "info"}>{a.kind === "demo" ? "simulated" : a.kind}</Pill></td>
                  <td>{a.state || "–"}</td>
                  <td className="num">{a.areaKm2 ? Math.round(a.areaKm2).toLocaleString("en-IN") : "–"}</td>
                  <td className="row-actions">
                    <Link className="btn btn-small" to={`/app?region=${encodeURIComponent(a.regionId)}`}>Explore</Link>
                    <Link className="btn btn-small" to={`/app/monitors?aoi=${a.id}`}>Monitor</Link>
                    <button className="btn btn-small btn-danger" onClick={() => void act.run(`del-${a.id}`, async () => {
                      if (!confirm(`Delete “${a.name}”?`)) return;
                      await del(`/api/aois/${a.id}`);
                      await aois.reload();
                    })}>Delete</button>
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

function Clicker({ onClick }: { onClick: (p: [number, number]) => void }) {
  useMapEvents({ click: (e) => onClick([e.latlng.lat, e.latlng.lng]) });
  return null;
}

/** Minimal KML → GeoJSON: every <Polygon> outer boundary becomes one polygon. */
export function kmlToGeoJSON(text: string): any | null {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const polys = [...doc.getElementsByTagName("Polygon")].map((p) => {
    const outer = p.getElementsByTagName("outerBoundaryIs")[0] ?? p;
    const coords = outer.getElementsByTagName("coordinates")[0]?.textContent ?? "";
    const ring = coords.trim().split(/\s+/).map((t) => t.split(",").slice(0, 2).map(Number)).filter((c) => c.length === 2 && c.every(Number.isFinite));
    return ring.length >= 4 ? [ring] : null;
  }).filter(Boolean) as number[][][][];
  if (!polys.length) return null;
  return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
}
