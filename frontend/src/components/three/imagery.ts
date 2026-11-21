/**
 * High-resolution imagery for the 3D terrain: Esri World Imagery tiles (the same source as the map's "Satellite" layer)
 * stitched into one texture. Sentinel-2 is 10 m per pixel, so a 2 km terrain gets a ~220 px picture that can only look
 * blurry; the tiles give about 1 m per pixel at zoom 17.
 */

export const IMAGERY_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const IMAGERY_ATTRIBUTION = "Esri World Imagery (Maxar, Earthstar Geographics and the GIS User Community)";
const MIN_ZOOM = 10;
/** Wide view keeps the download to about 120 tiles. The close view uses zoom 18 (0.55 m per pixel); zoom 19 is "Map data not yet available" across most of India. */
export const WIDE = { maxZoom: 17, maxSide: 2560 };
export const CLOSE = { maxZoom: 18, maxSide: 4096 };
export type Quality = typeof WIDE;
const TILE = 256;
/** How many zoom levels to step back when a place has no imagery at the zoom asked for. */
const MAX_FALLBACK_LEVELS = 4;

/** [lon, lat] of the terrain square's corners in the order NW, NE, SW, SE. */
export type Corners = number[][];

export interface MosaicPlan {
  z: number;
  /** world-pixel position of the mosaic's top-left corner at this zoom */
  x0: number;
  y0: number;
  tx0: number;
  ty0: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
}

/** Web-Mercator world pixels of a lon/lat at a zoom. */
export function worldPx(lon: number, lat: number, z: number): [number, number] {
  const n = TILE * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

/** The finest allowed zoom at which the terrain fits in one texture, and the tiles that cover it. */
export function planMosaic(corners: Corners, q: Quality = WIDE): MosaicPlan {
  for (let z = q.maxZoom; z >= MIN_ZOOM; z--) {
    const px = corners.map(([lon, lat]) => worldPx(lon, lat, z));
    const xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
    const tx0 = Math.floor(Math.min(...xs) / TILE), tx1 = Math.floor(Math.max(...xs) / TILE);
    const ty0 = Math.floor(Math.min(...ys) / TILE), ty1 = Math.floor(Math.max(...ys) / TILE);
    const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
    if (z === MIN_ZOOM || (cols * TILE <= q.maxSide && rows * TILE <= q.maxSide)) {
      return { z, tx0, ty0, x0: tx0 * TILE, y0: ty0 * TILE, cols, rows, width: cols * TILE, height: rows * TILE };
    }
  }
  throw new Error("unreachable");
}

/**
 * Texture coordinate of a point of the terrain square (u across, v down, both 0..1). The square is a UTM grid, slightly
 * skewed against lon/lat, so the position is interpolated between the corners and then looked up in the tiles; the
 * picture lands where it really is instead of being stretched over the square.
 */
export function textureUv(plan: MosaicPlan, corners: Corners, u: number, v: number): [number, number] {
  const [nw, ne, sw, se] = corners;
  const lon = nw[0] * (1 - u) * (1 - v) + ne[0] * u * (1 - v) + sw[0] * (1 - u) * v + se[0] * u * v;
  const lat = nw[1] * (1 - u) * (1 - v) + ne[1] * u * (1 - v) + sw[1] * (1 - u) * v + se[1] * u * v;
  const [x, y] = worldPx(lon, lat, plan.z);
  return [(x - plan.x0) / plan.width, 1 - (y - plan.y0) / plan.height];   // canvas textures are flipped: the top row is v = 1
}

const tileUrl = (z: number, x: number, y: number) => IMAGERY_URL.replace("{z}", String(z)).replace("{y}", String(y)).replace("{x}", String(x));

function loadTile(url: string, signal: AbortSignal): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const done = (v: HTMLImageElement | null) => { signal.removeEventListener("abort", onAbort); resolve(v); };
    const onAbort = () => { img.src = ""; done(null); };
    signal.addEventListener("abort", onAbort);
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = url;
  });
}

/** Esri answers 200 with a flat grey "Map data not yet available" picture where it has no imagery. Takes RGBA pixels. */
export function isNoDataTile(rgba: ArrayLike<number>): boolean {
  let grey = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    if (Math.abs(rgba[i] - 204) <= 6 && Math.abs(rgba[i + 1] - 204) <= 6 && Math.abs(rgba[i + 2] - 204) <= 6) grey++;
  }
  return grey / n >= 0.9;
}

let probeCtx: CanvasRenderingContext2D | null | undefined;

function hasImagery(img: HTMLImageElement): boolean {
  if (probeCtx === undefined) {
    const probe = document.createElement("canvas");
    probe.width = probe.height = 32;
    probeCtx = probe.getContext("2d", { willReadFrequently: true });
  }
  if (!probeCtx) return true;
  probeCtx.drawImage(img, 0, 0, 32, 32);
  return !isNoDataTile(probeCtx.getImageData(0, 0, 32, 32).data);
}

export interface Mosaic {
  canvas: HTMLCanvasElement;
  loaded: number;
  total: number;
  /** tiles that had to come from a coarser zoom, because the place has no imagery at the zoom asked for */
  coarser: number;
}

/** Downloads the tiles a few at a time and draws them into one canvas. A tile with no imagery is replaced by the matching part of a coarser one. Missing tiles stay as neutral ground colour. */
export async function loadMosaic(plan: MosaicPlan, signal: AbortSignal): Promise<Mosaic> {
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.fillStyle = "#8a9082";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const jobs: [number, number][] = [];
  for (let r = 0; r < plan.rows; r++) for (let c = 0; c < plan.cols; c++) jobs.push([c, r]);
  let loaded = 0, coarser = 0, next = 0;
  const worker = async () => {
    while (next < jobs.length && !signal.aborted) {
      const [c, r] = jobs[next++];
      const tx = plan.tx0 + c, ty = plan.ty0 + r;
      for (let up = 0; up <= MAX_FALLBACK_LEVELS && !signal.aborted; up++) {
        const scale = 2 ** up;
        const img = await loadTile(tileUrl(plan.z - up, Math.floor(tx / scale), Math.floor(ty / scale)), signal);
        if (!img) { if (up === 0) continue; break; }
        if (!hasImagery(img)) continue;
        // the part of the coarser tile that covers this tile
        const size = TILE / scale;
        ctx.drawImage(img, (tx % scale) * size, (ty % scale) * size, size, size, c * TILE, r * TILE, TILE, TILE);
        loaded++;
        if (up > 0) coarser++;
        break;
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { canvas, loaded, total: jobs.length, coarser };
}

/** Unsharp mask: makes roads and roof edges crisper on screen. It adds no information, only local contrast. */
export function sharpen(canvas: HTMLCanvasElement, amount = 0.55) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !("filter" in ctx)) return;
  const blurred = document.createElement("canvas");
  blurred.width = canvas.width;
  blurred.height = canvas.height;
  const b = blurred.getContext("2d");
  if (!b) return;
  b.filter = "blur(1px)";
  b.drawImage(canvas, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const soft = b.getImageData(0, 0, canvas.width, canvas.height).data;
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] += (d[i] - soft[i]) * amount;
    d[i + 1] += (d[i + 1] - soft[i + 1]) * amount;
    d[i + 2] += (d[i + 2] - soft[i + 2]) * amount;
  }
  ctx.putImageData(image, 0, 0);
}
