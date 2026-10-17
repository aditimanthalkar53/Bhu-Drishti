"""Real-data provider: Microsoft Planetary Computer (Sentinel-1 RTC, Sentinel-2 L2A, ESA WorldCover).

Status: EXPERIMENTAL. The pure logic (tiling, thresholds, cache keys) is unit
tested offline; the STAC/COG reads need network access to
planetarycomputer.microsoft.com and have not been exercised in CI.

Enable with ``AEQE_PROVIDER=planetary_computer``. Optional:

* ``AEQE_REGIONS``   — GeoJSON FeatureCollection of regions (properties: id, name)
* ``AEQE_EMBEDDINGS`` — GeoParquet/Parquet of per-tile embeddings, columns
  ``lon``, ``lat`` (tile centre) and ``emb_0 … emb_k``. Export AlphaEarth
  embeddings with ``scripts/export_alphaearth.py`` or convert Earth Index
  embeddings. Without it, only cheap raster proxies are used.

What runs where (cheap vs expensive):

* cheap, whole-region, once per query — WorldCover cropland/built fractions per
  tile and a coarse (~200 m) Sentinel-1 VV "overview" water fraction, read from
  COG overviews; plus embedding PCs if provided.
* expensive, per sampled tile — the oracle: full-resolution (10–20 m)
  Sentinel-1 VV flood segmentation masked to cropland, or bi-temporal
  Sentinel-2 built-up change.

Brick-kiln detection and VQA have no open model wired in here, so those
targets/tasks are reported as unsupported by validation instead of faked.
"""

from __future__ import annotations

import json
import math
import os
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Optional

import numpy as np

from ..ir import QueryIR, Target, Task
from .base import Check, Oracle, OracleOutput, Provider, Region, TileUniverse

TILE_DEG = 0.01
STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
WORLDCOVER_CROPLAND = 40
WORLDCOVER_BUILT = 50
WORLDCOVER_WATER = 80
WATER_DB_DEFAULT = -18.0   # VV backscatter threshold (dB) when Otsu is not reliable

DEFAULT_REGIONS = [
    {"id": "barpeta-area", "name": "Barpeta area, Assam (bounding box)", "bbox": [90.80, 26.20, 91.40, 26.65]},
    {"id": "nalbari-area", "name": "Nalbari area, Assam (bounding box)", "bbox": [91.20, 26.30, 91.70, 26.70]},
]


# ---------------------------------------------------------------------------- pure helpers (unit tested)

def grid_tiles(bbox: tuple[float, float, float, float], tile_deg: float = TILE_DEG) -> tuple[list[str], np.ndarray]:
    """Regular lat/lon grid over ``bbox``; returns tile ids and (N, 4) bboxes."""
    minx, miny, maxx, maxy = bbox
    nx = max(1, int(math.ceil((maxx - minx) / tile_deg - 1e-9)))
    ny = max(1, int(math.ceil((maxy - miny) / tile_deg - 1e-9)))
    ids, boxes = [], []
    for r in range(ny):
        y1 = maxy - r * tile_deg
        for c in range(nx):
            x0 = minx + c * tile_deg
            ids.append(f"g{tile_deg:g}:{x0:.4f}:{y1 - tile_deg:.4f}")
            boxes.append((x0, y1 - tile_deg, min(x0 + tile_deg, maxx), y1))
    return ids, np.array(boxes, dtype=float)


def tile_area_km2(bboxes: np.ndarray) -> np.ndarray:
    lat = np.radians((bboxes[:, 1] + bboxes[:, 3]) / 2)
    return (111.32 * (bboxes[:, 3] - bboxes[:, 1])) * (111.32 * (bboxes[:, 2] - bboxes[:, 0]) * np.cos(lat))


def otsu_threshold(values: np.ndarray, bins: int = 128) -> Optional[float]:
    """Otsu threshold on finite values; None if the histogram is not bimodal enough."""
    v = values[np.isfinite(values)]
    if v.size < 200:
        return None
    hist, edges = np.histogram(v, bins=bins)
    p = hist / hist.sum()
    mids = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(p)
    w1 = 1 - w0
    mu0 = np.cumsum(p * mids) / np.maximum(w0, 1e-12)
    mu_t = (p * mids).sum()
    mu1 = (mu_t - np.cumsum(p * mids)) / np.maximum(w1, 1e-12)
    between = w0 * w1 * (mu0 - mu1) ** 2
    k = int(np.nanargmax(between))
    # require both classes to be non-trivial, else fall back to a fixed threshold
    if w0[k] < 0.02 or w1[k] < 0.02:
        return None
    return float(mids[k])


def water_mask_from_vv(vv_linear: np.ndarray) -> tuple[np.ndarray, float, str]:
    """Open-water mask from Sentinel-1 VV (linear power). Returns (mask, threshold_dB, method)."""
    db = 10 * np.log10(np.clip(vv_linear, 1e-6, None))
    t = otsu_threshold(db)
    if t is None or not (-24.0 <= t <= -14.0):
        return db < WATER_DB_DEFAULT, WATER_DB_DEFAULT, "fixed"
    return db < t, t, "otsu"


def builtup_mask(b04: np.ndarray, b08: np.ndarray, b11: np.ndarray) -> np.ndarray:
    """Simple spectral built-up mask: NDBI > 0 and NDVI < 0.25 (surface reflectance)."""
    with np.errstate(divide="ignore", invalid="ignore"):
        ndbi = (b11 - b08) / (b11 + b08)
        ndvi = (b08 - b04) / (b08 + b04)
    return (ndbi > 0.0) & (ndvi < 0.25)


def fraction_per_tile(arr: np.ndarray, xs: np.ndarray, ys: np.ndarray, bboxes: np.ndarray) -> np.ndarray:
    """Mean of a 2-D array (rows = ys descending, cols = xs) inside each tile bbox."""
    out = np.full(len(bboxes), np.nan)
    for i, (x0, y0, x1, y1) in enumerate(bboxes):
        cs = np.flatnonzero((xs >= x0) & (xs < x1))
        rs = np.flatnonzero((ys >= y0) & (ys < y1))
        if len(cs) and len(rs):
            out[i] = float(np.nanmean(arr[np.ix_(rs, cs)]))
    return out


# ---------------------------------------------------------------------------- STAC access (network)

class _Stac:
    def __init__(self):
        import planetary_computer
        import pystac_client

        self.client = pystac_client.Client.open(STAC_URL, modifier=planetary_computer.sign_inplace)

    def search(self, collection: str, bbox, start: date, end: date, query: Optional[dict] = None, limit: int = 50):
        s = self.client.search(collections=[collection], bbox=list(bbox), datetime=f"{start.isoformat()}/{end.isoformat()}",
                               query=query or {}, max_items=limit)
        return list(s.items())

    @staticmethod
    def load(items, bands, bbox, resolution_deg: float, groupby: str = "solar_day"):
        import odc.stac

        ds = odc.stac.load(items, bands=bands, bbox=list(bbox), crs="EPSG:4326", resolution=resolution_deg,
                           groupby=groupby, chunks=None)
        return ds


@lru_cache(maxsize=1)
def _stac() -> _Stac:
    return _Stac()


# ---------------------------------------------------------------------------- oracles

class S1FloodOracle(Oracle):
    name = "s1_flood_threshold"
    model_version = "otsu-vv-0.1"
    sensor = "sentinel-1"
    unit = "km²"
    description = "Sentinel-1 RTC VV open-water segmentation (Otsu, fallback −18 dB) on cropland minus permanent water (WorldCover)."

    def __init__(self, provider: "PlanetaryComputerProvider"):
        self.p = provider

    def params_key(self, ir: QueryIR) -> str:
        return "vv;otsu;cropland=worldcover2021;minus_permanent_water"

    def run(self, universe: TileUniverse, idx: int, ir: QueryIR) -> OracleOutput:
        bbox = tuple(universe.bboxes[idx])
        items = self.p.s1_items(ir)
        ds = _Stac.load(items, ["vv"], bbox, 0.0002)  # ~20 m
        # a pixel counts as flooded if it is open water in ANY pass inside the window
        passes = [ds["vv"].isel(time=t).values for t in range(ds.sizes["time"])] if "time" in ds["vv"].dims else [ds["vv"].values]
        water_any = None
        thr, method = WATER_DB_DEFAULT, "fixed"
        for arr in passes:
            m, thr, method = water_mask_from_vv(arr)
            water_any = m if water_any is None else (water_any | m)
        wc = self.p.worldcover(bbox, 0.0002)
        crop = wc == WORLDCOVER_CROPLAND
        perm = wc == WORLDCOVER_WATER
        flooded = water_any & crop & ~perm
        a = universe.area_km2[idx]
        val = float(flooded.mean() * a) if flooded.size else 0.0
        return OracleOutput(val, {"threshold_db": round(float(thr), 2), "method": method, "passes": len(passes),
                                  "flooded_share_of_cropland": round(float(flooded.sum() / max(crop.sum(), 1)), 4)})


class S2BuiltChangeOracle(Oracle):
    name = "s2_builtup_change"
    model_version = "ndbi-ndvi-0.1"
    sensor = "sentinel-2"
    unit = "km²"
    description = "Bi-temporal Sentinel-2 L2A dry-season median composites; new built-up = built(t1) ∧ ¬built(t0) via NDBI/NDVI."

    def __init__(self, provider: "PlanetaryComputerProvider"):
        self.p = provider

    def params_key(self, ir: QueryIR) -> str:
        return f"baseline={ir.baseline_start}..{ir.baseline_end};ndbi>0;ndvi<0.25;cloud<20"

    def _built(self, bbox, year: int) -> np.ndarray:
        items = self.p.s2_items(bbox, date(year, 1, 1), date(year, 3, 31))
        ds = _Stac.load(items, ["B04", "B08", "B11"], bbox, 0.0001, groupby="solar_day")
        med = ds.median("time") if "time" in ds.dims else ds
        return builtup_mask(med["B04"].values.astype(float), med["B08"].values.astype(float), med["B11"].values.astype(float))

    def run(self, universe: TileUniverse, idx: int, ir: QueryIR) -> OracleOutput:
        bbox = tuple(universe.bboxes[idx])
        y0 = (ir.baseline_start or date(ir.end.year - 4, 1, 1)).year
        b0, b1 = self._built(bbox, y0), self._built(bbox, ir.end.year)
        h, w = min(b0.shape[0], b1.shape[0]), min(b0.shape[1], b1.shape[1])
        new = b1[:h, :w] & ~b0[:h, :w]
        return OracleOutput(float(new.mean() * universe.area_km2[idx]), {"baseline_year": y0, "target_year": ir.end.year})


# ---------------------------------------------------------------------------- provider

class PlanetaryComputerProvider(Provider):
    name = "planetary_computer"
    oracle_latency_s = 0.0  # real latency is measured

    def __init__(self):
        path = os.getenv("AEQE_REGIONS")
        self._regions = self._load_regions(path) if path else [
            Region(r["id"], r["name"], tuple(r["bbox"]), _bbox_geom(r["bbox"]), False, "Real Sentinel data via Planetary Computer.")
            for r in DEFAULT_REGIONS
        ]
        self._emb_path = os.getenv("AEQE_EMBEDDINGS")
        self._s1_cache: dict = {}

    @staticmethod
    def _load_regions(path: str) -> list[Region]:
        fc = json.loads(Path(path).read_text())
        out = []
        for f in fc["features"]:
            coords = np.array(f["geometry"]["coordinates"][0])
            bbox = (float(coords[:, 0].min()), float(coords[:, 1].min()), float(coords[:, 0].max()), float(coords[:, 1].max()))
            out.append(Region(f["properties"]["id"], f["properties"].get("name", f["properties"]["id"]), bbox, f["geometry"], False))
        return out

    def regions(self) -> list[Region]:
        return self._regions

    def supports(self, target: Target) -> bool:
        return target in (Target.FLOODED_CROPLAND, Target.NEW_BUILTUP)

    # -- data access ------------------------------------------------------------------
    def s1_items(self, ir: QueryIR):
        key = (ir.region_id, ir.start, ir.end)
        if key not in self._s1_cache:
            r = self.region(ir.region_id)
            self._s1_cache[key] = _stac().search("sentinel-1-rtc", r.bbox, ir.start, ir.end)
        return self._s1_cache[key]

    def s2_items(self, bbox, start: date, end: date):
        return _stac().search("sentinel-2-l2a", bbox, start, end, query={"eo:cloud_cover": {"lt": 20}}, limit=40)

    def worldcover(self, bbox, res: float) -> np.ndarray:
        items = _stac().search("esa-worldcover", bbox, date(2021, 1, 1), date(2021, 12, 31), limit=10)
        ds = _Stac.load(items, ["map"], bbox, res, groupby="solar_day")
        arr = ds["map"]
        return (arr.max("time") if "time" in arr.dims else arr).values

    # -- validation -------------------------------------------------------------------
    def check_inputs(self, ir: QueryIR) -> list[Check]:
        checks: list[Check] = []
        r = self.region(ir.region_id)
        checks.append(Check("Region known", r is not None, r.name if r else f"unknown region '{ir.region_id}'"))
        if r is None:
            return checks
        checks.append(Check("Target supported by real-data provider", self.supports(ir.target),
                            "flood + built-up change only; no open kiln detector wired in" if not self.supports(ir.target) else ir.target.value))
        if ir.task == Task.INSPECT:
            checks.append(Check("VQA oracle available", False, "no open VQA model wired into the real-data provider yet"))
        if not self.supports(ir.target) or ir.task == Task.INSPECT:
            return checks
        try:
            if ir.target == Target.FLOODED_CROPLAND:
                items = self.s1_items(ir)
                checks.append(Check("Sentinel-1 RTC scenes in window", len(items) > 0,
                                    f"{len(items)} scene(s)" if items else "no Sentinel-1 RTC scene — widen the window"))
            else:
                y0 = (ir.baseline_start or date(ir.end.year - 4, 1, 1)).year
                n0 = len(self.s2_items(r.bbox, date(y0, 1, 1), date(y0, 3, 31)))
                n1 = len(self.s2_items(r.bbox, date(ir.end.year, 1, 1), date(ir.end.year, 3, 31)))
                checks.append(Check("Sentinel-2 scenes (cloud < 20%)", n0 > 0 and n1 > 0, f"{y0}: {n0}, {ir.end.year}: {n1}"))
        except Exception as e:  # noqa: BLE001
            checks.append(Check("STAC catalogue reachable", False, f"{type(e).__name__}: {e}"))
        checks.append(Check("Embedding index", bool(self._emb_path), self._emb_path or "none — using raster proxies only", blocking=False))
        return checks

    def choose_sensor(self, ir: QueryIR) -> tuple[str, str]:
        if ir.target == Target.FLOODED_CROPLAND:
            return "sentinel-1", "monsoon floods: SAR backscatter sees through cloud"
        return "sentinel-2", "built-up change from optical spectra (NDBI/NDVI)"

    # -- universe ---------------------------------------------------------------------
    def universe(self, ir: QueryIR) -> TileUniverse:
        r = self.region(ir.region_id)
        ids, boxes = grid_tiles(r.bbox)
        area = tile_area_km2(boxes)
        wc = self.worldcover(r.bbox, 0.001)  # ~100 m, cheap
        ys = np.linspace(r.bbox[3], r.bbox[1], wc.shape[0], endpoint=False)
        xs = np.linspace(r.bbox[0], r.bbox[2], wc.shape[1], endpoint=False)
        crop_f = fraction_per_tile((wc == WORLDCOVER_CROPLAND).astype(float), xs, ys, boxes)
        built_f = fraction_per_tile((wc == WORLDCOVER_BUILT).astype(float), xs, ys, boxes)
        feats, names = [], []
        if ir.target == Target.FLOODED_CROPLAND:
            ds = _Stac.load(self.s1_items(ir), ["vv"], r.bbox, 0.002)  # ~200 m overview
            vv = ds["vv"].min("time").values if "time" in ds["vv"].dims else ds["vv"].values
            wet, _, _ = water_mask_from_vv(vv)
            ys2 = np.linspace(r.bbox[3], r.bbox[1], wet.shape[0], endpoint=False)
            xs2 = np.linspace(r.bbox[0], r.bbox[2], wet.shape[1], endpoint=False)
            wet_f = np.nan_to_num(fraction_per_tile(wet.astype(float), xs2, ys2, boxes))
            base = np.nan_to_num(crop_f) * area
            score0 = wet_f * base
            feats += [wet_f, wet_f * base, base]
            names += ["s1_overview_water", "s1_overview×cropland", "cropland_km2"]
            keep = base > 0.02
            desc = "coarse Sentinel-1 VV overview water fraction (~200 m) × WorldCover cropland area"
        else:
            base = area.copy()
            score0 = np.nan_to_num(built_f)
            feats += [score0]
            names += ["worldcover_built_fraction"]
            keep = np.ones(len(ids), dtype=bool)
            desc = "WorldCover built-up fraction"
        pcs = self._embedding_pcs(boxes)
        if pcs is not None:
            feats += list(pcs.T)
            names += [f"emb_pc{i}" for i in range(pcs.shape[1])]
            desc += f", plus {pcs.shape[1]} embedding PCs"
        X = np.column_stack(feats)
        return TileUniverse(ir.region_id, [t for t, k in zip(ids, keep) if k], boxes[keep], area[keep], base[keep],
                            X[keep], names, score0[keep], desc, {"provider": self.name})

    def _embedding_pcs(self, boxes: np.ndarray, k: int = 6) -> Optional[np.ndarray]:
        if not self._emb_path:
            return None
        import pandas as pd

        df = pd.read_parquet(self._emb_path)
        cols = [c for c in df.columns if c.startswith("emb_")]
        cx, cy = (boxes[:, 0] + boxes[:, 2]) / 2, (boxes[:, 1] + boxes[:, 3]) / 2
        # nearest embedding row per tile centre
        from scipy.spatial import cKDTree

        tree = cKDTree(df[["lon", "lat"]].to_numpy())
        _, nn = tree.query(np.column_stack([cx, cy]))
        E = df[cols].to_numpy()[nn]
        E = E - E.mean(0)
        _, _, vt = np.linalg.svd(E, full_matrices=False)
        return E @ vt[:k].T

    def oracle(self, ir: QueryIR, sensor: str) -> Oracle:
        if ir.target == Target.FLOODED_CROPLAND:
            return S1FloodOracle(self)
        return S2BuiltChangeOracle(self)

    def scene_key(self, ir: QueryIR, sensor: str) -> str:
        if ir.target == Target.FLOODED_CROPLAND:
            ids = sorted(i.id for i in self.s1_items(ir))
            return "S1RTC:" + ("+".join(ids) if len(ids) <= 6 else f"{len(ids)}scenes:{hash(tuple(ids)) & 0xFFFFFFFF:08x}")
        y0 = (ir.baseline_start or date(ir.end.year - 4, 1, 1)).year
        return f"S2L2A:drymedian{y0}+drymedian{ir.end.year}"


def _bbox_geom(b) -> dict:
    x0, y0, x1, y1 = b
    return {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}
