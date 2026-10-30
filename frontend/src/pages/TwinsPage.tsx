import "leaflet/dist/leaflet.css";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { CircleMarker, GeoJSON, MapContainer, Polyline, useMap, useMapEvents } from "react-leaflet";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, api, del, patch, post } from "../api";
import { BaseLayers } from "../components/BaseLayers";
import { RegionPicker } from "../components/RegionPicker";
import type { TerrainData } from "../components/three/TwinTerrain";
import { fmt, fmtDate } from "../format";
import { cssVar, useTheme } from "../theme";
import type { Region } from "../types";
import { Empty, ErrorNote, Page, Pill, useData } from "./common";

const TwinTerrain = lazy(() => import("../components/three/TwinTerrain"));

const ASSET_TYPES = ["bridge", "road", "building", "embankment", "dam", "other"];
const RECORD_TYPES: Record<string, string> = { inspection: "Inspection", damage: "Damage report", maintenance: "Maintenance", sensor: "Sensor reading", design: "Design information", note: "Note" };
const ATTRIBUTES: [string, string][] = [["constructionYear", "Construction year"], ["structure", "Structure type"], ["material", "Material"], ["operator", "Owner or operator"], ["lengthM", "Length (m)"], ["lanes", "Lanes"], ["maxWeight", "Load limit"], ["surface", "Surface"]];
const CONF_TEXT: Record<string, string> = { high: "high confidence", probable: "probable", detected: "detected", uncertain: "uncertain", not_detected: "nothing detected" };

interface TwinRecord { id: string; type: string; date: string; title: string; notes: string; value: number | null; unit: string; author: string }
interface Twin { id: string; name: string; assetType: string; geometry: GeoJSON.Geometry; osmId: string | null; attributes: Record<string, string>; records: TwinRecord[]; createdAt: string }
interface Candidate { osmId: string; name: string; assetType: string; geometry: GeoJSON.Geometry; attributes: Record<string, string> }
interface Observation {
  detection_id: string; kind: string; label: string; noun: string; before: string; after: string; confidence: string; quality_flags: string[]; resolution_m: number;
  touches_asset: boolean; overlap_share: number; patches_truncated: boolean;
  reading: { pixels: number; measured_pixels: number; median_mm: number | null; low_mm: number | null; high_mm: number | null } | null;
  change: { newly_touches_asset: boolean; no_longer_touches_asset: boolean; median_mm_change: number | null } | null;
}
interface Detail { twin: Twin; observations: Observation[]; observationsError: string | null }

function FitTo({ bounds }: { bounds: [[number, number], [number, number]] | null }) {
  const map = useMap();
  useEffect(() => { if (bounds) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 }); }, [bounds, map]);
  return null;
}

function Clicks({ onClick }: { onClick(lat: number, lon: number): void }) {
  useMapEvents({ click: (e) => onClick(e.latlng.lat, e.latlng.lng) });
  return null;
}

export function TwinsPage() {
  const [params, setParams] = useSearchParams();
  const twins = useData<Twin[]>("/api/twins");
  const openId = params.get("open");
  return (
    <Page title="Digital twins" lead="One real structure, with its records and everything satellites have seen there. Start with a single bridge, road segment or building.">
      <ErrorNote error={twins.error} />
      {openId
        ? <TwinDetail key={openId} id={openId} onClose={() => setParams({})} onChanged={() => void twins.reload()} />
        : <NewTwin onCreated={(t) => { void twins.reload(); setParams({ open: t.id }); }} />}
      <section className="card">
        <h2>Your assets</h2>
        {twins.data?.length === 0 && <Empty title="No assets yet">Find one on the map above.</Empty>}
        {!!twins.data?.length && (
          <table className="tbl">
            <thead><tr><th>Name</th><th>Type</th><th className="num">Records</th><th /></tr></thead>
            <tbody>
              {twins.data.map((t) => (
                <tr key={t.id} aria-selected={t.id === openId}>
                  <td><strong>{t.name}</strong></td>
                  <td>{t.assetType}</td>
                  <td className="num">{t.records.length}</td>
                  <td className="row-actions"><button className="btn btn-small" onClick={() => setParams({ open: t.id })}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Page>
  );
}

function NewTwin({ onCreated }: { onCreated(t: Twin): void }) {
  useTheme();
  const regions = useData<Region[]>("/api/regions");
  const [regionId, setRegionId] = useState("");
  const [mode, setMode] = useState<"find" | "draw">("find");
  const [point, setPoint] = useState<[number, number] | null>(null);
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [pts, setPts] = useState<[number, number][]>([]);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [name, setName] = useState("");
  const [assetType, setAssetType] = useState("bridge");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const live = useMemo(() => (regions.data ?? []).filter((r) => !r.simulated), [regions.data]);
  const region = live.find((r) => r.id === regionId);
  const bounds = useMemo<[[number, number], [number, number]] | null>(() => (region ? [[region.bbox[1], region.bbox[0]], [region.bbox[3], region.bbox[2]]] : null), [region]);

  const click = async (lat: number, lon: number) => {
    setError(null);
    if (mode === "draw") { setPts((p) => [...p, [lat, lon]]); return; }
    setPoint([lat, lon]);
    setPicked(null);
    setFound(null);
    setSearching(true);
    try {
      setFound(await api<Candidate[]>(`/api/twins/osm?lat=${lat}&lon=${lon}&radius=500`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const pick = (c: Candidate) => { setPicked(c); setName(c.name); setAssetType(c.assetType); };

  const geometry: GeoJSON.Geometry | null = picked?.geometry ?? (mode === "draw" && pts.length
    ? (pts.length === 1 ? { type: "Point", coordinates: [pts[0][1], pts[0][0]] } : { type: "LineString", coordinates: pts.map(([a, o]) => [o, a]) })
    : null);

  const create = async () => {
    if (!geometry) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await post<Twin>("/api/twins", { name, assetType, geometry, osmId: picked?.osmId, attributes: picked?.attributes ?? {} }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Add an asset</h2>
      <div className="form-grid">
        <RegionPicker regions={live} value={regionId} onChange={setRegionId} label="Go to a district" />
        <div className="field"><span>How to choose it</span>
          <div className="seg" role="group" aria-label="How to choose the asset">
            <button className={mode === "find" ? "active" : ""} aria-pressed={mode === "find"} onClick={() => { setMode("find"); setPts([]); }}>Find in OpenStreetMap</button>
            <button className={mode === "draw" ? "active" : ""} aria-pressed={mode === "draw"} onClick={() => { setMode("draw"); setPicked(null); setFound(null); setPoint(null); }}>Draw it</button>
          </div>
        </div>
      </div>
      <p className="muted small">{mode === "find" ? "Zoom in and click near the structure to list what is mapped within 500 m." : "Click once for a point, or several times to trace a line."}</p>
      <div className="twin-pick">
        <div className="draw-map">
          <MapContainer center={[22.5, 79]} zoom={5} className="map">
            <BaseLayers />
            <FitTo bounds={bounds} />
            <Clicks onClick={(a, o) => void click(a, o)} />
            {point && <CircleMarker center={point} radius={5} pathOptions={{ color: cssVar("--water-deep") }} />}
            {picked && <GeoJSON key={picked.osmId} data={picked.geometry} style={{ color: cssVar("--error"), weight: 4 }} />}
            {mode === "draw" && pts.length > 1 && <Polyline positions={pts} pathOptions={{ color: cssVar("--error"), weight: 4 }} />}
            {mode === "draw" && pts.map((p, i) => <CircleMarker key={i} center={p} radius={4} pathOptions={{ color: cssVar("--water-deep") }} />)}
          </MapContainer>
        </div>
        {mode === "find" && (
          <div className="twin-candidates">
            {searching && <p className="muted small">Asking OpenStreetMap, up to a minute on a busy day…</p>}
            {found?.length === 0 && <p className="muted small">Nothing mapped within 500 m. Try another spot, or draw it.</p>}
            {!!found?.length && (
              <ul>
                {found.map((c) => (
                  <li key={c.osmId}><button className={`menu-item ${picked?.osmId === c.osmId ? "active" : ""}`} aria-pressed={picked?.osmId === c.osmId} onClick={() => pick(c)}>
                    <strong>{c.name || `Unnamed ${c.assetType}`}</strong> <span className="muted small">{c.assetType}</span>
                  </button></li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {mode === "draw" && <div className="row-actions"><button className="btn btn-small" disabled={!pts.length} onClick={() => setPts((p) => p.slice(0, -1))}>Undo last point</button></div>}
      <div className="form-grid">
        <label className="field"><span>Name</span><input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Saraighat Bridge" /></label>
        <label className="field"><span>Type</span><select value={assetType} onChange={(e) => setAssetType(e.target.value)}>{ASSET_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
      </div>
      <div className="row-actions"><button className="btn btn-primary btn-inline" disabled={!geometry || !name.trim() || busy} onClick={() => void create()}>{busy ? "Creating…" : "Create twin"}</button></div>
      <ErrorNote error={error} />
    </section>
  );
}

function TwinDetail({ id, onClose, onChanged }: { id: string; onClose(): void; onChanged(): void }) {
  const detail = useData<Detail>(`/api/twins/${id}`);
  const t = detail.data?.twin;
  if (detail.error) return <ErrorNote error={detail.error} />;
  if (!t) return <p className="muted">Loading…</p>;
  const remove = async () => {
    if (!confirm(`Delete the twin “${t.name}” and its records?`)) return;
    await del(`/api/twins/${t.id}`);
    onChanged();
    onClose();
  };
  return (
    <>
      <section className="card">
        <div className="ev-head">
          <h2>{t.name} <span className="muted small">{t.assetType}</span></h2>
          <div className="row-actions">
            <button className="btn btn-small" onClick={onClose}>Add another</button>
            <button className="btn btn-small btn-danger" onClick={() => void remove()}>Delete</button>
          </div>
        </div>
        <p className="muted small">A record of this asset joined with satellite observations, on measured terrain. It does not simulate how the structure behaves, and it has no live sensors unless readings are entered below.</p>
        <Terrain twin={t} observations={detail.data!.observations} />
      </section>
      <div className="twin-columns">
        <Attributes twin={t} onSaved={() => { void detail.reload(); onChanged(); }} />
        <AddRecord twin={t} onSaved={() => { void detail.reload(); onChanged(); }} />
      </div>
      <Timeline detail={detail.data!} onChange={() => { void detail.reload(); onChanged(); }} />
    </>
  );
}

function Terrain({ twin, observations }: { twin: Twin; observations: Observation[] }) {
  const { mode } = useTheme();
  const [data, setData] = useState<TerrainData & { satellite_date?: string | null; satellite_note?: string | null; source?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exaggeration, setExaggeration] = useState(2);
  const [busy, setBusy] = useState(false);
  const deformation = observations.filter((o) => o.kind === "ground_deformation");
  const [overlayId, setOverlayId] = useState("");

  const load = async (detectionId: string) => {
    setBusy(true);
    setError(null);
    try {
      setData(await post(`/api/twins/${twin.id}/terrain`, detectionId ? { detectionId } : {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void load(""); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [twin.id]);

  const assetColor = useMemo(() => cssVar("--error"), [mode]);
  return (
    <div className="twin-3d">
      <div className="row-actions">
        <label className="field twin-inline"><span>Height exaggeration: {exaggeration}×</span>
          <input type="range" min={1} max={8} value={exaggeration} onChange={(e) => setExaggeration(Number(e.target.value))} /></label>
        {deformation.length > 0 && (
          <label className="field twin-inline"><span>Colour the ground by</span>
            <select value={overlayId} disabled={busy} onChange={(e) => { setOverlayId(e.target.value); void load(e.target.value); }}>
              <option value="">Satellite image</option>
              {deformation.map((o) => <option key={o.detection_id} value={o.detection_id}>Movement {fmtDate(o.before, false)} → {fmtDate(o.after, false)}</option>)}
            </select></label>
        )}
      </div>
      <ErrorNote error={error} />
      <div className="twin-stage">
        {busy && <p className="muted small twin-status">Building the terrain. The first time takes up to a minute…</p>}
        {data && <Suspense fallback={null}><TwinTerrain data={data} exaggeration={exaggeration} showDisplacement={!!overlayId} assetColor={assetColor} /></Suspense>}
      </div>
      {data && (
        <p className="muted small">
          Drag to rotate, scroll to zoom. Terrain: {data.source} at {data.res_m} m, {fmt(data.min_m, 0)} to {fmt(data.max_m, 0)} m. {data.satellite_date ? `Image: Sentinel-2, ${fmtDate(data.satellite_date, false)}.` : data.satellite_note ? `No image: ${data.satellite_note}` : ""}
          {" "}The red line marks where the asset is. Its shape and height are not modelled.{overlayId && " Teal: toward the satellite. Brown: away from it."}
        </p>
      )}
    </div>
  );
}

function Attributes({ twin, onSaved }: { twin: Twin; onSaved(): void }) {
  const [values, setValues] = useState<Record<string, string>>(twin.attributes);
  const [state, setState] = useState<string | null>(null);
  const save = async () => {
    setState("Saving…");
    try {
      const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
      await patch(`/api/twins/${twin.id}`, { attributes: clean });
      setState("Saved.");
      onSaved();
    } catch (e) {
      setState((e as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Asset information</h2>
      {twin.osmId && <p className="muted small">Started from OpenStreetMap <a href={`https://www.openstreetmap.org/${twin.osmId}`} target="_blank" rel="noreferrer">{twin.osmId}</a>. Check these values against official records.</p>}
      <div className="form-grid">
        {ATTRIBUTES.map(([k, label]) => (
          <label className="field" key={k}><span>{label}</span><input value={values[k] ?? ""} maxLength={300} onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))} /></label>
        ))}
      </div>
      <div className="row-actions"><button className="btn btn-inline" onClick={() => void save()}>Save information</button>{state && <span className="muted small" role="status">{state}</span>}</div>
    </section>
  );
}

function AddRecord({ twin, onSaved }: { twin: Twin; onSaved(): void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [type, setType] = useState("inspection");
  const [date, setDate] = useState(today);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      const v = parseFloat(value);
      await post(`/api/twins/${twin.id}/records`, { type, date, title, notes, ...(type === "sensor" && Number.isFinite(v) ? { value: v, unit } : {}) });
      setTitle(""); setNotes(""); setValue(""); setUnit("");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Add a record</h2>
      <div className="form-grid">
        <label className="field"><span>Type</span><select value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(RECORD_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="field"><span>Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div>
      <label className="field"><span>Title</span><input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Annual inspection, pier 3" /></label>
      {type === "sensor" && (
        <div className="form-grid">
          <label className="field"><span>Reading</span><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></label>
          <label className="field"><span>Unit</span><input value={unit} maxLength={30} onChange={(e) => setUnit(e.target.value)} placeholder="e.g. mm" /></label>
        </div>
      )}
      <label className="field"><span>Notes</span><textarea value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} /></label>
      <div className="row-actions"><button className="btn btn-inline" disabled={!title.trim() || !date} onClick={() => void add()}>Add record</button></div>
      <ErrorNote error={error} />
    </section>
  );
}

type Entry = { key: string; date: string; record?: TwinRecord; obs?: Observation };

function Timeline({ detail, onChange }: { detail: Detail; onChange(): void }) {
  const { twin, observations } = detail;
  const entries = useMemo<Entry[]>(() => [
    ...twin.records.map((r) => ({ key: r.id, date: r.date, record: r })),
    ...observations.map((o) => ({ key: o.detection_id, date: (o.after ?? "").slice(0, 10), obs: o })),
  ].sort((a, b) => b.date.localeCompare(a.date)), [twin.records, observations]);
  return (
    <section className="card">
      <h2>History</h2>
      <p className="muted small">Newest first. Satellite entries come from your analyses that cover this asset. <Link to="/app/detect">Run another analysis</Link> to add one.</p>
      <ErrorNote error={detail.observationsError} />
      {entries.length === 0 && <Empty title="Nothing yet">Add a record, or run a change-detection or ground-movement analysis over this area.</Empty>}
      <ol className="twin-timeline">
        {entries.map((e) => (
          <li key={e.key}>
            <span className="muted small twin-date">{fmtDate(e.date, false)}</span>
            {e.record ? <RecordEntry record={e.record} twinId={twin.id} onChange={onChange} /> : <ObservationEntry obs={e.obs!} />}
          </li>
        ))}
      </ol>
    </section>
  );
}

function RecordEntry({ record: r, twinId, onChange }: { record: TwinRecord; twinId: string; onChange(): void }) {
  return (
    <div>
      <div className="row-actions"><Pill tone={r.type === "damage" ? "error" : "muted"}>{RECORD_TYPES[r.type] ?? r.type}</Pill><strong>{r.title}</strong></div>
      {r.value !== null && <p className="small">Reading: {r.value} {r.unit}</p>}
      {r.notes && <p className="small">{r.notes}</p>}
      <p className="muted small">Entered by {r.author}. <button className="link-btn" onClick={() => void del(`/api/twins/${twinId}/records/${r.id}`).then(onChange)}>Remove</button></p>
    </div>
  );
}

function ObservationEntry({ obs: o }: { obs: Observation }) {
  const c = o.change;
  const reading = o.reading;
  return (
    <div>
      <div className="row-actions"><Pill tone="info">Satellite</Pill><Link to={`/app/detect?open=${o.detection_id}`}><strong>{o.label}</strong></Link></div>
      <p className="small">{fmtDate(o.before, false)} → {fmtDate(o.after, false)}, {CONF_TEXT[o.confidence] ?? o.confidence}, {o.resolution_m} m per pixel.</p>
      {o.kind === "ground_deformation" && reading && (reading.measured_pixels > 0
        ? <p className="small"><strong>{fmt(reading.median_mm, 0)} mm</strong> median along the line of sight at the asset (from {fmt(reading.low_mm, 0)} to {fmt(reading.high_mm, 0)} mm, {reading.measured_pixels} of {reading.pixels} pixels measured). Relative to the surrounding ground.</p>
        : <p className="small muted">No measurement at the asset: coherence was too low there. This does not mean there was no movement.</p>)}
      <p className="small">{o.touches_asset ? `Detected ${o.noun} touches the asset (${Math.round(o.overlap_share * 100)}% of the area within 100 m).` : `No ${o.noun} detected at the asset.`}{o.patches_truncated && !o.touches_asset && " Only the largest patches of this analysis were kept, so a small one could be missing."}</p>
      {c && (c.newly_touches_asset || c.no_longer_touches_asset || c.median_mm_change !== null) && (
        <p className="small"><strong>Since the previous {o.label.toLowerCase()} analysis:</strong> {c.newly_touches_asset ? "the detection now reaches the asset." : c.no_longer_touches_asset ? "the detection no longer reaches the asset." : `median reading changed by ${fmt(c.median_mm_change, 0)} mm. Each pair has its own reference, so treat this as a prompt to look, not a measured rate.`}</p>
      )}
      {o.quality_flags.length > 0 && <p className="muted small">{o.quality_flags.join(" ")}</p>}
    </div>
  );
}
