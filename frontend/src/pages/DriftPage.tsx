import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleMarker, MapContainer, Polygon, Polyline, useMapEvents } from "react-leaflet";
import { BaseLayers } from "../components/BaseLayers";
import { fmt } from "../format";
import {
  bedCriticalSpeed, createRun, DEFAULT_PARAMS, MOVED_THRESHOLD_M, OBJECT_PRESETS, powerCurve, RECORD_UNCERTAINTY_M, requiredPowerW, runChunk,
  SNAPSHOTS, summarise, uuvLimitSpeed, type ObjectKind, type Params, type Run, type Summary,
} from "../sim/drift";
import { cssVar, useTheme } from "../theme";
import { Page, Pill } from "./common";

type LatLng = [number, number];
type Mode = "release" | "channel";

const START: LatLng = [26.3, 91.0];
const M_PER_DEG_LAT = 110540;
const mPerDegLon = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
const CHUNK = 100;

const KINDS: { id: ObjectKind; label: string; short: string }[] = [
  { id: "bed", label: "A. Bed-resting object (mine-like surrogate)", short: "Bed-resting object" },
  { id: "floating", label: "B. Floating object", short: "Floating object" },
  { id: "uuv", label: "C. Neutrally buoyant vehicle (UUV)", short: "Neutrally buoyant vehicle" },
];

const toLocal = (origin: LatLng, p: LatLng) => ({ x: (p[1] - origin[1]) * mPerDegLon(origin[0]), y: (p[0] - origin[0]) * M_PER_DEG_LAT });
const toLatLng = (origin: LatLng, x: number, y: number): LatLng => [origin[0] + y / M_PER_DEG_LAT, origin[1] + x / mPerDegLon(origin[0])];

/** The channel the flow runs along, as a point and bearing in metres from the release point. Default: 50 m south, flowing east. */
function channelFor(release: LatLng, drawn: LatLng[]): { line: [LatLng, LatLng]; x: number; y: number; bearingDeg: number } {
  const [a, b] = drawn.length === 2 ? drawn : [toLatLng(release, -3000, -50), toLatLng(release, 3000, -50)];
  const la = toLocal(release, a), lb = toLocal(release, b);
  const bearing = (Math.atan2(lb.x - la.x, lb.y - la.y) * 180) / Math.PI;
  return { line: [a, b], x: la.x, y: la.y, bearingDeg: (bearing + 360) % 360 };
}

function Clicks({ onClick }: { onClick(p: LatLng): void }) {
  useMapEvents({ click: (e) => onClick([e.latlng.lat, e.latlng.lng]) });
  return null;
}

function Slider({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange(v: number): void }) {
  return (
    <label className="field"><span>{label}: {fmt(value, step < 1 ? 2 : 0)} {unit}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} /></label>
  );
}

/** Runs particles a chunk at a time so the page never freezes; null if a newer run replaced this one. */
async function runAsync(params: Params, seed: number, alive: () => boolean, progress?: (done: number, n: number) => void): Promise<{ run: Run; summary: Summary } | null> {
  const run = createRun(params);
  for (let i = 0; i < run.n; i += CHUNK) {
    runChunk(run, seed, i, i + CHUNK);
    progress?.(Math.min(i + CHUNK, run.n), run.n);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));      // lets the page paint between chunks; unlike an animation frame it also runs in a background tab
    if (!alive()) return null;
  }
  return { run, summary: summarise(run) };
}

interface Outcome { run: Run; summary: Summary; release: LatLng; kind: ObjectKind }
interface Row { kind: ObjectKind; summary: Summary }

export function DriftPage() {
  const { mode: theme } = useTheme();
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [presetId, setPresetId] = useState("medium");
  const [release, setRelease] = useState<LatLng>(START);
  const [drawn, setDrawn] = useState<LatLng[]>([]);
  const [mode, setMode] = useState<Mode>("release");
  const [seed, setSeed] = useState(42);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [step, setStep] = useState(SNAPSHOTS);
  const [playing, setPlaying] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const token = useRef(0);

  const set = <K extends keyof Params>(key: K, value: Params[K]) => setParams((p) => ({ ...p, [key]: value }));
  const channel = useMemo(() => channelFor(release, drawn), [release, drawn]);
  const effective: Params = useMemo(() => ({ ...params, channel: { x: channel.x, y: channel.y, bearingDeg: channel.bearingDeg } }), [params, channel]);
  const colours = useMemo(() => ({
    water: cssVar("--water"), deep: cssVar("--water-deep"), error: cssVar("--error"), warn: cssVar("--warn"), violet: cssVar("--violet"), muted: cssVar("--muted"), rule: cssVar("--rule"),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [theme]);

  const critical = bedCriticalSpeed(params.sizeM, params.massKg, params.mu, params.cd);
  const uuvLimit = uuvLimitSpeed(params.uuvMaxPowerW, params.cd, params.uuvDiameterM);
  const uuvNeeded = requiredPowerW(params.peakFlow, params.cd, params.uuvDiameterM);

  const run = async () => {
    const mine = ++token.current;
    setRows(null);
    setPlaying(false);
    setBusy("Running…");
    const out = await runAsync(effective, seed, () => token.current === mine, (d, n) => setBusy(`Running… ${d} of ${n}`));
    if (!out) return;
    setOutcome({ ...out, release, kind: effective.kind });
    setStep(SNAPSHOTS);
    setBusy(null);
  };

  const compare = async () => {
    const mine = ++token.current;
    setPlaying(false);
    const done: Row[] = [];
    for (const k of KINDS) {
      setBusy(`Comparing… ${k.short}`);
      const out = await runAsync({ ...effective, kind: k.id }, seed, () => token.current === mine);
      if (!out) return;
      done.push({ kind: k.id, summary: out.summary });
    }
    setRows(done);
    setBusy(null);
  };

  // replay: step through the saved path over a few seconds
  useEffect(() => {
    if (!playing) return;
    const started = performance.now(), from = step;
    const timer = setInterval(() => {
      const next = from + ((performance.now() - started) / 6000) * SNAPSHOTS;
      if (next >= SNAPSHOTS) { setStep(SNAPSHOTS); setPlaying(false); } else setStep(next);
    }, 40);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const shown: LatLng[] = useMemo(() => {
    if (!outcome) return [];
    const { run: r, release: origin } = outcome;
    const every = Math.max(1, Math.ceil(r.n / 400));
    const at = Math.round(step);
    const out: LatLng[] = [];
    for (let i = 0; i < r.n; i += every) {
      const base = i * (SNAPSHOTS + 1) * 2 + at * 2;
      out.push(toLatLng(origin, r.trails[base], r.trails[base + 1]));
    }
    return out;
  }, [outcome, step]);

  const s = outcome?.summary;
  const kindShort = KINDS.find((k) => k.id === outcome?.kind)?.short ?? "";
  const stale = outcome && (outcome.kind !== effective.kind);

  return (
    <Page title="Drift Simulator" lead="Where could an object end up after a flood, and why can't a powered vehicle simply hold position against the same flow? A Monte Carlo what-if tool for the DriftSentinel idea.">
      <p className="notice notice-warn" role="note">
        <strong>Illustrative simulation.</strong> Parameters are assumptions, not calibrated to real mine or flood data. Not for operational demining.
        The flow field is set by you below. It is not measured by satellite here: real use would take the flood extent from Sentinel-1 and the flow from hydrodynamic models or gauges, which is not built yet.
      </p>

      <div className="twin-columns">
        <section className="card">
          <h2>Set up</h2>
          <div className="seg" role="group" aria-label="Object type">
            {KINDS.map((k) => <button key={k.id} className={params.kind === k.id ? "active" : ""} aria-pressed={params.kind === k.id} onClick={() => set("kind", k.id)}>{k.id === "bed" ? "A. Bed" : k.id === "floating" ? "B. Floating" : "C. UUV"}</button>)}
          </div>
          <p className="small"><strong>{KINDS.find((k) => k.id === params.kind)!.label}</strong></p>
          {params.kind === "bed" && (
            <>
              <label className="field"><span>Object</span>
                <select value={presetId} onChange={(e) => { const p = OBJECT_PRESETS.find((x) => x.id === e.target.value)!; setPresetId(p.id); setParams((q) => ({ ...q, sizeM: p.sizeM, massKg: p.massKg })); }}>
                  {OBJECT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select></label>
              <Slider label="Friction coefficient μ" value={params.mu} min={0.2} max={1.2} step={0.05} unit="" onChange={(v) => set("mu", v)} />
              <p className="muted small">It starts to slide when the near-bed flow exceeds about {fmt(critical, 2)} m/s (channel flow about {fmt(critical / 0.7, 2)} m/s).</p>
            </>
          )}
          {params.kind === "floating" && (
            <>
              <Slider label="Wind speed" value={params.windSpeed} min={0} max={20} step={1} unit="m/s" onChange={(v) => set("windSpeed", v)} />
              <Slider label="Wind blowing from" value={params.windFromDeg} min={0} max={359} step={1} unit="° from north" onChange={(v) => set("windFromDeg", v)} />
            </>
          )}
          {params.kind === "uuv" && (
            <>
              <Slider label="Maximum thrust power" value={params.uuvMaxPowerW} min={50} max={2000} step={50} unit="W" onChange={(v) => set("uuvMaxPowerW", v)} />
              <Slider label="Vehicle diameter" value={params.uuvDiameterM} min={0.1} max={1} step={0.05} unit="m" onChange={(v) => set("uuvDiameterM", v)} />
            </>
          )}
          <Slider label="Drag coefficient Cd" value={params.cd} min={0.3} max={2} step={0.05} unit="" onChange={(v) => set("cd", v)} />
          <h3>Flood</h3>
          <Slider label="Peak flow speed in the channel" value={params.peakFlow} min={0.2} max={5} step={0.1} unit="m/s" onChange={(v) => set("peakFlow", v)} />
          <Slider label="Flood duration" value={params.durationH} min={2} max={72} step={1} unit="h" onChange={(v) => set("durationH", v)} />
          <Slider label="Flow decay across the floodplain" value={params.decayLengthM} min={30} max={600} step={10} unit="m (1/e distance)" onChange={(v) => set("decayLengthM", v)} />
          <Slider label="Turbulence strength" value={params.turbulence} min={0} max={5} step={0.1} unit="m" onChange={(v) => set("turbulence", v)} />
          <h3>Monte Carlo</h3>
          <Slider label="Number of runs" value={params.runs} min={100} max={2000} step={100} unit="" onChange={(v) => set("runs", v)} />
          <Slider label="Parameter uncertainty (Cd, μ, size, mass)" value={params.paramSpreadPct} min={0} max={50} step={5} unit="% either way" onChange={(v) => set("paramSpreadPct", v)} />
          <Slider label="Flow uncertainty" value={params.flowSpreadPct} min={0} max={50} step={5} unit="% either way" onChange={(v) => set("flowSpreadPct", v)} />
          <label className="field"><span>Random seed (same seed, same result)</span>
            <input type="number" value={seed} onChange={(e) => setSeed(Math.trunc(Number(e.target.value)) || 0)} /></label>
          <h3>Area you would otherwise search</h3>
          <Slider label="Flooded reach length" value={params.reachLengthM} min={1000} max={20000} step={500} unit="m" onChange={(v) => set("reachLengthM", v)} />
          <Slider label="Flooded floodplain width" value={params.floodWidthM} min={200} max={6000} step={100} unit="m" onChange={(v) => set("floodWidthM", v)} />
        </section>

        <section className="card">
          <h2>Map</h2>
          <div className="seg" role="group" aria-label="What a map click does">
            <button className={mode === "release" ? "active" : ""} aria-pressed={mode === "release"} onClick={() => setMode("release")}>Set release point</button>
            <button className={mode === "channel" ? "active" : ""} aria-pressed={mode === "channel"} onClick={() => { setMode("channel"); setDrawn([]); }}>Draw channel line</button>
          </div>
          <p className="muted small">
            {mode === "release" ? "Click where the object sat before the flood." : `Click two points along the river, upstream first (${drawn.length} of 2). The flow runs from the first to the second.`}
            {drawn.length < 2 && " Until you draw one, the channel is a straight line 50 m south of the release point, flowing east."}
          </p>
          <div className="draw-map" style={{ height: 460 }}>
            <MapContainer center={START} zoom={11} className="map" preferCanvas>
              <BaseLayers />
              <Clicks onClick={(p) => { if (mode === "release") setRelease(p); else setDrawn((d) => (d.length >= 2 ? [p] : [...d, p])); }} />
              <Polyline positions={channel.line} pathOptions={{ color: colours.water, weight: 4, dashArray: drawn.length === 2 ? undefined : "8 6" }} />
              {drawn.map((p, i) => <CircleMarker key={i} center={p} radius={4} pathOptions={{ color: colours.deep }} />)}
              {s && outcome && <Polygon positions={s.zone90.points.map(([x, y]) => toLatLng(outcome.release, x, y))} pathOptions={{ color: colours.warn, weight: 2, fillOpacity: 0.12 }} />}
              {s && outcome && <Polygon positions={s.zone50.points.map(([x, y]) => toLatLng(outcome.release, x, y))} pathOptions={{ color: colours.error, weight: 2, fillOpacity: 0.18 }} />}
              {shown.map((p, i) => <CircleMarker key={i} center={p} radius={2} pathOptions={{ color: colours.violet, weight: 1, fillOpacity: 0.7 }} />)}
              <CircleMarker center={release} radius={7} pathOptions={{ color: colours.error, fillColor: colours.error, fillOpacity: 1 }} />
            </MapContainer>
          </div>
          <div className="row-actions">
            <button className="btn btn-primary btn-inline" disabled={!!busy} onClick={() => void run()}>Run simulation</button>
            <button className="btn btn-inline" disabled={!!busy} onClick={() => void compare()}>Compare object types</button>
            {busy && <span className="muted small" role="status">{busy}</span>}
          </div>
          {outcome && (
            <div className="row-actions">
              <button className="btn btn-small" onClick={() => { if (step >= SNAPSHOTS) setStep(0); setPlaying((v) => !v); }}>{playing ? "Pause" : "Replay the flood"}</button>
              <label className="field twin-inline"><span>Time into the flood: {fmt((Math.round(step) / SNAPSHOTS) * outcome.run.params.durationH, 1)} of {outcome.run.params.durationH} h</span>
                <input type="range" min={0} max={SNAPSHOTS} step={1} value={Math.round(step)} onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)); }} /></label>
            </div>
          )}
          <p className="muted small">Red dot: release point. Dots: where {outcome ? outcome.run.n : "the"} runs have got to. Red outline: the area holding the nearest 50% of outcomes; orange: 90%. Each zone is widened by {RECORD_UNCERTAINTY_M} m for the uncertainty in where the object really started.</p>
        </section>
      </div>

      <section className="card" aria-live="polite">
        <h2>Result {outcome && <Pill tone="info">{kindShort}</Pill>}</h2>
        {!s && <p className="muted">Click the map to place the release point, then press Run simulation.</p>}
        {stale && <p className="notice notice-warn">The settings changed since this run. Press Run simulation again.</p>}
        {s && (
          <>
            <p><strong>Moved in {s.movedCount} of {s.n} runs</strong> (more than {MOVED_THRESHOLD_M} m).</p>
            <table className="tbl">
              <tbody>
                <tr><th scope="row">Median drift distance</th><td>{fmt(s.medianM, 0)} m</td></tr>
                <tr><th scope="row">90th-percentile drift distance</th><td>{fmt(s.p90M, 0)} m</td></tr>
                <tr><th scope="row">Search area to cover 90% of outcomes</th><td>{fmt(s.zone90.areaHa, 1)} ha</td></tr>
                <tr><th scope="row">Search area to cover 50% of outcomes</th><td>{fmt(s.zone50.areaHa, 1)} ha</td></tr>
                <tr><th scope="row">Whole flooded floodplain you would otherwise search</th><td>{fmt(s.floodAreaHa, 0)} ha</td></tr>
                <tr><th scope="row">Reduction</th><td>{fmt(s.reductionHa, 0)} ha ({fmt(s.reductionPct, 0)}%)</td></tr>
              </tbody>
            </table>
            {s.movedCount < s.n / 2 && <p className="notice">In most runs the object did not move, so these zones are mostly the {RECORD_UNCERTAINTY_M} m uncertainty in where it started. Try more flow, a lighter object or a release point nearer the channel.</p>}
            <p className="muted small">Only as good as the assumptions behind it. Change the flow, friction or uncertainty and watch the area move.</p>
          </>
        )}
      </section>

      <section className="card">
        <h2>Why a powered vehicle can't just hold position</h2>
        <p>Holding still in a current means pushing against the drag, <code>F = ½ ρ Cd A u²</code>, at the speed of the water, so the power needed is <code>P = F · u</code>, which grows with the <strong>cube</strong> of the flow speed. Double the flow and the vehicle needs 8 times the power. A bed object has the opposite weakness: friction holds it until the flow passes a threshold.</p>
        <PowerChart cd={params.cd} diameter={params.uuvDiameterM} maxPower={params.uuvMaxPowerW} limit={uuvLimit} peak={params.peakFlow} colours={colours} />
        <ul>
          <li>At the peak flow of {fmt(params.peakFlow, 1)} m/s it needs <strong>{fmt(uuvNeeded, 0)} W</strong> to hold station; this vehicle has {fmt(params.uuvMaxPowerW, 0)} W.</li>
          <li>Its limit is <strong>{fmt(uuvLimit, 2)} m/s</strong>. {params.peakFlow > uuvLimit
            ? "The peak flow is above that, so in the main channel it is carried away."
            : "The peak flow is below that, so in the main channel it can hold station (with its power use rising steeply as it nears the limit)."}</li>
        </ul>
      </section>

      {rows && (
        <section className="card">
          <h2>Compare object types</h2>
          <p className="muted small">Same flow, same release point, same seed, {params.runs} runs each.</p>
          <table className="tbl">
            <thead><tr><th scope="col">Object</th><th scope="col">Moved</th><th scope="col">Median drift (m)</th><th scope="col">90% search area (ha)</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.kind}>
                  <td>{KINDS.find((k) => k.id === r.kind)!.short}</td>
                  <td>{r.summary.movedCount} of {r.summary.n}</td>
                  <td>{fmt(r.summary.medianM, 0)}</td>
                  <td>{fmt(r.summary.zone90.areaHa, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </Page>
  );
}

function PowerChart({ cd, diameter, maxPower, limit, peak, colours }: { cd: number; diameter: number; maxPower: number; limit: number; peak: number; colours: Record<string, string> }): ReactNode {
  const W = 420, H = 210, L = 52, R = 12, T = 14, B = 36;
  const xMax = Math.max(4, peak * 1.15, limit * 1.3);
  const yMax = Math.max(requiredPowerW(xMax, cd, diameter), maxPower * 1.1);
  const px = (u: number) => L + (u / xMax) * (W - L - R);
  const py = (p: number) => H - B - (p / yMax) * (H - T - B);
  const path = powerCurve(cd, diameter, xMax).map((pt, i) => `${i ? "L" : "M"}${px(pt.speed).toFixed(1)},${py(pt.powerW).toFixed(1)}`).join(" ");
  const ticks = [0, 1, 2, 3, 4, 5].filter((t) => t <= xMax);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Power needed to hold station against the current rises with the cube of the speed. The vehicle's ${fmt(maxPower, 0)} watts run out at ${fmt(limit, 2)} metres per second.`} style={{ width: "100%", maxWidth: 520, height: "auto" }}>
      <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke={colours.muted} />
      <line x1={L} y1={T} x2={L} y2={H - B} stroke={colours.muted} />
      {ticks.map((t) => <text key={t} x={px(t)} y={H - B + 14} fontSize="11" textAnchor="middle" fill={colours.muted}>{t}</text>)}
      <text x={(L + W - R) / 2} y={H - 4} fontSize="11" textAnchor="middle" fill={colours.muted}>Flow speed (m/s)</text>
      <text x={14} y={(T + H - B) / 2} fontSize="11" textAnchor="middle" fill={colours.muted} transform={`rotate(-90 14 ${(T + H - B) / 2})`}>Power to hold station (W)</text>
      <text x={L - 4} y={py(0) + 4} fontSize="11" textAnchor="end" fill={colours.muted}>0</text>
      <text x={L - 4} y={py(yMax) + 12} fontSize="11" textAnchor="end" fill={colours.muted}>{fmt(yMax, 0)}</text>
      <line x1={L} y1={py(maxPower)} x2={W - R} y2={py(maxPower)} stroke={colours.warn} strokeDasharray="4 4" />
      <text x={W - R} y={py(maxPower) - 4} fontSize="11" textAnchor="end" fill={colours.warn}>Vehicle maximum {fmt(maxPower, 0)} W</text>
      <path d={path} fill="none" stroke={colours.deep} strokeWidth="2.5" />
      <line x1={px(limit)} y1={T} x2={px(limit)} y2={H - B} stroke={colours.error} strokeWidth="2" />
      <text x={px(limit) + 4} y={T + 10} fontSize="11" fill={colours.error}>Limit {fmt(limit, 2)} m/s</text>
      <line x1={px(peak)} y1={T} x2={px(peak)} y2={H - B} stroke={colours.muted} strokeDasharray="2 3" />
      <text x={px(peak) - 4} y={T + 24} fontSize="11" textAnchor="end" fill={colours.muted}>Peak {fmt(peak, 1)} m/s</text>
    </svg>
  );
}
