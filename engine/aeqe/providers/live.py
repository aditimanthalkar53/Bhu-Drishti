"""Live provider: real satellite data for every district in India (and custom AOIs).

Data sources (see ``aeqe.sources``):

* Planetary Computer — Sentinel-1 RTC, Sentinel-2 L2A, ESA WorldCover, Copernicus DEM (primary)
* Copernicus Data Space — Sentinel-1 catalogue cross-check, server-side statistics (supporting)
* Earth Engine — AlphaEarth embeddings as extra proxy covariates (optional)
* NASA FIRMS — active-fire detections (census target; proxy for burned area)
* NASA Earthdata — GPM IMERG rainfall, MODIS NRT flood (supporting context)
* Open-Meteo — rain and river-discharge forecasts (supporting context, labelled as forecasts)

Workflows and what is measured:

* **Flooded cropland** (share or km²) — Sentinel-1 VV change detection: a
  pixel is flooded when it is open water in some pass inside the window but
  not in the dry-season reference (Feb–Apr), lies on WorldCover cropland, is
  not permanent water, and the terrain slope is ≤ 5° (Copernicus DEM; steep
  slopes give radar shadow look-alikes). One regional VV threshold (Otsu on
  the event overview, clamped to −24…−14 dB, else −18 dB) is used for every
  tile so tiles are comparable. Follows the UN-SPIDER recommended practice for
  SAR flood mapping, simplified.
* **New built-up area** (km²) — bi-temporal Sentinel-2 dry-season (Jan–Mar)
  median composites with SCL cloud masking; new built-up = NDBI > 0 ∧ NDVI < 0.25
  in the target year and not in the baseline year. A spectral rule, not a
  trained model: bare soil and dry riverbeds can look built.
* **Burned cropland** (km² or share) — Sentinel-2 dNBR between a pre-window
  and a post-window composite (dNBR > 0.27 and post NBR < 0.1, on cropland).
  Proxy for sampling: FIRMS detection density. Harvested-but-unburned paddy
  also lowers NBR, so this over-detects without the FIRMS corroboration that
  is reported per tile.
* **Active fires** (count / which areas) — FIRMS detections are a complete
  catalogue, so every tile is counted exactly; no sampling, no interval.

Brick kilns and point VQA have no open model here and are refused by validation.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import numpy as np

from ..ir import CENSUS_TARGETS, QueryIR, Target, Task
from ..sources.base import SourceError, redact
from ..sources.copernicus import copernicus
from ..sources.earthdata import earthdata
from ..sources.earthengine import earth_engine, embedding_pcs
from ..sources.firms import firms
from ..sources.openmeteo import open_meteo
from ..sources.planetary import planetary
from .base import Check, Oracle, OracleOutput, Provider, Region, TileUniverse, report_status
from .planetary import (WORLDCOVER_BUILT, WORLDCOVER_CROPLAND, WORLDCOVER_WATER, fraction_per_tile, grid_tiles,
                        otsu_threshold, tile_area_km2)

DATA_FILE = Path(__file__).resolve().parents[1] / "data" / "india_districts.json"
TILE_CHOICES = (0.01, 0.02, 0.025, 0.05, 0.1)
MAX_TILES = 8000
SLOPE_MAX_DEG = 5.0
DNBR_BURN = 0.27
NBR_POST_MAX = 0.1
CHAR_B08_MAX = 0.15   # surface reflectance: ash/char is dark; harvested straw is brighter
CHAR_B12_MAX = 0.15
ORACLE_RES = 0.0002   # ≈ 20 m
S2_RES = 0.0001       # ≈ 10 m


# ---------------------------------------------------------------------------- pure helpers (unit tested)

def choose_tile_deg(bbox, max_tiles: int = MAX_TILES) -> float:
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    for td in TILE_CHOICES:
        if math.ceil(w / td) * math.ceil(h / td) <= max_tiles:
            return td
    return TILE_CHOICES[-1]


def regional_threshold(db: np.ndarray) -> tuple[float, str]:
    t = otsu_threshold(db)
    if t is None or not (-24.0 <= t <= -14.0):
        return -18.0, "fixed −18 dB (event histogram not bimodal enough for Otsu)"
    return float(t), "Otsu on the regional event overview"


def to_db(lin: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return 10 * np.log10(np.clip(lin, 1e-6, None))


def slope_deg(dem: np.ndarray, res_deg: float, lat: float) -> np.ndarray:
    dy = res_deg * 111320.0
    dx = res_deg * 111320.0 * math.cos(math.radians(lat))
    gy, gx = np.gradient(np.nan_to_num(dem, nan=np.nanmean(dem) if np.isfinite(dem).any() else 0.0), dy, dx)
    return np.degrees(np.arctan(np.hypot(gx, gy)))


def flood_change_mask(event_db, ref_db, wc, slope, inside, thr):
    """Flooded cropland = new water vs dry-season reference, on cropland, not permanent water, gentle slope."""
    valid = np.isfinite(event_db) & np.isfinite(ref_db)
    crop = (wc == WORLDCOVER_CROPLAND) & inside
    water_now = event_db < thr
    water_ref = ref_db < thr
    flooded = water_now & ~water_ref & crop & (wc != WORLDCOVER_WATER) & (slope <= SLOPE_MAX_DEG) & valid
    return flooded, crop & valid, crop


def nbr(b08, b12):
    with np.errstate(divide="ignore", invalid="ignore"):
        return (b08 - b12) / (b08 + b12)


def burn_mask(nbr_pre, nbr_post, crop, b08_post=None, b12_post=None):
    """Burn scar = NBR dropped AND the field is dark (char/ash).

    Harvesting paddy also drops NBR (green → straw), so dNBR alone mostly maps
    harvest. Freshly burned fields are dark in NIR and SWIR-2, while harvested
    stubble is bright straw — the darkness test separates them."""
    d = nbr_pre - nbr_post
    valid = np.isfinite(d)
    m = (d > DNBR_BURN) & (nbr_post < NBR_POST_MAX) & crop & valid
    if b08_post is not None and b12_post is not None:
        with np.errstate(invalid="ignore"):
            m &= (b08_post < CHAR_B08_MAX) & (b12_post < CHAR_B12_MAX)
    return m, crop & valid


def grid_coords(bbox, shape) -> tuple[np.ndarray, np.ndarray]:
    """Pixel-centre lon (xs) and lat (ys, north→south) of an EPSG:4326 array over bbox."""
    ny, nx = shape[-2], shape[-1]
    xs = bbox[0] + (np.arange(nx) + 0.5) * (bbox[2] - bbox[0]) / nx
    ys = bbox[3] - (np.arange(ny) + 0.5) * (bbox[3] - bbox[1]) / ny
    return xs, ys


def dry_reference_window(start: date) -> tuple[date, date]:
    y = start.year if start.month >= 6 else start.year - 1
    return date(y, 2, 1), date(y, 4, 30)


def builtup_from_stack(b03, b04, b08, b11) -> np.ndarray:
    """Persistent built-up from a (time, y, x) stack: bright in SWIR, never green, not water.

    Cropland and fallow fields turn green in at least one scene of a season, so
    ``max NDVI`` rejects them; NDBI alone (one composite) cannot. Returns 1/0 with
    NaN where no clear observation exists."""
    with np.errstate(all="ignore"):
        ndbi = (b11 - b08) / (b11 + b08)
        ndvi = (b08 - b04) / (b08 + b04)
        mndwi = (b03 - b11) / (b03 + b11)
        med_ndbi = np.nanmedian(ndbi, axis=0)
        max_ndvi = np.nanmax(ndvi, axis=0)
        med_mndwi = np.nanmedian(mndwi, axis=0)
    m = ((med_ndbi > 0.05) & (max_ndvi < 0.25) & (med_mndwi < 0)).astype(float)
    m[~np.isfinite(med_ndbi)] = np.nan
    return m


def _spread(items: list, k: int) -> list:
    """``k`` items evenly spaced in time (deterministic) — enough for a stable median."""
    xs = sorted(items, key=lambda i: (str(i.properties.get("datetime")), i.id))
    if len(xs) <= k:
        return xs
    step = len(xs) / k
    return [xs[int(j * step)] for j in range(k)]


def _clearest(items: list, k: int) -> list:
    """The ``k`` least-cloudy STAC items (Sentinel-2), deterministic order."""
    return sorted(items, key=lambda i: (float(i.properties.get("eo:cloud_cover", 100.0)), i.id))[:k]


S2_OFFSET_FROM = np.datetime64("2022-01-25")


def s2_reflectance(da) -> np.ndarray:
    """Surface reflectance from Sentinel-2 L2A digital numbers.

    Processing baseline 04.00 (acquisitions from 25 Jan 2022) adds a +1000 DN
    offset (BOA_ADD_OFFSET = -1000); ignoring it biases every band ratio.
    reflectance = (DN - offset) / 10000, with 0 treated as nodata."""
    a = da.values.astype(float)
    a[a == 0] = np.nan
    if "time" in da.dims:
        t = da["time"].values
        shift = np.where(t >= S2_OFFSET_FROM, 1000.0, 0.0).reshape((-1,) + (1,) * (a.ndim - 1))
        a = a - shift
    return a / 10000.0


def s2_clear(ds) -> np.ndarray:
    """SCL-based clear-sky mask: drop no-data, saturated, cloud shadow, clouds, cirrus, snow."""
    scl = ds["SCL"].values
    return ~np.isin(scl, [0, 1, 3, 8, 9, 10, 11])


# ---------------------------------------------------------------------------- oracles

class _LiveOracle(Oracle):
    def __init__(self, p: "LiveProvider", ir: QueryIR):
        self.p, self.ir = p, ir

    def _inside(self, bbox, shape) -> np.ndarray:
        xs, ys = grid_coords(bbox, shape)
        X, Y = np.meshgrid(xs, ys)
        return self.p.contains(self.ir.region_id, X, Y)


class S1FloodChangeOracle(_LiveOracle):
    name = "s1_flood_change"
    model_version = "vv-change-0.2"
    sensor = "sentinel-1"
    unit = "km²"
    description = ("Sentinel-1 RTC VV change detection vs dry-season reference, on WorldCover cropland, "
                   "excluding permanent water and slopes > 5° (Copernicus DEM)")

    def params_key(self, ir: QueryIR) -> str:
        r0, r1 = dry_reference_window(ir.start)
        return f"vv;ref={r0}..{r1}:spread12;thr=regional;slope<={SLOPE_MAX_DEG};worldcover"

    def run(self, u: TileUniverse, idx: int, ir: QueryIR) -> OracleOutput:
        bbox = tuple(float(v) for v in u.bboxes[idx])
        thr = float(u.extra["threshold_db"])
        ev = self.p.items_for_tile("s1_event", ir, bbox)
        ref = _spread(self.p.items_for_tile("s1_ref", ir, bbox), 12)
        if not ev:
            return OracleOutput(0.0, {"no_data": True, "reason": "no Sentinel-1 pass covers this tile in the window"})
        pc = self.p.pc
        e = pc.load(ev, ["vv"], bbox, ORACLE_RES)["vv"]
        event_db = to_db(e.min("time").values if "time" in e.dims else e.values)
        if ref:
            ref_db = self.p.reference_db(ref, bbox, ORACLE_RES)   # same for every question this season: cached
        else:
            ref_db = np.full_like(event_db, 0.0)   # no reference: treat as dry (documented caveat)
        shape = event_db.shape
        wc = self.p.worldcover_tile(bbox, shape)
        dem = pc.dem(bbox, ORACLE_RES, items=self.p.static_items("dem", ir.region_id))
        dem = _fit(dem, shape)
        slope = slope_deg(dem, ORACLE_RES, (bbox[1] + bbox[3]) / 2)
        inside = self._inside(bbox, shape)
        flooded, crop_obs, crop = flood_change_mask(event_db, _fit(ref_db, shape), wc, slope, inside, thr)
        n_crop_obs = int(crop_obs.sum())
        share = float(flooded.sum() / n_crop_obs) if n_crop_obs else 0.0
        value = share * float(u.base_km2[idx])
        return OracleOutput(value, {
            "flooded_share_of_cropland": round(share, 4), "threshold_db": round(thr, 2),
            "event_passes": len(ev), "reference_passes": len(ref),
            "observed_cropland_share": round(n_crop_obs / max(int(crop.sum()), 1), 3),
            "slope_excluded_cropland_px": int((crop & (slope > SLOPE_MAX_DEG)).sum()),
            "flooded_km2_pixels": round(float(flooded.sum()) * _px_km2(ORACLE_RES, bbox), 4),
            "event_items": [i.id for i in ev[:3]], "method": "change_detection",
        })


class S2BuiltChangeOracle(_LiveOracle):
    name = "s2_builtup_change"
    model_version = "ndbi-maxndvi-scl-0.4"
    sensor = "sentinel-2"
    unit = "km²"
    description = ("Bi-temporal Sentinel-2 L2A Jan–Mar stacks (8 clearest scenes, SCL cloud mask, 20 m); built-up = median NDBI > 0.05, "
                   "never green (max NDVI < 0.25) and not water (median MNDWI < 0); new = built(t1) ∧ ¬built(t0)")

    def params_key(self, ir: QueryIR) -> str:
        return f"baseline={_baseline_year(ir)};ndbi>0.05;maxndvi<0.25;mndwi<0;scl;best8;20m"

    def _built(self, bbox, which: str) -> Optional[np.ndarray]:
        items = _clearest(self.p.items_for_tile(which, self.ir, bbox), 8)
        if not items:
            return None
        ds = self.p.pc.load(items, ["B03", "B04", "B08", "B11", "SCL"], bbox, ORACLE_RES)
        clear = s2_clear(ds)
        b = {}
        for k in ("B03", "B04", "B08", "B11"):
            a = s2_reflectance(ds[k])
            a[~clear] = np.nan
            b[k] = a if a.ndim == 3 else a[None]
        return builtup_from_stack(b["B03"], b["B04"], b["B08"], b["B11"])

    def run(self, u: TileUniverse, idx: int, ir: QueryIR) -> OracleOutput:
        bbox = tuple(float(v) for v in u.bboxes[idx])
        b0, b1 = self._built(bbox, "s2_base"), self._built(bbox, "s2_target")
        if b0 is None or b1 is None:
            return OracleOutput(0.0, {"no_data": True, "reason": "no clear Sentinel-2 scene for one of the years"})
        h, w = min(b0.shape[0], b1.shape[0]), min(b0.shape[1], b1.shape[1])
        b0, b1 = b0[:h, :w], b1[:h, :w]
        inside = self._inside(bbox, (h, w))
        valid = np.isfinite(b0) & np.isfinite(b1) & inside
        new = (b1 == 1) & (b0 == 0) & valid
        obs = valid.sum() / max(inside.sum(), 1)
        # scale the observed share to the tile's in-region area
        share = float(new.sum() / max(valid.sum(), 1))
        value = share * float(u.base_km2[idx])
        return OracleOutput(value, {"new_builtup_share": round(share, 4), "observed_share": round(float(obs), 3),
                                    "baseline_year": _baseline_year(ir), "target_year": ir.end.year})


class S2BurnOracle(_LiveOracle):
    name = "s2_dnbr_burn"
    model_version = "dnbr-char-0.2"
    sensor = "sentinel-2"
    unit = "km²"
    description = (f"Sentinel-2 dNBR (pre − post) > {DNBR_BURN}, post NBR < {NBR_POST_MAX} and a dark char surface "
                   f"(post NIR < {CHAR_B08_MAX}, SWIR-2 < {CHAR_B12_MAX} reflectance) on WorldCover cropland (SCL cloud mask)")

    def params_key(self, ir: QueryIR) -> str:
        return f"dnbr>{DNBR_BURN};post<{NBR_POST_MAX};char<{CHAR_B08_MAX},{CHAR_B12_MAX};pre=25d;post=last10d+5;best4;refl"

    def _composite(self, bbox, which: str):
        """Median NBR, B08 and B12 reflectance over the clearest scenes, or None."""
        items = _clearest(self.p.items_for_tile(which, self.ir, bbox), 4)
        if not items:
            return None
        ds = self.p.pc.load(items, ["B08", "B12", "SCL"], bbox, ORACLE_RES)
        clear = s2_clear(ds)
        b08, b12 = s2_reflectance(ds["B08"]), s2_reflectance(ds["B12"])
        b08[~clear] = np.nan
        b12[~clear] = np.nan
        with np.errstate(all="ignore"):
            v = nbr(b08, b12)
            med = (lambda a: np.nanmedian(a, axis=0) if a.ndim == 3 else a)
            return med(v), med(b08), med(b12)

    def run(self, u: TileUniverse, idx: int, ir: QueryIR) -> OracleOutput:
        bbox = tuple(float(v) for v in u.bboxes[idx])
        pre, post = self._composite(bbox, "s2_pre"), self._composite(bbox, "s2_post")
        det = int(u.extra.get("firms_tile_counts", np.zeros(u.n))[idx])
        if pre is None or post is None:
            return OracleOutput(0.0, {"no_data": True, "reason": "no clear Sentinel-2 scene before or after", "firms_detections": det})
        h, w = min(pre[0].shape[0], post[0].shape[0]), min(pre[0].shape[1], post[0].shape[1])
        nbr_pre, nbr_post = pre[0][:h, :w], post[0][:h, :w]
        b08p, b12p = post[1][:h, :w], post[2][:h, :w]
        wc = self.p.worldcover_tile(bbox, (h, w))
        crop = (wc == WORLDCOVER_CROPLAND) & self._inside(bbox, (h, w))
        burned, crop_obs = burn_mask(nbr_pre, nbr_post, crop, b08p, b12p)
        share = float(burned.sum() / max(crop_obs.sum(), 1))
        return OracleOutput(share * float(u.base_km2[idx]), {
            "burned_share_of_cropland": round(share, 4), "observed_cropland_share": round(float(crop_obs.sum() / max(crop.sum(), 1)), 3),
            "firms_detections": det})


class FirmsCountOracle(Oracle):
    name = "firms_detections"
    model_version = "firms-area-api"
    sensor = "viirs+modis"
    unit = "detections"
    description = "NASA FIRMS VIIRS (375 m) + MODIS (1 km) active-fire detections, NRT and standard products, de-duplicated"

    def run(self, u, idx, ir):  # census targets never call the oracle per tile
        return OracleOutput(float(u.extra["census_values"][idx]), {})


# ---------------------------------------------------------------------------- provider

class LiveProvider(Provider):
    name = "live"

    def __init__(self, data_dir: str | Path = "./data"):
        self.data_dir = Path(data_dir)
        (self.data_dir / "static").mkdir(parents=True, exist_ok=True)
        self.pc, self.cdse, self.ee = planetary(), copernicus(), earth_engine()
        self.firms, self.ed, self.om = firms(), earthdata(), open_meteo()
        self._regions = self._load_regions()
        self._by_id = {r.id: r for r in self._regions}
        self._shapes: dict = {}
        self._items: dict = {}
        self._universes: dict = {}
        self._static: dict = {}
        self._lock = threading.RLock()
        self._wc_cache: dict = {}

    # -- regions ------------------------------------------------------------------------
    def _load_regions(self) -> list[Region]:
        out: list[Region] = []
        if DATA_FILE.exists():
            doc = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            for d in doc["districts"]:
                out.append(Region(d["id"], d["name"], tuple(d["bbox"]), d["geometry"], False,
                                  f"{d['name']} district, {d['state'] or 'India'} — live Sentinel/NASA data", d["state"],
                                  "district", d.get("area_km2_approx")))
        extra = os.getenv("AEQE_REGIONS")
        if extra and Path(extra).exists():
            for f in json.loads(Path(extra).read_text(encoding="utf-8"))["features"]:
                out.append(_region_from_feature(f, "custom"))
        cp = self.data_dir / "custom_regions.json"
        if cp.exists():
            for f in json.loads(cp.read_text(encoding="utf-8")).get("features", []):
                out.append(_region_from_feature(f, "custom"))
        return out

    def regions(self) -> list[Region]:
        return self._regions

    def region(self, region_id: str) -> Optional[Region]:
        return self._by_id.get(region_id)

    def add_custom_region(self, rid: str, name: str, geometry: dict, description: str = "") -> Region:
        from shapely.geometry import mapping, shape

        g = shape(geometry).buffer(0)
        if g.is_empty or g.geom_type not in ("Polygon", "MultiPolygon"):
            raise ValueError("geometry must be a non-empty Polygon or MultiPolygon")
        b = g.bounds
        if not (-180 <= b[0] < b[2] <= 180 and -90 <= b[1] < b[3] <= 90):
            raise ValueError("geometry must be in lon/lat (EPSG:4326)")
        area = g.area * 111.32 ** 2 * math.cos(math.radians(g.centroid.y))
        if area > 120000:
            raise ValueError(f"area of interest is {area:,.0f} km²; keep it under 120,000 km²")
        f = {"type": "Feature", "geometry": mapping(g),
             "properties": {"id": rid, "name": name, "description": description, "area_km2": round(area, 1)}}
        r = _region_from_feature(f, "custom")
        with self._lock:
            cp = self.data_dir / "custom_regions.json"
            doc = json.loads(cp.read_text(encoding="utf-8")) if cp.exists() else {"type": "FeatureCollection", "features": []}
            doc["features"] = [x for x in doc["features"] if x["properties"]["id"] != rid] + [f]
            cp.write_text(json.dumps(doc), encoding="utf-8")
            self._regions = [x for x in self._regions if x.id != rid] + [r]
            self._by_id[rid] = r
            self._shapes.pop(rid, None)
        return r

    def remove_custom_region(self, rid: str) -> bool:
        with self._lock:
            r = self._by_id.get(rid)
            if r is None or r.kind != "custom":
                return False
            cp = self.data_dir / "custom_regions.json"
            if cp.exists():
                doc = json.loads(cp.read_text(encoding="utf-8"))
                doc["features"] = [x for x in doc["features"] if x["properties"]["id"] != rid]
                cp.write_text(json.dumps(doc), encoding="utf-8")
            self._regions = [x for x in self._regions if x.id != rid]
            self._by_id.pop(rid, None)
            return True

    def shape(self, rid: str):
        with self._lock:
            if rid not in self._shapes:
                import shapely
                from shapely.geometry import shape

                g = shape(self._by_id[rid].geometry).buffer(0)
                shapely.prepare(g)
                self._shapes[rid] = g
            return self._shapes[rid]

    def contains(self, rid: str, X: np.ndarray, Y: np.ndarray) -> np.ndarray:
        import shapely

        return shapely.contains_xy(self.shape(rid), X, Y)

    def supports(self, target: Target) -> bool:
        return target in (Target.FLOODED_CROPLAND, Target.NEW_BUILTUP, Target.BURNED_CROPLAND, Target.ACTIVE_FIRE)

    # -- item discovery (region-level, cached) -------------------------------------------
    def _window_items(self, which: str, ir: QueryIR) -> list:
        r = self.region(ir.region_id)
        # the dry-season reference depends only on the season, so questions with different dates share it
        key = (which, ir.region_id, dry_reference_window(ir.start)) if which == "s1_ref" else               (which, ir.region_id, ir.start, ir.end, ir.baseline_start)
        with self._lock:
            if key in self._items:
                return self._items[key]
        bbox = r.bbox
        if which == "s1_event":
            items = self.pc.search("sentinel-1-rtc", bbox, ir.start, ir.end, limit=300)
        elif which == "s1_ref":
            a, b = dry_reference_window(ir.start)
            items = self.pc.search("sentinel-1-rtc", bbox, a, b, limit=300)
        elif which in ("s2_base", "s2_target"):
            y = _baseline_year(ir) if which == "s2_base" else ir.end.year
            items = self.pc.search("sentinel-2-l2a", bbox, date(y, 1, 1), date(y, 3, 31), query={"eo:cloud_cover": {"lt": 40}}, limit=400)
        elif which == "s2_pre":
            items = self.pc.search("sentinel-2-l2a", bbox, ir.start - timedelta(days=25), ir.start - timedelta(days=1),
                                   query={"eo:cloud_cover": {"lt": 50}}, limit=400)
        elif which == "s2_post":
            items = self.pc.search("sentinel-2-l2a", bbox, max(ir.start, ir.end - timedelta(days=10)),
                                   min(ir.end + timedelta(days=5), date.today()), query={"eo:cloud_cover": {"lt": 50}}, limit=400)
        else:
            raise KeyError(which)
        with self._lock:
            self._items[key] = items
            if len(self._items) > 256:
                self._items.pop(next(iter(self._items)))
        return items

    def reference_db(self, items: list, bbox, res: float) -> np.ndarray:
        """Median dry-season Sentinel-1 VV (dB) for ``bbox``. It does not depend on the question's dates, so it is
        computed once and kept on disk. The key includes the exact passes used, so new imagery is never
        mixed with a stale composite."""
        ids = ",".join(sorted(i.id for i in items))
        key = hashlib.sha1(f"{ids}|{','.join(f'{float(v):.5f}' for v in bbox)}|{res:.7f}".encode()).hexdigest()
        path = self.data_dir / "refcache" / key[:2] / f"{key}.npy"
        if path.exists():
            try:
                return np.load(path).astype(float)
            except (OSError, ValueError):
                pass   # unreadable cache entry: recompute below
        rr = self.pc.load(items, ["vv"], bbox, res)["vv"]
        ref_db = to_db(rr.median("time").values if "time" in rr.dims else rr.values)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".{threading.get_ident()}.tmp")
            with open(tmp, "wb") as f:
                np.save(f, ref_db.astype(np.float32))
            tmp.replace(path)
        except OSError:
            pass   # a full or read-only disk only costs speed
        return ref_db

    def items_for_tile(self, which: str, ir: QueryIR, bbox) -> list:
        items = self._window_items(which, ir)
        return [i for i in items if _bbox_overlap(i.bbox, bbox)]

    def static_items(self, kind: str, rid: str) -> list:
        key = (kind, rid)
        with self._lock:
            if key in self._items:
                return self._items[key]
        bbox = self.region(rid).bbox
        items = self.pc.worldcover_items(bbox) if kind == "worldcover" else self.pc.search("cop-dem-glo-30", bbox, limit=200)
        with self._lock:
            self._items[key] = items
        return items

    def worldcover_tile(self, bbox, shape) -> np.ndarray:
        key = (tuple(round(v, 5) for v in bbox), shape)
        if key in self._wc_cache:
            return self._wc_cache[key]
        items = [i for i in self.pc.worldcover_items(bbox) if _bbox_overlap(i.bbox, bbox)]
        wc = _fit(self.pc.worldcover(bbox, (bbox[2] - bbox[0]) / shape[1], items=items), shape, nearest=True)
        if len(self._wc_cache) > 2000:
            self._wc_cache.clear()
        self._wc_cache[key] = wc
        return wc

    # -- static per-region layers (cached on disk) ---------------------------------------
    def static_layers(self, rid: str) -> dict:
        with self._lock:
            if rid in self._static:
                return self._static[rid]
        r = self.region(rid)
        td = choose_tile_deg(r.bbox)
        path = self.data_dir / "static" / f"{rid}_{td:g}.npz"
        if path.exists():
            z = np.load(path, allow_pickle=False)
            d = {k: z[k] for k in z.files}
            d["tile_ids"] = list(d["tile_ids"])
        else:
            import shapely

            ids, boxes = grid_tiles(r.bbox, td)
            g = self.shape(rid)
            frac = shapely.area(shapely.intersection(shapely.box(boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]), g)) / \
                np.maximum((boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1]), 1e-12)
            keep = frac > 0.01
            ids, boxes, frac = [t for t, k in zip(ids, keep) if k], boxes[keep], frac[keep]
            res = max(0.001, td / 10)
            report_status(f"First run in {r.name}: reading ESA WorldCover land cover and tiling the district (cached afterwards)…")
            wc = self.pc.worldcover(r.bbox, res, items=self.static_items("worldcover", rid))
            xs, ys = grid_coords(r.bbox, wc.shape)
            X, Y = np.meshgrid(xs, ys)
            inside = self.contains(rid, X, Y)
            crop = ((wc == WORLDCOVER_CROPLAND) & inside).astype(float)
            built = ((wc == WORLDCOVER_BUILT) & inside).astype(float)
            water = ((wc == WORLDCOVER_WATER) & inside).astype(float)
            ins = inside.astype(float)
            area = tile_area_km2(boxes)
            crop_f = np.nan_to_num(fraction_per_tile(crop, xs, ys, boxes))
            d = {"tile_ids": ids, "bboxes": boxes, "area_km2": area, "inside_frac": frac,
                 "inside_km2": area * np.clip(np.nan_to_num(fraction_per_tile(ins, xs, ys, boxes)), 0, 1),
                 "crop_km2": crop_f * area, "built_frac": np.nan_to_num(fraction_per_tile(built, xs, ys, boxes)),
                 "water_frac": np.nan_to_num(fraction_per_tile(water, xs, ys, boxes)), "tile_deg": np.array(td),
                 "wc_res": np.array(res), "wc": wc.astype(np.uint8), "region_bbox": np.array(r.bbox, dtype=float)}
            np.savez_compressed(path, **{k: (np.array(v) if k == "tile_ids" else v) for k, v in d.items()})
        with self._lock:
            self._static[rid] = d
            if len(self._static) > 16:
                self._static.pop(next(iter(self._static)))
        return d

    # -- validation ---------------------------------------------------------------------
    def check_inputs(self, ir: QueryIR) -> list[Check]:
        checks: list[Check] = []
        r = self.region(ir.region_id)
        checks.append(Check("Region known", r is not None, f"{r.name}, {r.state}" if r else f"unknown region '{ir.region_id}'"))
        if r is None:
            return checks
        ok, why = self.pc.configured()
        checks.append(Check("Live data libraries installed", ok, why))
        if not ok:
            return checks
        sup = self.supports(ir.target) and ir.task != Task.INSPECT
        checks.append(Check("Target supported with live data", sup,
                            ir.target.value if sup else "brick kilns and point inspection need a specialist model that is not wired "
                                                        "in for live data — use a demo district, or ask about floods, fires, burned "
                                                        "cropland or new construction"))
        if not sup:
            return checks
        today = date.today()
        checks.append(Check("Window not in the future", ir.start <= today, f"{ir.start} … {ir.end} (today {today})"))
        try:
            if ir.target == Target.FLOODED_CROPLAND:
                ev = self._window_items("s1_event", ir)
                detail = f"{len(ev)} Sentinel-1 RTC scene(s) on Planetary Computer"
                if not ev:
                    detail += self._cdse_hint(r.bbox, ir.start, ir.end)
                checks.append(Check("Sentinel-1 scenes in window", bool(ev), detail))
                ref = self._window_items("s1_ref", ir)
                a, b = dry_reference_window(ir.start)
                checks.append(Check("Dry-season reference scenes", True,
                                    f"{len(ref)} scene(s) {a}…{b}" + ("" if ref else " — none: permanent water from WorldCover only"),
                                    blocking=False))
            elif ir.target == Target.NEW_BUILTUP:
                y0 = _baseline_year(ir)
                n0, n1 = len(self._window_items("s2_base", ir)), len(self._window_items("s2_target", ir))
                checks.append(Check("Sentinel-2 Jan–Mar scenes (cloud < 40%)", n0 > 0 and n1 > 0, f"{y0}: {n0}, {ir.end.year}: {n1}"))
                checks.append(Check("Baseline before target", y0 < ir.end.year, f"{y0} → {ir.end.year}"))
            elif ir.target == Target.BURNED_CROPLAND:
                checks.append(Check("Experimental workflow", True, "burn-scar thresholds are not yet calibrated against reference "
                                    "data — treat the number as indicative only; FIRMS fire counts are the validated signal",
                                    blocking=False))
                n0, n1 = len(self._window_items("s2_pre", ir)), len(self._window_items("s2_post", ir))
                checks.append(Check("Sentinel-2 scenes before / after (cloud < 50%)", n0 > 0 and n1 > 0, f"pre: {n0}, post: {n1}"))
                checks.append(Check("FIRMS (proxy for sampling)", self.firms.usable, self.firms.configured()[1], blocking=False))
            elif ir.target == Target.ACTIVE_FIRE:
                ok, why = self.firms.configured()
                checks.append(Check("NASA FIRMS configured", ok and self.firms.usable, why if ok else f"{why} — get a free MAP_KEY"))
                if ok:
                    av = self.firms.availability()
                    hi = max((v[1] for k, v in av.items() if k.endswith("_NRT")), default=None)
                    checks.append(Check("FIRMS data covers the window", hi is not None and ir.start <= hi,
                                        f"newest NRT detection date {hi}"))
        except SourceError as e:
            checks.append(Check(f"{e.source} reachable", False, e.message))
        td = choose_tile_deg(r.bbox)
        cached = ir.region_id in self._static or (self.data_dir / "static" / f"{ir.region_id}_{td:g}.npz").exists()
        checks.append(Check("Tiling", True, f"{td:g}° tiles (~{(td * 111) ** 2:.1f} km²)" +
                            ("; land-cover layers cached" if cached else "; land-cover layers are computed when the run starts "
                                                                          "(first run in this area takes longer)"), blocking=False))
        st_ee = self.ee.status()
        emb_ok = self.ee.usable and self.ee.configured()[0]
        checks.append(Check("AlphaEarth embeddings (optional proxy)", True,
                            f"will be tried ({st_ee['status']}); the run falls back to raster proxies if Earth Engine refuses"
                            if emb_ok else f"not used — {st_ee['detail'][:160]}", blocking=False))
        return checks

    def _cdse_hint(self, bbox, start, end) -> str:
        if not self.cdse.usable:
            return ""
        try:
            acq = self.cdse.s1_acquisitions(bbox, start, end)
        except SourceError:
            return ""
        if acq:
            return (f"; Copernicus lists {len(acq)} GRD acquisition(s) (latest {max(a['datetime'] for a in acq)}) — "
                    "RTC processing on Planetary Computer may still be pending, try again later")
        return "; Copernicus lists none either — widen the window (revisit is 6–12 days)"

    def choose_sensor(self, ir: QueryIR) -> tuple[str, str]:
        if ir.target == Target.FLOODED_CROPLAND:
            return "sentinel-1", "radar sees through monsoon cloud; change vs dry-season reference separates floods from normal water"
        if ir.target == Target.ACTIVE_FIRE:
            return "viirs+modis", "FIRMS thermal-anomaly detections are a complete catalogue for the window"
        if ir.target == Target.BURNED_CROPLAND:
            return "sentinel-2", "burn scars show as an NBR drop in short-wave infrared; FIRMS guides where to look"
        return "sentinel-2", "built-up change from optical spectra (NDBI/NDVI), dry season to avoid cloud"

    # -- universe -----------------------------------------------------------------------
    def universe(self, ir: QueryIR) -> TileUniverse:
        key = (ir.region_id, ir.target, ir.task, ir.start, ir.end, ir.baseline_start)
        with self._lock:
            if key in self._universes:
                return self._universes[key]
        r = self.region(ir.region_id)
        st = self.static_layers(ir.region_id)
        ids, boxes, area = st["tile_ids"], st["bboxes"], st["area_km2"]
        td = float(st["tile_deg"])
        extra: dict = {"provider": self.name, "tile_deg": td, "region": r.to_json(geometry=False)}
        feats, names = [], []
        if ir.target == Target.FLOODED_CROPLAND:
            res_o = max(0.002, td / 5)
            ev = self._window_items("s1_event", ir)
            report_status(f"Reading a coarse radar overview of {r.name} from {len(ev)} Sentinel-1 pass(es)…")
            e = self.pc.load(ev, ["vv"], r.bbox, res_o)["vv"]
            event_db = to_db(e.min("time").values if "time" in e.dims else e.values)
            xs, ys = grid_coords(r.bbox, event_db.shape)
            X, Y = np.meshgrid(xs, ys)
            inside = self.contains(ir.region_id, X, Y)
            thr, thr_method = regional_threshold(event_db[inside & np.isfinite(event_db)])
            ref = self._window_items("s1_ref", ir)
            if ref:
                report_status(f"Reading the dry-season reference ({len(ref)} radar passes) to tell floods from normal water…")
                ref_db = _fit(self.reference_db(ref, r.bbox, res_o), event_db.shape)
            else:
                ref_db = np.zeros_like(event_db)
            wet_now = (event_db < thr).astype(float)
            wet_new = ((event_db < thr) & ~(ref_db < thr)).astype(float)
            wet_now[~np.isfinite(event_db)] = np.nan
            wet_new[~np.isfinite(event_db)] = np.nan
            f_now = np.nan_to_num(fraction_per_tile(wet_now, xs, ys, boxes))
            f_new = np.nan_to_num(fraction_per_tile(wet_new, xs, ys, boxes))
            base = st["crop_km2"]
            score0 = f_new * base
            feats += [f_new, f_now, f_new * base, base, st["water_frac"]]
            names += ["s1_overview_new_water", "s1_overview_water", "new_water×cropland_km2", "cropland_km2", "worldcover_water"]
            keep = base > 0.02
            desc = (f"coarse (~{res_o * 111:.1f} km) Sentinel-1 VV new-water fraction vs dry-season reference × "
                    "WorldCover cropland area")
            extra.update(threshold_db=thr, threshold_method=thr_method, event_scenes=len(ev), reference_scenes=len(ref))
        elif ir.target == Target.NEW_BUILTUP:
            base = st["inside_km2"]
            bf = st["built_frac"]
            edge = bf * (1 - bf)
            score0 = edge + 0.25 * bf
            feats += [bf, edge, base]
            names += ["worldcover_built_fraction", "built_edge", "tile_km2"]
            keep = base > 0.01
            desc = "WorldCover built-up fraction and urban-edge score (growth happens at the edge of existing settlements)"
        elif ir.target in (Target.BURNED_CROPLAND, Target.ACTIVE_FIRE):
            report_status(f"Fetching NASA FIRMS fire detections for {r.name}…")
            dets, prov = self.firms.detections(r.bbox, ir.start, ir.end)
            lon = np.array([d["lon"] for d in dets]) if dets else np.zeros(0)
            lat = np.array([d["lat"] for d in dets]) if dets else np.zeros(0)
            ins = self.contains(ir.region_id, lon, lat) if len(dets) else np.zeros(0, bool)
            dets = [d for d, k in zip(dets, ins) if k]
            counts, per_tile = _bin_points(dets, boxes, td, r.bbox)
            extra.update(firms_tile_counts=counts, firms_detections=dets, firms_provenance=prov, firms_per_tile=per_tile)
            if ir.target == Target.ACTIVE_FIRE:
                base = st["inside_km2"]
                score0 = counts.astype(float)
                feats += [counts.astype(float)]
                names += ["firms_detections"]
                keep = base > 0.0
                extra["census_values"] = counts.astype(float)
                desc = "FIRMS detection count per tile (complete catalogue, counted exactly)"
            else:
                sm = _smooth_counts(counts, ids, td)
                base = st["crop_km2"]
                score0 = sm * base + 0.01 * base
                feats += [counts.astype(float), sm, sm * base, base]
                names += ["firms_detections", "firms_density_3x3", "firms×cropland", "cropland_km2"]
                keep = base > 0.02
                desc = "FIRMS fire-detection density (3×3 tile neighbourhood) × WorldCover cropland area"
        else:
            raise ValueError(f"unsupported target {ir.target}")

        report_status("Adding AlphaEarth embedding features (if Earth Engine is available)…")
        pcs = self._embedding_pcs(ir, boxes)
        if pcs is not None:
            feats += list(pcs.T)
            names += [f"alphaearth_pc{i}" for i in range(pcs.shape[1])]
            desc += f", plus {pcs.shape[1]} AlphaEarth embedding PCs"
            extra["embeddings"] = "alphaearth"
        X = np.column_stack(feats)
        keep_idx = np.flatnonzero(keep)
        sub = {k: (v[keep] if isinstance(v, np.ndarray) and v.shape[:1] == (len(ids),) else v) for k, v in extra.items()}
        if "firms_per_tile" in extra:
            sub["firms_per_tile"] = [extra["firms_per_tile"][i] for i in keep_idx]
        u = TileUniverse(ir.region_id, [ids[i] for i in keep_idx], boxes[keep], area[keep], base[keep], X[keep], names,
                         score0[keep], desc, sub)
        with self._lock:
            self._universes[key] = u
            if len(self._universes) > 32:
                self._universes.pop(next(iter(self._universes)))
        return u

    def _embedding_pcs(self, ir: QueryIR, boxes: np.ndarray) -> Optional[np.ndarray]:
        if not (self.ee.configured()[0] and self.ee.usable):
            return None
        from ..sources.registry import source_cache
        from ..sources.ttlcache import TTLCache

        year = min(ir.end.year - 1 if ir.target == Target.FLOODED_CROPLAND else ir.end.year, date.today().year - 1)
        ck = TTLCache.key("alphaearth", ir.region_id, year, boxes.shape, float(boxes[:, 2].max() - boxes[:, 0].min()))
        cached = source_cache().get(ck)
        try:
            E = np.array(cached, dtype=float) if cached is not None else self.ee.tile_embeddings(boxes, year)
        except SourceError:
            return None   # recorded on the source; run continues with raster proxies
        if cached is None:
            source_cache().put(ck, np.where(np.isfinite(E), E, None).tolist(), 30 * 86400)
        return embedding_pcs(E)

    def oracle(self, ir: QueryIR, sensor: str) -> Oracle:
        if ir.target == Target.FLOODED_CROPLAND:
            return S1FloodChangeOracle(self, ir)
        if ir.target == Target.NEW_BUILTUP:
            return S2BuiltChangeOracle(self, ir)
        if ir.target == Target.BURNED_CROPLAND:
            return S2BurnOracle(self, ir)
        return FirmsCountOracle()

    def scene_key(self, ir: QueryIR, sensor: str) -> str:
        def ids(which):
            xs = sorted(i.id for i in self._window_items(which, ir))
            return "+".join(xs) if len(xs) <= 4 else f"{len(xs)}items:{_stable_hash(xs)}"
        if ir.target == Target.FLOODED_CROPLAND:
            return f"S1RTC:{ids('s1_event')}|ref:{ids('s1_ref')}"
        if ir.target == Target.NEW_BUILTUP:
            return f"S2L2A:{ids('s2_base')}|{ids('s2_target')}"
        if ir.target == Target.BURNED_CROPLAND:
            return f"S2L2A:pre:{ids('s2_pre')}|post:{ids('s2_post')}"
        return f"FIRMS:{ir.start}..{ir.end}:{date.today()}"

    # -- census (active fire) -----------------------------------------------------------
    def census_values(self, ir: QueryIR, u: TileUniverse):
        vals = np.asarray(u.extra["census_values"], dtype=float)
        dets = u.extra.get("firms_detections", [])
        per_tile = u.extra.get("firms_per_tile", [[] for _ in range(u.n)])
        details = []
        for i in range(u.n):
            ds = per_tile[i]
            conf = {c: sum(1 for d in ds if d["confidence"] == c) for c in ("high", "nominal", "low")}
            frp = [d["frp_mw"] for d in ds if d.get("frp_mw") is not None]
            details.append({"detections": len(ds), "high": conf["high"], "nominal": conf["nominal"], "low": conf["low"],
                            "max_frp_mw": round(max(frp), 1) if frp else None,
                            "last_seen": max((f"{d['acq_date']} {d['acq_time_utc']}" for d in ds), default=None)})
        st = self.static_layers(ir.region_id)
        on_crop = _points_on_class(dets, st, WORLDCOVER_CROPLAND)
        by_day: dict[str, int] = {}
        for d in dets:
            by_day[d["acq_date"]] = by_day.get(d["acq_date"], 0) + 1
        conf_tot = {c: sum(1 for d in dets if d["confidence"] == c) for c in ("high", "nominal", "low", "unknown")}
        newest = max((f"{d['acq_date']} {d['acq_time_utc']} UTC" for d in dets), default=None)
        summary = {"detections": len(dets), "by_confidence": conf_tot, "on_cropland": on_crop, "by_day": dict(sorted(by_day.items())),
                   "tiles_with_detections": int((vals > 0).sum()), "newest_detection": newest,
                   "products": sorted({d["product"] for d in dets})}
        return vals, details, summary

    # -- supporting evidence -------------------------------------------------------------
    def supporting_evidence(self, ir: QueryIR, u: TileUniverse) -> list[dict]:
        r = self.region(ir.region_id)
        cy, cx = (r.bbox[1] + r.bbox[3]) / 2, (r.bbox[0] + r.bbox[2]) / 2
        g = self.shape(ir.region_id)
        try:
            pt = g.representative_point()
            cy, cx = pt.y, pt.x
        except Exception:  # noqa: BLE001
            pass
        jobs = []
        if ir.target == Target.FLOODED_CROPLAND:
            jobs += [("rainfall", self._ev_rainfall), ("modis_flood", self._ev_modis), ("cdse_s1", self._ev_cdse),
                     ("outlook", lambda ir, r: self._ev_outlook(cy, cx))]
        elif ir.target in (Target.BURNED_CROPLAND, Target.ACTIVE_FIRE):
            jobs += [("outlook", lambda ir, r: self._ev_outlook(cy, cx))]
            if ir.target == Target.BURNED_CROPLAND:
                jobs.append(("firms", lambda ir, r: self._ev_firms(u)))
        out = []
        with ThreadPoolExecutor(max_workers=4) as pool:
            futs = [(k, pool.submit(_safe_evidence, k, fn, ir, r)) for k, fn in jobs]
            for _, f in futs:
                out.append(f.result())
        return out

    def _ev_rainfall(self, ir, r) -> dict:
        start = ir.start - timedelta(days=7)
        res = self.ed.imerg_rainfall(r.bbox, start, min(ir.end, date.today()))
        self.ed.mark_used_end_to_end("IMERG rainfall attached to a flood run")
        return {"title": f"Rainfall (GPM IMERG {res['run']} run, {start} … {ir.end})", "source": "earthdata",
                "summary": (f"Area-mean total {res['total_mm']} mm over {res['days_with_data']} day(s); wettest day {res['max_day_mm']} mm."
                            if res["total_mm"] is not None else "No valid rainfall cells for the window."),
                "data": {k: res[k] for k in ("run", "product", "total_mm", "max_day_mm", "series", "days_with_data", "grid_cells")},
                "provenance": res["provenance"][:10], "role": "context: heavy rain makes flooding plausible but does not show it happened"}

    def _ev_modis(self, ir, r) -> dict:
        res = self.ed.mcdwd_flood(r.bbox, ir.start, ir.end)
        if not res.get("available"):
            return {"title": "MODIS NRT flood product", "source": "earthdata", "status": "unavailable", "summary": res["reason"]}
        shares = [d["flood_share_of_observed"] for d in res["per_day"] if d["flood_share_of_observed"] is not None]
        return {"title": "MODIS NRT Global Flood Product (2-day composite)", "source": "earthdata",
                "summary": (f"Up to {100 * max(shares):.1f}% of cloud-free pixels flagged as water beyond the reference"
                            if shares else "All pixels cloud-covered or missing (insufficient data)."),
                "data": res["per_day"], "provenance": res["provenance"][:10],
                "role": "independent optical cross-check (~250 m); cloud gaps are common in monsoon"}

    def _ev_cdse(self, ir, r) -> dict:
        acq = self.cdse.s1_acquisitions(r.bbox, ir.start, ir.end)
        stats = []
        span = max(r.bbox[2] - r.bbox[0], r.bbox[3] - r.bbox[1])
        if acq and span <= 2.5:
            thr = float(self.universe(ir).extra.get("threshold_db", -18.0))
            stats = self.cdse.s1_water_share(r.bbox, ir.start, ir.end, threshold_db=thr, res_deg=max(0.001, span / 1500))
        self.cdse.mark_used_end_to_end("catalogue cross-check + Statistical API in a flood run")
        return {"title": "Copernicus Data Space: Sentinel-1 GRD passes and server-side water share", "source": "copernicus",
                "summary": f"{len(acq)} GRD acquisition(s) in the window" +
                           (f"; region-wide share of pixels below the water threshold per pass: "
                            + ", ".join(f"{s['from'][:10]} {100 * s['water_share']:.1f}%" for s in stats) if stats else ""),
                "data": {"acquisitions": acq, "water_share_per_pass": stats,
                         "note": "includes permanent water and non-cropland; for corroboration only"},
                "provenance": self.cdse.provenance(acq)[:10],
                "role": "independent catalogue and processing chain (GRD γ0, not the RTC product used by the estimate)"}

    def _ev_outlook(self, lat, lon) -> dict:
        o = self.om.outlook(lat, lon, 7)
        self.om.mark_used_end_to_end("forecast attached to a run")
        dis = [d["m3s"] for d in o["river_discharge"] if d["m3s"] is not None]
        if len(dis) > 1 and max(dis) >= 1:
            river = f"; modelled discharge at the nearest GloFAS river cell {dis[0]:.0f} → {dis[-1]:.0f} m³/s (past 7 days → +7 days)"
        else:
            river = "; no significant modelled river at this point (GloFAS discharge ≈ 0)"
        return {"title": "Outlook: rain forecast and GloFAS river discharge (next 7 days)", "source": "open_meteo",
                "summary": f"Forecast rain {o['rain_forecast_total_mm']} mm over 7 days" + river,
                "data": o, "provenance": o["provenance"], "role": "MODEL FORECAST — not an observation"}

    def _ev_firms(self, u) -> dict:
        dets = u.extra.get("firms_detections", [])
        return {"title": "NASA FIRMS active-fire detections in the window", "source": "firms",
                "summary": f"{len(dets)} detection(s) inside the region (used only to decide where to sample)",
                "data": {"count": len(dets)}, "provenance": u.extra.get("firms_provenance", [])[:10],
                "role": "sampling guide and per-tile corroboration; a detection is not proof of residue burning"}

    # -- provenance / caveats --------------------------------------------------------------
    def inputs_provenance(self, ir: QueryIR) -> list[dict]:
        out = []
        groups = {Target.FLOODED_CROPLAND: [("s1_event", "sentinel-1-rtc", "vv", 10), ("s1_ref", "sentinel-1-rtc (reference)", "vv", 10)],
                  Target.NEW_BUILTUP: [("s2_base", "sentinel-2-l2a (baseline)", "B04,B08,B11,SCL", 10),
                                       ("s2_target", "sentinel-2-l2a (target)", "B04,B08,B11,SCL", 10)],
                  Target.BURNED_CROPLAND: [("s2_pre", "sentinel-2-l2a (pre)", "B08,B12,SCL", 20), ("s2_post", "sentinel-2-l2a (post)", "B08,B12,SCL", 20)]}
        for which, product, asset, res in groups.get(ir.target, []):
            out += self.pc.provenance(self._window_items(which, ir), product, asset, res)
        if ir.target != Target.ACTIVE_FIRE:
            out += self.pc.provenance(self.static_items("worldcover", ir.region_id), "esa-worldcover", "map", 10)
        if ir.target == Target.FLOODED_CROPLAND:
            out += self.pc.provenance(self.static_items("dem", ir.region_id), "cop-dem-glo-30", "data", 30)
        if ir.target in (Target.ACTIVE_FIRE, Target.BURNED_CROPLAND):
            u = self.universe(ir)
            out += u.extra.get("firms_provenance", [])
        return out

    def caveats(self, ir: QueryIR) -> list[str]:
        c = []
        if ir.target == Target.FLOODED_CROPLAND:
            c += ["Flood mask: Sentinel-1 VV below a regional threshold in some pass of the window but not in the dry-season "
                  "reference. Flooded vegetation and urban flooding are missed; wet soil and smooth dry surfaces can be confused.",
                  "Cropland comes from ESA WorldCover 2021, not the crop actually standing in the query year.",
                  "The cropland denominator is measured at ~100 m; the model works at ~20 m and reports a share per tile."]
        elif ir.target == Target.NEW_BUILTUP:
            c += ["New built-up uses a spectral rule (bright in short-wave infrared, never green in the season, not water), not a "
                  "trained model: quarries, brick fields, sand bars and long-fallow bare land can still be counted as built, and it "
                  "says nothing about whether a construction is permitted.",
                  "Sentinel-2 at 20 m: single houses and narrow roads are below the pixel size; dense new settlements are captured."]
        elif ir.target == Target.BURNED_CROPLAND:
            c += ["EXPERIMENTAL: the burned-cropland rule is not validated. In a live test (Sangrur, Oct–Nov 2025) the tile-level "
                  "burn share did not correlate with independent FIRMS detections, so the thresholds need calibration against "
                  "reference burned-area data before this number is used for decisions. Use the FIRMS fire count instead.",
                  "Burn scars need both an NBR drop and a dark (ash) surface, to separate burning from harvest. Fields burned and "
                  "then ploughed before the post-window image, or burned under haze, are missed; dark wet soil can be confused. "
                  "FIRMS detections per tile are shown for corroboration.",
                  "Cloud or haze in the pre/post windows leaves parts of tiles unobserved."]
        elif ir.target == Target.ACTIVE_FIRE:
            c += ["Counts are satellite detections (375 m VIIRS / 1 km MODIS pixels at overpass time), not individual fires or "
                  "fields: one field can produce several detections, and fires between overpasses or under cloud are missed.",
                  "A detection shows a thermal anomaly; it is not evidence of its cause or of who is responsible."]
        return c

    def on_job_done(self, ir: QueryIR, oracle_calls: int) -> None:
        if ir.target == Target.ACTIVE_FIRE:
            self.firms.mark_used_end_to_end("fire census completed")
            return
        if oracle_calls > 0:
            self.pc.mark_used_end_to_end(f"{ir.target.value} run completed with live oracle calls")
            if ir.target == Target.BURNED_CROPLAND:
                self.firms.mark_used_end_to_end("FIRMS proxy used in a burned-area run")
        if ir.target in (Target.FLOODED_CROPLAND, Target.NEW_BUILTUP, Target.BURNED_CROPLAND):
            pass

    # -- freshness ---------------------------------------------------------------------------
    def freshness(self, rid: str) -> dict:
        r = self.region(rid)
        if r is None:
            raise KeyError(rid)
        today = date.today()
        out: dict = {"region_id": rid, "checked": today.isoformat(), "items": []}

        def add(name, source, fn):
            try:
                v = fn()
                out["items"].append({"product": name, "source": source, **v})
            except SourceError as e:
                out["items"].append({"product": name, "source": source, "error": e.message, "kind": e.kind})
            except Exception as e:  # noqa: BLE001
                out["items"].append({"product": name, "source": source, "error": redact(e)[:200]})

        def latest_pc(col, days, q=None):
            items = self.pc.search(col, r.bbox, today - timedelta(days=days), today, query=q, limit=200)
            if not items:
                return {"latest": None, "note": f"none in the last {days} days"}
            dt = max(str(i.properties.get("datetime") or i.properties.get("start_datetime")) for i in items)
            return {"latest": dt, "count_window_days": days, "count": len(items)}

        add("Sentinel-1 RTC", "planetary_computer", lambda: latest_pc("sentinel-1-rtc", 30))
        add("Sentinel-2 L2A (cloud < 60%)", "planetary_computer", lambda: latest_pc("sentinel-2-l2a", 30, {"eo:cloud_cover": {"lt": 60}}))
        if self.cdse.usable:
            add("Sentinel-1 GRD", "copernicus", lambda: {"latest": (self.cdse.latest_s1(r.bbox) or {}).get("datetime")})
        if self.firms.usable:
            add("FIRMS NRT detections", "firms", lambda: {"latest": str(max(v[1] for k, v in self.firms.availability().items() if k.endswith("_NRT")))})
        add("GPM IMERG Early (daily)", "earthdata",
            lambda: {"latest": (self.ed.cmr_granules("GPM_3IMERGDE", today - timedelta(days=5), today, newest_first=True, limit=1) or [{}])[0].get("start")})
        add("MODIS NRT flood", "earthdata",
            lambda: {"latest": (self.ed.cmr_granules("MCDWD_L3_NRT", today - timedelta(days=5), today, bbox=r.bbox, newest_first=True, limit=1) or [{}])[0].get("start")})
        return out


# ---------------------------------------------------------------------------- small utilities

EVIDENCE_TITLES = {
    "rainfall": "Rainfall (GPM IMERG)", "modis_flood": "MODIS NRT flood product",
    "cdse_s1": "Copernicus Data Space: Sentinel-1 cross-check", "outlook": "Outlook: rain and river-discharge forecast",
    "firms": "NASA FIRMS detections",
}


def _safe_evidence(key, fn, ir, r) -> dict:
    try:
        d = fn(ir, r)
        d.setdefault("status", "ok")
    except SourceError as e:
        status = "not_configured" if e.kind == "not_configured" else "unavailable"
        d = {"title": EVIDENCE_TITLES.get(key, key), "source": e.source, "status": status, "summary": e.message}
    except Exception as e:  # noqa: BLE001
        d = {"title": EVIDENCE_TITLES.get(key, key), "source": "?", "status": "error", "summary": redact(f"{type(e).__name__}: {e}")[:300]}
    d["id"] = key
    d.setdefault("role", "supporting context — not used in the estimate")
    return d


def _region_from_feature(f: dict, kind: str) -> Region:
    from shapely.geometry import shape

    g = shape(f["geometry"])
    p = f.get("properties", {})
    area = p.get("area_km2") or round(g.area * 111.32 ** 2 * math.cos(math.radians(g.centroid.y)), 1)
    return Region(p["id"], p.get("name", p["id"]), tuple(round(v, 5) for v in g.bounds), f["geometry"], False,
                  p.get("description", "custom area of interest — live data"), p.get("state", ""), kind, area)


def _baseline_year(ir: QueryIR) -> int:
    return (ir.baseline_start or date(ir.end.year - 4, 1, 1)).year


def _bbox_overlap(a, b) -> bool:
    return not (a[2] <= b[0] or a[0] >= b[2] or a[3] <= b[1] or a[1] >= b[3])


def _px_km2(res: float, bbox) -> float:
    lat = math.radians((bbox[1] + bbox[3]) / 2)
    return (res * 111.32) ** 2 * math.cos(lat)


def _fit(arr: np.ndarray, shape, nearest: bool = False) -> np.ndarray:
    """Crop/pad or nearest-resample a 2-D array to ``shape`` (odc grids can differ by a pixel)."""
    a = np.asarray(arr)
    if a.ndim == 3:
        a = a[0]
    if a.shape == tuple(shape):
        return a
    ry = np.minimum((np.arange(shape[0]) * a.shape[0] / shape[0]).astype(int), a.shape[0] - 1)
    rx = np.minimum((np.arange(shape[1]) * a.shape[1] / shape[1]).astype(int), a.shape[1] - 1)
    return a[np.ix_(ry, rx)]


def _bin_points(dets: list[dict], boxes: np.ndarray, td: float, bbox) -> tuple[np.ndarray, list[list[dict]]]:
    counts = np.zeros(len(boxes), dtype=int)
    per = [[] for _ in range(len(boxes))]
    if not dets:
        return counts, per
    index = {(round(b[0] / td), round(b[3] / td)): i for i, b in enumerate(boxes)}
    for d in dets:
        cx = math.floor((d["lon"] - bbox[0]) / td)
        x0 = bbox[0] + cx * td
        cyr = math.floor((bbox[3] - d["lat"]) / td)
        y1 = bbox[3] - cyr * td
        i = index.get((round(x0 / td), round(y1 / td)))
        if i is not None:
            counts[i] += 1
            per[i].append(d)
    return counts, per


def _smooth_counts(counts: np.ndarray, ids: list[str], td: float) -> np.ndarray:
    """Mean detections in each tile's 3×3 neighbourhood (fires burn more fields than they are detected in)."""
    pos = {}
    for i, t in enumerate(ids):
        _, x, y = t.split(":")
        pos[(round(float(x) / td), round(float(y) / td))] = i
    out = np.zeros(len(ids))
    for (cx, cy), i in pos.items():
        s, n = 0.0, 0
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                j = pos.get((cx + dx, cy + dy))
                if j is not None:
                    s += counts[j]
                    n += 1
        out[i] = s / max(n, 1)
    return out


def _points_on_class(dets: list[dict], st: dict, cls: int) -> int:
    if not dets:
        return 0
    wc = st["wc"]
    ny, nx = wc.shape
    x0, y0, x1, y1 = (float(v) for v in st["region_bbox"])   # the static grid spans the region bbox
    n = 0
    for d in dets:
        c = int((d["lon"] - x0) / (x1 - x0) * nx)
        r = int((y1 - d["lat"]) / (y1 - y0) * ny)
        if 0 <= r < ny and 0 <= c < nx and wc[r, c] == cls:
            n += 1
    return n


def _stable_hash(xs) -> str:
    import hashlib

    return hashlib.sha1("|".join(xs).encode()).hexdigest()[:10]
