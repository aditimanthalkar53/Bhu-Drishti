"""A procedurally generated "digital twin" district for offline demos and tests.

Why a simulator? To prove the engine's statistical claims you need the answer
an exhaustive run would give. The simulator provides that cheaply and lets the
benchmark repeat a query hundreds of times with different seeds to measure
interval coverage. Every number it produces is labelled *simulated*.

What it models (per ~1 km tile on a 0.01° grid):

* terrain (elevation, distance to a meandering river), towns, forest, clay soil
* land cover fractions (cropland, built-up, water) — the *known* denominators
* a monsoon flood whose extent depends on the date window
* new built-up area between two years (town periphery growth + a highway)
* brick kilns (rare, clustered on clay near towns)
* a 64-d annual embedding per tile, linear in land-cover features plus noise
  (like AlphaEarth/Earth Index embeddings: they encode *what the land is*,
  not last week's flood)
* a coarse Sentinel-1 "overview" water signal (event-time cheap proxy)
* specialist oracles with their own small, deterministic errors
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from datetime import date, timedelta
from functools import lru_cache

import numpy as np
from scipy.ndimage import gaussian_filter, uniform_filter

from ..ir import QueryIR, Target, Task
from .base import Check, Oracle, OracleOutput, Provider, Region, TileUniverse

TILE_DEG = 0.01
EMB_DIM = 64
S1_EPOCH = date(2016, 1, 3)
S1_REVISIT_DAYS = 12
SIM_FIRST_YEAR, SIM_LAST_YEAR = 2017, 2025


def _stable_rng(*parts: object) -> np.random.Generator:
    h = hashlib.sha256("|".join(map(str, parts)).encode()).digest()
    return np.random.default_rng(int.from_bytes(h[:8], "little"))


def _point_in_polygon(xs: np.ndarray, ys: np.ndarray, poly: np.ndarray) -> np.ndarray:
    inside = np.zeros(xs.shape, dtype=bool)
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        cond = ((yi > ys) != (yj > ys)) & (xs < (xj - xi) * (ys - yi) / (yj - yi + 1e-12) + xi)
        inside ^= cond
        j = i
    return inside


def _sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


@dataclass(frozen=True)
class WorldSpec:
    id: str
    name: str
    bbox: tuple[float, float, float, float]
    seed: int
    description: str


WORLDS: list[WorldSpec] = [
    WorldSpec(
        "lower-brahmaputra-a",
        "Demo district A — Lower Brahmaputra floodplain (simulated)",
        (90.80, 26.20, 91.40, 26.65),
        11,
        "Simulated floodplain district: river, monsoon floods, towns, brick kilns.",
    ),
    WorldSpec(
        "lower-brahmaputra-b",
        "Demo district B — neighbouring district (simulated)",
        (91.40, 26.20, 92.00, 26.65),
        23,
        "Neighbouring simulated district with a different flood and growth pattern.",
    ),
]


class SimWorld:
    """All static fields of one simulated district."""

    def __init__(self, spec: WorldSpec):
        self.spec = spec
        rng = np.random.default_rng(spec.seed)
        minx, miny, maxx, maxy = spec.bbox
        self.W = int(round((maxx - minx) / TILE_DEG))
        self.H = int(round((maxy - miny) / TILE_DEG))
        H, W = self.H, self.W
        rr, cc = np.mgrid[0:H, 0:W].astype(float)

        def smooth(sigma: float) -> np.ndarray:
            z = gaussian_filter(rng.normal(size=(H, W)), sigma)
            return (z - z.mean()) / (z.std() + 1e-9)

        # --- district outline: a noisy ellipse polygon
        cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
        rx, ry = (maxx - minx) * 0.47, (maxy - miny) * 0.46
        angles = np.linspace(0, 2 * np.pi, 40, endpoint=False)
        wob = 1 + 0.10 * np.sin(3 * angles + rng.uniform(0, 6)) + 0.06 * np.sin(7 * angles + rng.uniform(0, 6))
        wob *= 1 + 0.04 * rng.normal(size=angles.size)
        poly = np.stack([cx + rx * wob * np.cos(angles), cy + ry * wob * np.sin(angles)], axis=1)
        self.polygon = poly
        lon_c = minx + (cc + 0.5) * TILE_DEG
        lat_c = maxy - (rr + 0.5) * TILE_DEG
        self.mask = _point_in_polygon(lon_c, lat_c, poly)

        # --- terrain
        phase = rng.uniform(0, 6)
        river_row = H * 0.48 + 5.5 * np.sin(cc / 9.0 + phase) + 2.5 * np.sin(cc / 4.1 + 2 * phase)
        self.dist_river = np.abs(rr - river_row)  # in tiles ≈ km
        self.elev = 30 + 0.55 * self.dist_river + 1.6 * smooth(5) + 0.06 * (H - rr)
        hills = _sigmoid((rr - H * 0.86) * 0.6) + 0.6 * _sigmoid((cc - W * 0.9) * 0.5) * _sigmoid((H * 0.25 - rr) * 0.5)
        self.elev += 14 * hills
        self.forest = np.clip(0.9 * hills + 0.1 * np.maximum(smooth(3), 0), 0, 0.95)
        self.water = np.clip(0.95 * _sigmoid((1.0 - self.dist_river) * 3.0) + 0.15 * np.maximum(smooth(1.5) - 1.8, 0), 0, 0.97)

        # --- towns (urban core) and growth potential
        n_towns = 5
        towns = []
        for _ in range(n_towns):
            while True:
                tr, tcol = rng.uniform(4, H - 4), rng.uniform(4, W - 4)
                if abs(tr - (H * 0.48 + 5.5 * math.sin(tcol / 9.0 + phase))) > 4:
                    break
            towns.append((tr, tcol, rng.uniform(1.2, 2.6)))
        self.towns = towns
        urban = np.zeros((H, W))
        periphery = np.zeros((H, W))
        self.town_dist = np.full((H, W), 99.0)
        for tr, tcol, s in towns:
            d2 = (rr - tr) ** 2 + (cc - tcol) ** 2
            urban += 0.9 * np.exp(-d2 / (2 * s**2))
            periphery += np.clip(np.exp(-d2 / (2 * (s + 2.2) ** 2)) - np.exp(-d2 / (2 * s**2)), 0, None)
            self.town_dist = np.minimum(self.town_dist, np.sqrt(d2))
        # highway: straight-ish line between two towns
        (r1, c1, _), (r2, c2, _) = towns[0], towns[1]
        seg = np.array([r2 - r1, c2 - c1])
        L = np.linalg.norm(seg) + 1e-9
        t = np.clip(((rr - r1) * seg[0] + (cc - c1) * seg[1]) / L**2, 0, 1)
        dist_hw = np.sqrt((rr - (r1 + t * seg[0])) ** 2 + (cc - (c1 + t * seg[1])) ** 2)
        self.highway = np.exp(-(dist_hw**2) / 2.0)
        self.urban0 = np.clip(urban, 0, 0.95)
        self.growth_potential = np.clip(0.55 * periphery + 0.35 * self.highway * (1 - self.urban0), 0, 1) * (
            0.6 + 0.4 * _sigmoid(smooth(2) * 2)
        )
        self.growth_potential *= 1 - self.water

        # --- soils and kilns (rare, clustered)
        self.clay = _sigmoid(1.6 * smooth(4) + 1.2 * (self.dist_river < 7) - 0.4)
        near_town = np.exp(-((self.town_dist - 6) ** 2) / (2 * 3.0**2))
        lam = 0.002 + 1.1 * (self.clay > 0.70) * near_town * (1 - self.water) * (1 - self.forest)
        lam *= np.exp(0.8 * smooth(1.2))
        self.kilns = rng.poisson(np.clip(lam, 0, 6)) * self.mask

        # --- embedding projection (fixed per world)
        self.W_emb = rng.normal(size=(EMB_DIM, 9)) / math.sqrt(9)

        # --- tile geometry
        idx = np.argwhere(self.mask)
        self.rows, self.cols = idx[:, 0], idx[:, 1]
        self.tile_ids = [f"{spec.id}:r{r:03d}c{c:03d}" for r, c in zip(self.rows, self.cols)]
        x0 = minx + self.cols * TILE_DEG
        y1 = maxy - self.rows * TILE_DEG
        self.bboxes = np.stack([x0, y1 - TILE_DEG, x0 + TILE_DEG, y1], axis=1)
        lat = np.radians(y1 - TILE_DEG / 2)
        self.area_km2 = (111.32 * TILE_DEG) * (111.32 * TILE_DEG * np.cos(lat))
        self._rng = rng

    # ------------------------------------------------------------------ fields
    def urban_year(self, year: int) -> np.ndarray:
        frac = np.clip((year - SIM_FIRST_YEAR) / (SIM_LAST_YEAR - SIM_FIRST_YEAR), 0, 1)
        return np.clip(self.urban0 + 0.45 * self.growth_potential * frac, 0, 0.97)

    def cropland_year(self, year: int) -> np.ndarray:
        return np.clip(0.92 - self.urban_year(year) - self.water - self.forest, 0, 0.95)

    def flood_level(self, d: date) -> float:
        doy = d.timetuple().tm_yday
        year_offset = {2019: 0.3, 2020: 0.9, 2021: -0.6, 2022: 1.2, 2023: 0.6, 2024: -0.3, 2025: 0.1}.get(d.year, 0.0)
        return 29.0 + (6.6 + year_offset) * math.exp(-(((doy - 198) / 32.0) ** 2)) + 0.25 * math.sin(self.spec.seed + d.year)

    @lru_cache(maxsize=64)
    def flood_share(self, level: float, year: int) -> np.ndarray:
        """Share of each tile's cropland that is inundated at a given river level."""
        noise = gaussian_filter(_stable_rng(self.spec.id, "flood", year).normal(size=(self.H, self.W)), 1.5) * 1.4
        depth = level - self.elev - 0.18 * self.dist_river + noise
        return np.clip(_sigmoid(depth / 0.7), 0, 1) * (self.elev < 42)

    def embedding(self, year: int) -> np.ndarray:
        urban = self.urban_year(year)
        crop = self.cropland_year(year)
        feats = np.stack(
            [
                crop,
                urban,
                self.water,
                (self.elev - 30) / 10,
                self.clay,
                self.forest,
                np.minimum(self.kilns, 3) / 3.0,
                np.minimum(self.dist_river, 20) / 20,
                np.ones_like(crop),
            ],
            axis=-1,
        )[self.rows, self.cols]
        # persistent per-tile texture (same every year) + small year-to-year noise
        persistent = _stable_rng(self.spec.id, "emb").normal(size=(len(self.rows), EMB_DIM)) * 0.20
        yearly = _stable_rng(self.spec.id, "emb", year).normal(size=(len(self.rows), EMB_DIM)) * 0.035
        e = feats @ self.W_emb.T + persistent + yearly
        return e / np.linalg.norm(e, axis=1, keepdims=True)


@lru_cache(maxsize=8)
def _world(world_id: str) -> SimWorld:
    spec = next(w for w in WORLDS if w.id == world_id)
    return SimWorld(spec)


def s1_acquisitions(start: date, end: date) -> list[date]:
    k0 = max(0, math.ceil((start - S1_EPOCH).days / S1_REVISIT_DAYS))
    out = []
    d = S1_EPOCH + timedelta(days=k0 * S1_REVISIT_DAYS)
    while d <= end:
        out.append(d)
        d += timedelta(days=S1_REVISIT_DAYS)
    return out


def monthly_cloud_cover(month: int) -> float:
    """Typical cloud fraction for Assam (simulated climatology)."""
    return [0.18, 0.15, 0.22, 0.38, 0.62, 0.84, 0.90, 0.86, 0.74, 0.40, 0.20, 0.17][month - 1]


# ---------------------------------------------------------------------------- oracles


class _SimOracle(Oracle):
    def __init__(self, world: SimWorld, provider: "SimulatedProvider"):
        self.world = world
        self.provider = provider

    def _noise(self, tile_id: str, *extra) -> np.random.Generator:
        return _stable_rng(self.name, self.model_version, tile_id, *extra)


class SimFloodSegOracle(_SimOracle):
    name = "s1_flood_segmentation"
    model_version = "sim-unet-1.2"
    sensor = "sentinel-1"
    unit = "km²"
    description = "Sentinel-1 VV/VH flood segmentation masked to cropland (simulated U-Net)."

    def params_key(self, ir: QueryIR) -> str:
        return "vv_vh;cropland_mask=worldcover"

    def run(self, universe: TileUniverse, idx: int, ir: QueryIR) -> OracleOutput:
        truth = self.provider._flood_truth(ir)[idx]
        base = universe.base_km2[idx]
        g = self._noise(universe.tile_ids[idx], ir.start, ir.end)
        # multiplicative error + small false alarms on wet soil
        value = truth * math.exp(g.normal(0, 0.10)) + base * max(0.0, g.normal(-0.02, 0.015))
        value = float(min(max(value, 0.0), base))
        return OracleOutput(value, {"flooded_share_of_cropland": round(value / base, 4) if base else 0.0})


class SimOpticalFloodOracle(SimFloodSegOracle):
    name = "s2_ndwi_flood"
    model_version = "sim-ndwi-0.9"
    sensor = "sentinel-2"
    description = "Sentinel-2 NDWI water mapping (simulated). Blind under cloud — misses flooded pixels."

    def run(self, universe, idx, ir):
        out = super().run(universe, idx, ir)
        cloud = monthly_cloud_cover(ir.start.month)
        g = self._noise(universe.tile_ids[idx], "cloud", ir.start)
        visible = 1.0 - min(1.0, cloud + g.normal(0, 0.08))
        out.value *= max(visible, 0.0)
        out.detail["cloud_obscured_share"] = round(1 - max(visible, 0.0), 3)
        return out


class SimChangeOracle(_SimOracle):
    name = "bitemporal_change_detection"
    model_version = "sim-changeformer-2.0"
    sensor = "sentinel-2"
    unit = "km²"
    description = "Bi-temporal Sentinel-2 built-up change detection (simulated ChangeFormer)."

    def params_key(self, ir: QueryIR) -> str:
        return f"baseline={ir.baseline_start}..{ir.baseline_end}"

    def run(self, universe, idx, ir):
        truth = self.provider._change_truth(ir)[idx]
        g = self._noise(universe.tile_ids[idx], ir.baseline_start, ir.end)
        value = truth * math.exp(g.normal(0, 0.12)) + universe.area_km2[idx] * max(0.0, g.normal(-0.004, 0.003))
        return OracleOutput(float(max(value, 0.0)), {})


class SimKilnOracle(_SimOracle):
    name = "brick_kiln_detector"
    model_version = "sim-yolo-kiln-1.1"
    sensor = "sentinel-2"
    unit = "kilns"
    description = "Brick-kiln object detector on Sentinel-2 dry-season composites (simulated)."

    def run(self, universe, idx, ir):
        truth = int(self.provider._kiln_truth(ir)[idx])
        g = self._noise(universe.tile_ids[idx])
        detected = int(g.binomial(truth, 0.94)) if truth else 0
        detected += int(g.random() < 0.002)  # rare false positive
        return OracleOutput(float(detected), {"boxes": detected})


class SimVQAOracle(_SimOracle):
    name = "geo_vqa"
    model_version = "sim-geochat-0.3"
    sensor = "sentinel-2"
    unit = "answer"
    description = "Per-tile visual question answering + grounding (simulated GeoChat-style VLM)."

    def run(self, universe, idx, ir):
        p = self.provider
        if ir.target == Target.FLOODED_CROPLAND:
            v = float(p._flood_truth(ir)[idx])
            share = v / universe.base_km2[idx] if universe.base_km2[idx] > 0 else 0.0
            ans = "yes — standing water over cropland" if share > 0.3 else ("partly" if share > 0.05 else "no visible flooding")
            return OracleOutput(v, {"answer": ans, "share": round(share, 3)})
        if ir.target == Target.NEW_BUILTUP:
            v = float(p._change_truth(ir)[idx])
            ans = "new construction visible" if v > 0.02 else "no significant new construction"
            return OracleOutput(v, {"answer": ans})
        v = float(p._kiln_truth(ir)[idx])
        return OracleOutput(v, {"answer": f"{int(v)} kiln(s) visible" if v else "no kilns visible"})


# ---------------------------------------------------------------------------- provider


class SimulatedProvider(Provider):
    name = "simulated"

    def __init__(self, oracle_latency_s: float = 0.12):
        self.oracle_latency_s = oracle_latency_s

    def regions(self) -> list[Region]:
        out = []
        for spec in WORLDS:
            w = _world(spec.id)
            ring = [[float(x), float(y)] for x, y in w.polygon] + [[float(w.polygon[0][0]), float(w.polygon[0][1])]]
            out.append(Region(spec.id, spec.name, spec.bbox, {"type": "Polygon", "coordinates": [ring]}, True, spec.description))
        return out

    # -- truths (per tile, aligned with universe order) -------------------------------
    def _w(self, ir: QueryIR) -> SimWorld:
        return _world(ir.region_id)

    def _flood_level(self, ir: QueryIR) -> float:
        acq = s1_acquisitions(ir.start, ir.end)
        w = self._w(ir)
        dates = acq or [ir.start + (ir.end - ir.start) / 2]
        return max(w.flood_level(d) for d in dates)

    def _truth_key(self, ir: QueryIR) -> tuple:
        return (ir.region_id, ir.target, ir.task, ir.start, ir.end, ir.baseline_start,
                ir.point.lon if ir.point else None, ir.point.lat if ir.point else None, ir.radius_km)

    def _truth(self, ir: QueryIR) -> np.ndarray:
        key = self._truth_key(ir)
        cache = self.__dict__.setdefault("_truth_cache", {})
        if key not in cache:
            w = self._w(ir)
            if ir.target == Target.FLOODED_CROPLAND:
                share = w.flood_share(round(self._flood_level(ir), 4), ir.start.year)[w.rows, w.cols]
                arr = share * w.cropland_year(ir.start.year)[w.rows, w.cols] * w.area_km2
            elif ir.target == Target.NEW_BUILTUP:
                y0 = (ir.baseline_start or date(ir.start.year - 3, 1, 1)).year
                d = (w.urban_year(ir.end.year) - w.urban_year(y0))[w.rows, w.cols]
                arr = np.clip(d, 0, None) * w.area_km2
            else:
                arr = w.kilns[w.rows, w.cols].astype(float)
            cache[key] = arr[self._population_mask(ir)]
            if len(cache) > 64:
                cache.pop(next(iter(cache)))
        return cache[key]

    def _flood_truth(self, ir: QueryIR) -> np.ndarray:
        return self._truth(ir.model_copy(update={"target": Target.FLOODED_CROPLAND}))

    def _change_truth(self, ir: QueryIR) -> np.ndarray:
        return self._truth(ir.model_copy(update={"target": Target.NEW_BUILTUP}))

    def _kiln_truth(self, ir: QueryIR) -> np.ndarray:
        return self._truth(ir.model_copy(update={"target": Target.BRICK_KILN}))

    def _population_mask(self, ir: QueryIR) -> np.ndarray:
        w = self._w(ir)
        if ir.target == Target.FLOODED_CROPLAND:
            crop = w.cropland_year(ir.start.year)[w.rows, w.cols] * w.area_km2
            keep = crop > 0.02
        else:
            keep = np.ones(len(w.rows), dtype=bool)
        if ir.task == Task.INSPECT and ir.point is not None:
            cx = (w.bboxes[:, 0] + w.bboxes[:, 2]) / 2
            cy = (w.bboxes[:, 1] + w.bboxes[:, 3]) / 2
            dx = (cx - ir.point.lon) * 111.32 * math.cos(math.radians(ir.point.lat))
            dy = (cy - ir.point.lat) * 111.32
            keep &= np.hypot(dx, dy) <= ir.radius_km + 0.5
        return keep

    def ground_truth(self, ir: QueryIR) -> np.ndarray:
        """Per-tile *reality* for the query's population (simulator only)."""
        return self._truth(ir)

    # -- validation -------------------------------------------------------------------
    def check_inputs(self, ir: QueryIR) -> list[Check]:
        checks: list[Check] = []
        region = self.region(ir.region_id)
        checks.append(Check("Region known", region is not None, region.name if region else f"unknown region '{ir.region_id}'"))
        if region is None:
            return checks
        if ir.target in (Target.ACTIVE_FIRE, Target.BURNED_CROPLAND):
            checks.append(Check("Target available in the simulator", False,
                                "fire and burned-area questions use live NASA FIRMS / Sentinel-2 data — pick a real district"))
            return checks
        in_range = SIM_FIRST_YEAR <= ir.start.year <= SIM_LAST_YEAR and ir.end <= date(SIM_LAST_YEAR, 12, 31)
        checks.append(
            Check("Dates within archive", in_range, f"{ir.start} → {ir.end} (archive {SIM_FIRST_YEAR}–{SIM_LAST_YEAR})")
        )
        if ir.target == Target.FLOODED_CROPLAND:
            acq = s1_acquisitions(ir.start, ir.end)
            checks.append(
                Check(
                    "Sentinel-1 scenes in window",
                    len(acq) > 0,
                    f"{len(acq)} acquisition(s): " + ", ".join(d.isoformat() for d in acq[:4]) + ("…" if len(acq) > 4 else "")
                    if acq
                    else "no Sentinel-1 pass inside the window — widen it to ≥12 days",
                )
            )
            cloud = monthly_cloud_cover(ir.start.month)
            checks.append(
                Check(
                    "Optical usability",
                    True,
                    f"expected cloud cover {cloud:.0%} in month {ir.start.month}"
                    + (" — optical flood mapping unreliable, SAR preferred" if cloud > 0.5 else ""),
                    blocking=False,
                )
            )
        if ir.target == Target.NEW_BUILTUP:
            b0 = ir.baseline_start or date(ir.start.year - 3, 1, 1)
            ok = b0.year >= SIM_FIRST_YEAR and b0 < ir.start
            checks.append(Check("Baseline period available", ok, f"baseline {b0.year} vs target {ir.end.year}"))
        if ir.target == Target.BRICK_KILN:
            checks.append(Check("Dry-season composite", True, f"Sentinel-2 Nov–Mar composite for {ir.end.year}", blocking=False))
        checks.append(Check("Embedding index", True, f"annual 64-d embeddings for {ir.end.year} (simulated AlphaEarth-style)", blocking=False))
        return checks

    def choose_sensor(self, ir: QueryIR) -> tuple[str, str]:
        if ir.sensor != "auto":
            return ir.sensor, "sensor fixed by the user"
        if ir.target == Target.FLOODED_CROPLAND:
            cloud = monthly_cloud_cover(ir.start.month)
            if cloud > 0.5:
                return "sentinel-1", f"expected cloud cover {cloud:.0%} → SAR sees through cloud, optical does not"
            return "sentinel-1", "SAR backscatter is the standard flood signal; optical used only as a cross-check"
        return "sentinel-2", "optical texture and spectra resolve built-up change and kilns; SAR not needed"

    # -- universe ---------------------------------------------------------------------
    def universe(self, ir: QueryIR) -> TileUniverse:
        w = self._w(ir)
        keep = self._population_mask(ir)
        year = ir.end.year
        emb = w.embedding(min(max(year, SIM_FIRST_YEAR), SIM_LAST_YEAR))
        # PCA of embeddings → compact covariates
        ec = emb - emb.mean(0)
        _, _, vt = np.linalg.svd(ec, full_matrices=False)
        pcs = ec @ vt[:6].T
        tile_area = w.area_km2

        if ir.target == Target.FLOODED_CROPLAND:
            base = (w.cropland_year(ir.start.year)[w.rows, w.cols] * tile_area)
            share = w.flood_share(round(self._flood_level(ir), 4), ir.start.year)
            wet = share * w.cropland_year(ir.start.year) + 0.35 * w.water
            coarse = uniform_filter(wet, size=9, mode="nearest")  # ~9 km overview pixel
            speckle = gaussian_filter(_stable_rng(w.spec.id, "s1coarse", ir.start).normal(size=coarse.shape), 2.0) * 0.35
            coarse = coarse * np.exp(speckle) + 0.04 * _stable_rng(w.spec.id, "s1n", ir.start).normal(size=coarse.shape)
            coarse = np.clip(coarse, 0, 1)[w.rows, w.cols]
            score0 = coarse * base
            feats = np.column_stack([coarse, coarse * base, base, pcs])
            names = ["s1_overview_water", "s1_overview×cropland", "cropland_km2"] + [f"emb_pc{i}" for i in range(6)]
            desc = "coarse Sentinel-1 overview water fraction (~9 km) × cropland area, plus 6 embedding PCs"
        elif ir.target == Target.NEW_BUILTUP:
            y0 = (ir.baseline_start or date(ir.start.year - 3, 1, 1)).year
            e0 = w.embedding(min(max(y0, SIM_FIRST_YEAR), SIM_LAST_YEAR))
            drift = np.linalg.norm(emb - e0, axis=1)
            base = tile_area.copy()
            score0 = drift
            feats = np.column_stack([drift, drift**2, pcs])
            names = ["embedding_drift", "embedding_drift²"] + [f"emb_pc{i}" for i in range(6)]
            desc = f"embedding change ‖e{year} − e{y0}‖ between annual embeddings, plus 6 embedding PCs"
        else:
            # exemplar search: average embedding of a few known kiln tiles (like Earth Index)
            kiln = w.kilns[w.rows, w.cols]
            ex_rng = _stable_rng(w.spec.id, "exemplars")
            pos = np.flatnonzero(kiln >= 2)
            ex = ex_rng.choice(pos, size=min(5, len(pos)), replace=False) if len(pos) else np.array([], int)
            proto = emb[ex].mean(0) if len(ex) else emb.mean(0)
            sim = emb @ (proto / np.linalg.norm(proto))
            base = tile_area.copy()
            score0 = np.exp(8 * (sim - sim.max()))
            feats = np.column_stack([sim, score0, pcs])
            names = ["exemplar_similarity", "exemplar_similarity_exp"] + [f"emb_pc{i}" for i in range(6)]
            desc = f"cosine similarity to {len(ex)} exemplar kiln tiles in the embedding index, plus 6 embedding PCs"

        return TileUniverse(
            region_id=ir.region_id,
            tile_ids=[t for t, k in zip(w.tile_ids, keep) if k],
            bboxes=w.bboxes[keep],
            area_km2=tile_area[keep],
            base_km2=base[keep],
            features=feats[keep],
            feature_names=names,
            score0=score0[keep],
            proxy_description=desc,
            extra={"world": w.spec.id},
        )

    def oracle(self, ir: QueryIR, sensor: str) -> Oracle:
        w = self._w(ir)
        if ir.task == Task.INSPECT:
            return SimVQAOracle(w, self)
        if ir.target == Target.FLOODED_CROPLAND:
            return SimOpticalFloodOracle(w, self) if sensor == "sentinel-2" else SimFloodSegOracle(w, self)
        if ir.target == Target.NEW_BUILTUP:
            return SimChangeOracle(w, self)
        return SimKilnOracle(w, self)

    def scene_key(self, ir: QueryIR, sensor: str) -> str:
        if sensor == "sentinel-1":
            acq = s1_acquisitions(ir.start, ir.end)
            return "S1:" + "+".join(d.strftime("%Y%m%d") for d in acq)
        if ir.target == Target.NEW_BUILTUP:
            y0 = (ir.baseline_start or date(ir.start.year - 3, 1, 1)).year
            return f"S2:composite{y0}+composite{ir.end.year}"
        return f"S2:composite{ir.end.year}:{ir.start.isoformat()}"
