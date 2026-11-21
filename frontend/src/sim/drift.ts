/**
 * Illustrative Monte Carlo drift model: where a generic object ends up after a flood.
 *
 * Pure and deterministic (seeded). No React, no DOM. Every constant below is an ASSUMPTION, not a measurement, and
 * nothing here is calibrated to real flood or munition data. Positions are metres east (x) and north (y) of the
 * release point.
 */

// ---------------------------------------------------------------- assumptions (all of them, with units)
/** Density of the flood water, kg/m³. Assumed clear fresh water; a sediment-laden flood would be denser. */
export const RHO_WATER = 1000;
/** Gravitational acceleration, m/s². */
const G = 9.81;
/** Ratio of an object's depth near the bed to the depth-averaged flow speed, dimensionless. Assumed. */
const BED_VELOCITY_FACTOR = 0.7;
/** Once a bed object breaks free it moves at this fraction of the excess near-bed speed, dimensionless. Assumed. */
const SLIDE_GAIN = 0.5;
/** Object thickness as a fraction of its diameter (a squat disc), dimensionless. Assumed. */
const THICKNESS_RATIO = 0.35;
/** Fraction of wind speed that moves a floating object, dimensionless. Assumed (a common rule of thumb is about 3%). */
const WIND_DRIFT_FRACTION = 0.03;
/** A floating object moves at this multiple of the local flow speed, dimensionless. Assumed. */
const SURFACE_FACTOR = 1;
/** An object that ends closer than this to where it started "did not move", metres. Assumed. */
export const MOVED_THRESHOLD_M = 1;
/** Uncertainty in the recorded release position, metres. Added around every search zone so a zone is never a point. Assumed. */
export const RECORD_UNCERTAINTY_M = 10;
/** Points kept along each particle's path for the replay, not counting the start. */
export const SNAPSHOTS = 60;
/** Most time steps used for one particle, to bound the work of a run. */
const MAX_STEPS = 1200;
/** Shortest time step, seconds. Assumed small enough for the default decay length and speeds. */
const MIN_DT_S = 30;
/** Points used to approximate the circle around a zone. */
const CIRCLE_POINTS = 16;

export type ObjectKind = "bed" | "floating" | "uuv";

export interface Params {
  kind: ObjectKind;
  /** Depth-averaged flow speed in the main channel at the flood peak, m/s. */
  peakFlow: number;
  /** Length of the flood, hours. Flow follows a half sine wave: zero, then the peak at the middle, then zero. */
  durationH: number;
  /** Object diameter, m (bed object). */
  sizeM: number;
  /** Object mass, kg (bed object). */
  massKg: number;
  /** Friction coefficient between the object and the bed, dimensionless. */
  mu: number;
  /** Drag coefficient, dimensionless. */
  cd: number;
  /** Turbulent dispersion length K, m: the random walk has a diffusion coefficient D = K × local speed (m²/s). */
  turbulence: number;
  /** Number of Monte Carlo particles. */
  runs: number;
  /** Uniform uncertainty on Cd, mu, size and mass, percent either way. */
  paramSpreadPct: number;
  /** Uniform uncertainty on the flow speed, percent either way. */
  flowSpreadPct: number;
  /** Wind speed, m/s, for floating objects. */
  windSpeed: number;
  /** Direction the wind blows FROM, degrees clockwise from north. */
  windFromDeg: number;
  /** The vehicle's maximum thrust power, W. */
  uuvMaxPowerW: number;
  /** The vehicle's diameter, m (frontal area is a circle). */
  uuvDiameterM: number;
  /** A point on the channel centreline (metres from the release point) and the flow bearing along it (degrees clockwise from north). */
  channel: { x: number; y: number; bearingDeg: number };
  /** Distance over which flow falls to 1/e of the channel speed across the floodplain, m. Assumed exponential decay. */
  decayLengthM: number;
  /** Length of the flooded reach, m, used only for the "whole floodplain" comparison. */
  reachLengthM: number;
  /** Width of the flooded floodplain, m, used only for the "whole floodplain" comparison. */
  floodWidthM: number;
}

export interface Zone { points: [number, number][]; areaHa: number }

export interface Summary {
  n: number;
  movedCount: number;
  medianM: number;
  p90M: number;
  zone50: Zone;
  zone90: Zone;
  floodAreaHa: number;
  reductionHa: number;
  reductionPct: number;
}

export interface Run {
  params: Params;
  n: number;
  /** x,y of each particle's end point. */
  ends: Float32Array;
  /** (SNAPSHOTS + 1) x,y pairs per particle, from the start to the end. */
  trails: Float32Array;
  /** distance moved by each particle, m. */
  dists: Float32Array;
  done: number;
}

// ---------------------------------------------------------------- seeded random numbers
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each particle has its own stream, so the answer does not depend on the order or chunking of the work. */
function particleRng(seed: number, index: number): () => number {
  return mulberry32(Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b));
}

function normal(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// ---------------------------------------------------------------- physics
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Frontal area of a bed-resting disc lying on its flat side, m². */
const bedArea = (size: number) => size * THICKNESS_RATIO * size;

/** Submerged weight of the bed object, N; zero if it is lighter than the water it displaces. */
export function submergedWeightN(sizeM: number, massKg: number): number {
  const volume = (Math.PI / 4) * sizeM * sizeM * (THICKNESS_RATIO * sizeM);
  return Math.max(0, (massKg - RHO_WATER * volume) * G);
}

/** Near-bed speed at which drag 0.5·ρ·Cd·A·u² overcomes friction μ·W', m/s. */
export function bedCriticalSpeed(sizeM: number, massKg: number, mu: number, cd: number): number {
  return Math.sqrt((2 * mu * submergedWeightN(sizeM, massKg)) / (RHO_WATER * cd * bedArea(sizeM)));
}

const uuvArea = (diameterM: number) => (Math.PI / 4) * diameterM * diameterM;

/** Power a vehicle needs to hold station in a current: drag × speed = 0.5·ρ·Cd·A·u³, W. Rises with the cube of speed. */
export function requiredPowerW(speed: number, cd: number, diameterM: number): number {
  return 0.5 * RHO_WATER * cd * uuvArea(diameterM) * speed ** 3;
}

/** Flow speed at which the vehicle's maximum thrust power is used up, m/s. Beyond this it is carried away. */
export function uuvLimitSpeed(maxPowerW: number, cd: number, diameterM: number): number {
  return Math.cbrt((2 * maxPowerW) / (RHO_WATER * cd * uuvArea(diameterM)));
}

/** Points of the power curve for a chart. */
export function powerCurve(cd: number, diameterM: number, maxSpeed: number, steps = 40): { speed: number; powerW: number }[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const speed = (maxSpeed * i) / steps;
    return { speed, powerW: requiredPowerW(speed, cd, diameterM) };
  });
}

export function createRun(params: Params): Run {
  const n = Math.max(1, Math.round(params.runs));
  return { params, n, ends: new Float32Array(n * 2), trails: new Float32Array(n * (SNAPSHOTS + 1) * 2), dists: new Float32Array(n), done: 0 };
}

/** Simulates particles from..to-1 and stores their paths in the run. */
export function runChunk(run: Run, seed: number, from: number, to: number): void {
  const p = run.params;
  const end = Math.min(to, run.n);
  const steps = Math.min(MAX_STEPS, Math.max(100, Math.ceil((p.durationH * 3600) / MIN_DT_S)));
  const total = Math.max(p.durationH * 3600, 1);
  const dt = total / steps;
  const bearing = rad(p.channel.bearingDeg);
  const tx = Math.sin(bearing), ty = Math.cos(bearing);       // along the channel
  const nx = Math.cos(bearing), ny = -Math.sin(bearing);      // across it
  const wind = rad(p.windFromDeg + 180);                      // the direction the wind blows towards
  const spread = (rand: () => number, pct: number) => 1 + ((rand() * 2 - 1) * pct) / 100;

  for (let i = from; i < end; i++) {
    const rand = particleRng(seed, i);
    const cd = p.cd * spread(rand, p.paramSpreadPct);
    const mu = p.mu * spread(rand, p.paramSpreadPct);
    const size = p.sizeM * spread(rand, p.paramSpreadPct);
    const mass = p.massKg * spread(rand, p.paramSpreadPct);
    const flowMultiplier = spread(rand, p.flowSpreadPct);
    const critical = bedCriticalSpeed(size, mass, mu, cd);
    const uuvLimit = uuvLimitSpeed(p.uuvMaxPowerW, cd, p.uuvDiameterM);

    let x = 0, y = 0, nextSnap = 1;
    const base = i * (SNAPSHOTS + 1) * 2;
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) * dt;
      const across = Math.abs((x - p.channel.x) * nx + (y - p.channel.y) * ny);
      const u = p.peakFlow * flowMultiplier * Math.sin((Math.PI * t) / total) * Math.exp(-across / Math.max(p.decayLengthM, 1));
      let speedAlong = 0;      // m/s along the channel
      let windX = 0, windY = 0;
      let carried = false;     // random walk applies only while the object is actually being moved
      if (p.kind === "bed") {
        const nearBed = BED_VELOCITY_FACTOR * u;
        if (nearBed > critical) { speedAlong = SLIDE_GAIN * (nearBed - critical); carried = true; }
      } else if (p.kind === "floating") {
        speedAlong = SURFACE_FACTOR * u;
        windX = WIND_DRIFT_FRACTION * p.windSpeed * Math.sin(wind);
        windY = WIND_DRIFT_FRACTION * p.windSpeed * Math.cos(wind);
        carried = true;
      } else if (u > uuvLimit) {
        speedAlong = u - uuvLimit;      // it cannot cancel the part of the flow beyond its thrust
        carried = true;
      }
      x += (speedAlong * tx + windX) * dt;
      y += (speedAlong * ty + windY) * dt;
      if (carried) {
        const sigma = Math.sqrt(2 * Math.max(p.turbulence, 0) * Math.max(u, 0) * dt);
        x += sigma * normal(rand);
        y += sigma * normal(rand);
      }
      while (nextSnap <= SNAPSHOTS && (s + 1) / steps >= nextSnap / SNAPSHOTS - 1e-9) {
        run.trails[base + nextSnap * 2] = x;
        run.trails[base + nextSnap * 2 + 1] = y;
        nextSnap++;
      }
    }
    run.ends[i * 2] = x;
    run.ends[i * 2 + 1] = y;
    run.dists[i] = Math.hypot(x, y);
  }
  run.done = Math.max(run.done, end);
}

// ---------------------------------------------------------------- summary
type Pt = [number, number];

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (Andrew's monotone chain), counter-clockwise. */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
  if (pts.length < 3) return pts;
  const half = (list: Pt[]) => {
    const out: Pt[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

function polygonAreaM2(poly: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** The hull of these points, widened by the position uncertainty (the hull of every point plus a circle around it). */
function zoneOf(points: Pt[]): Zone {
  const widened: Pt[] = [];
  for (const [x, y] of convexHull(points)) {
    for (let k = 0; k < CIRCLE_POINTS; k++) {
      const a = (2 * Math.PI * k) / CIRCLE_POINTS;
      widened.push([x + RECORD_UNCERTAINTY_M * Math.cos(a), y + RECORD_UNCERTAINTY_M * Math.sin(a)]);
    }
  }
  const hull = convexHull(widened);
  return { points: hull, areaHa: polygonAreaM2(hull) / 10000 };
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];

export function summarise(run: Run): Summary {
  const n = run.done;
  const ends: Pt[] = Array.from({ length: n }, (_, i) => [run.ends[i * 2], run.ends[i * 2 + 1]]);
  const dists = Array.from(run.dists.subarray(0, n)).sort((a, b) => a - b);
  const xs = ends.map((e) => e[0]).sort((a, b) => a - b);
  const ys = ends.map((e) => e[1]).sort((a, b) => a - b);
  const centre: Pt = [quantile(xs, 0.5), quantile(ys, 0.5)];
  // nearest-first from the middle of the outcomes, so the 50% set is always inside the 90% set
  const byCentre = [...ends].sort((a, b) => Math.hypot(a[0] - centre[0], a[1] - centre[1]) - Math.hypot(b[0] - centre[0], b[1] - centre[1]));
  const zone50 = zoneOf(byCentre.slice(0, Math.max(1, Math.ceil(0.5 * n))));
  const zone90 = zoneOf(byCentre.slice(0, Math.max(1, Math.ceil(0.9 * n))));
  const p = run.params;
  const floodAreaHa = (p.reachLengthM * p.floodWidthM) / 10000;
  const reductionHa = Math.max(0, floodAreaHa - zone90.areaHa);
  return {
    n,
    movedCount: Array.from(run.dists.subarray(0, n)).filter((d) => d > MOVED_THRESHOLD_M).length,
    medianM: quantile(dists, 0.5),
    p90M: quantile(dists, 0.9),
    zone50,
    zone90,
    floodAreaHa,
    reductionHa,
    reductionPct: floodAreaHa > 0 ? (100 * reductionHa) / floodAreaHa : 0,
  };
}

/** The whole simulation in one call; the same seed always gives the same answer. */
export function simulate(params: Params, seed: number): { run: Run; summary: Summary } {
  const run = createRun(params);
  runChunk(run, seed, 0, run.n);
  return { run, summary: summarise(run) };
}

export const DEFAULT_PARAMS: Params = {
  kind: "bed",
  peakFlow: 2.5,
  durationH: 24,
  sizeM: 0.2,
  massKg: 4,
  mu: 0.6,
  cd: 1,
  turbulence: 1,
  runs: 500,
  paramSpreadPct: 20,
  flowSpreadPct: 25,
  windSpeed: 0,
  windFromDeg: 0,
  uuvMaxPowerW: 300,
  uuvDiameterM: 0.3,
  channel: { x: 0, y: -50, bearingDeg: 90 },
  decayLengthM: 150,
  reachLengthM: 5000,
  floodWidthM: 2000,
};

/** Generic surrogate objects: size and mass only. They are not models of any real item. */
export const OBJECT_PRESETS: { id: string; label: string; sizeM: number; massKg: number }[] = [
  { id: "light", label: "Light, 12 cm, 0.6 kg", sizeM: 0.12, massKg: 0.6 },
  { id: "medium", label: "Medium, 20 cm, 4 kg", sizeM: 0.2, massKg: 4 },
  { id: "heavy", label: "Heavy, 30 cm, 14 kg", sizeM: 0.3, massKg: 14 },
];
