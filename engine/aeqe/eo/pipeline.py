"""One change-detection analysis, end to end (synchronous; run in a worker thread).

    discover scenes → read aligned rasters → detect → vectorise → evidence → population in extent → facilities → risk

``run_detection`` does everything that needs rasters and returns a JSON-able record; ``finalize`` adds facilities and
risk once the caller has fetched OSM assets. Each stage reports through ``progress(key, status, detail)``. A stage that
cannot get its input raises ``EOUnavailable`` (required inputs) or records the gap in the result (optional inputs) —
nothing is substituted.

An Indian district is usually larger than one Sentinel-2 tile and fills only part of its bounding rectangle, so optical
dates are nearest-first mosaics of clear pixels, and every result is clipped to the area's real boundary.
"""

from __future__ import annotations

import os
import time
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
from rasterio.enums import Resampling
from rasterio.warp import reproject
from shapely.geometry import shape

from . import EOUnavailable, access, forest, population, render, risk, vector
from . import indices as ix
from .detectors import MIN_VALID_FRACTION, REGISTRY, Detection
from .grid import Grid, aoi_mask, display_grid, make_grid, read_band, read_mosaic, slope_degrees  # noqa: F401 — aoi_mask and display_grid are also used by the InSAR job

PIPELINE_VERSION = "eo-pipeline 1.1.0"
MAX_AOI_SPAN_DEG = float(os.getenv("AEQE_EO_MAX_SPAN_DEG", "4.0"))
MAX_S2_CANDIDATES = 16        # scenes checked for clear pixels per date
MAX_S2_MOSAIC = 8             # scenes actually read per date
S2_ENOUGH_CLEAR = 0.85

ANALYSES: dict[str, dict[str, Any]] = {
    "vegetation_change": {
        "label": "Vegetation change", "sensor": "Sentinel-2", "detector": "s2-ndvi-change",
        "default_gap_days": 365, "event_type": "vegetation_change",
        "noun": "potential vegetation loss", "exposure": False,
    },
    "forest_loss": {
        "label": "Forest loss (ForestGuard)", "sensor": "Sentinel-2", "detector": "s2-forest-loss",
        "default_gap_days": 365, "event_type": "forest_loss",
        "noun": "potential forest loss", "exposure": False,
    },
    "water_change": {
        "label": "Surface-water change", "sensor": "Sentinel-2", "detector": "s2-water-change",
        "default_gap_days": 30, "event_type": "water_change",
        "noun": "new surface water", "exposure": True,
    },
    "sar_flood": {
        "label": "Flood detection (radar)", "sensor": "Sentinel-1", "detector": "s1-flood-change",
        "default_gap_days": 24, "event_type": "flood",
        "noun": "probable inundation", "exposure": True,
    },
    "ground_deformation": {
        "label": "Ground movement (InSAR)", "sensor": "Sentinel-1 InSAR", "detector": "s1-insar-hyp3",
        "default_gap_days": 12, "event_type": "ground_deformation",
        "noun": "possible ground movement", "exposure": True,
    },
}

Progress = Callable[[str, str, str], None]


def default_dates(kind: str, today: date | None = None) -> tuple[date, date]:
    """(before, after) defaults: latest imagery vs the analysis' natural reference."""
    today = today or datetime.now(UTC).date()
    after = today - timedelta(days=5)        # recent enough, old enough to be published
    return after - timedelta(days=ANALYSES[kind]["default_gap_days"]), after


def exposure_block(bbox: dict[str, float], geometry_fc: dict[str, Any], detected: bool, progress: Progress) -> tuple[dict[str, Any] | None, str | None]:
    """People inside the detected extent, with the range from the disagreement between datasets."""
    progress("population", "running", "Summing population inside the extent…")
    try:
        extent = vector.union_geometry(geometry_fc)
        in_extent = population.hrsl_population(extent) if detected else 0.0
        area_hrsl = _optional(lambda: population.hrsl_population(shape(vector.bbox_polygon(bbox))))
        area_wp = _optional(lambda: population.worldpop_population_bbox(bbox))
        pop = population.exposure_estimate(in_extent, area_hrsl, area_wp)
        pop["area_population"] = {"hrsl": None if area_hrsl is None else round(area_hrsl),
                                  "worldpop": None if area_wp is None else round(area_wp)}
        pop["providers"] = [population.HRSL_META] + ([population.WORLDPOP_META] if area_wp else [])
        progress("population", "ok", f"About {pop['value']:,} people inside the extent (range {pop['low']:,}–{pop['high']:,}).")
        return pop, None
    except EOUnavailable as exc:
        progress("population", "unavailable", str(exc))
        return None, str(exc)


def validate_request(kind: str, bbox: dict[str, float], before: date, after: date) -> str | None:
    if kind not in ANALYSES:
        return "Unknown analysis type."
    if bbox["north"] - bbox["south"] > MAX_AOI_SPAN_DEG or bbox["east"] - bbox["west"] > MAX_AOI_SPAN_DEG:
        return (f"Change detection is limited to {MAX_AOI_SPAN_DEG:g}° per side (about {MAX_AOI_SPAN_DEG * 111:.0f} km). "
                "Draw a smaller area under Areas and pick it here.")
    if after > datetime.now(UTC).date():
        return "The “after” date is in the future."
    if before >= after:
        return "The “before” date must be earlier than the “after” date."
    return None


# ---------------------------------------------------------------------------- scene selection

def _optional(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except EOUnavailable:
        return None


def choose_mosaic(clear_masks: list[np.ndarray | None], aoi: np.ndarray, enough: float = S2_ENOUGH_CLEAR,
                  max_scenes: int = MAX_S2_MOSAIC) -> tuple[list[int], float]:
    """Greedy nearest-first choice: (indices of the scenes that add clear pixels, clear share of the area) (pure)."""
    covered = np.zeros(aoi.shape, dtype=bool)
    total = max(1, int(aoi.sum()))
    chosen: list[int] = []
    for i, clear in enumerate(clear_masks):
        if clear is None:
            continue
        new = clear & aoi & ~covered
        if new.sum() < 0.01 * total:      # adds less than 1% of the area: not worth reading six more bands
            continue
        chosen.append(i)
        covered |= new
        if covered.sum() / total >= enough or len(chosen) >= max_scenes:
            break
    return chosen, float(covered.sum() / total)


def _pick_s2(bbox: dict[str, float], geometry, target: date, before_limit: datetime | None = None) -> tuple[list[access.Scene], float]:
    """Nearest Sentinel-2 scenes that together are clear over the area (checked on SCL, not on scene metadata)."""
    coarse = make_grid(bbox, max_pixels=40_000)
    aoi = aoi_mask(coarse, geometry)
    scenes = access.search_sentinel2(bbox, target)
    if before_limit is not None:
        scenes = [s for s in scenes if s.acquired < before_limit]
    scenes = scenes[:MAX_S2_CANDIDATES]
    if not scenes:
        raise EOUnavailable(f"No Sentinel-2 image within 25 days of {target:%d %b %Y} for this area.")

    def clear(scene: access.Scene) -> np.ndarray:
        return ix.scl_clear(read_band(scene.assets["scl"], coarse, Resampling.nearest))

    with ThreadPoolExecutor(max_workers=6) as pool:
        masks = list(pool.map(lambda s: _optional(lambda: clear(s)), scenes))
    chosen, share = choose_mosaic(masks, aoi)
    if not chosen or share < MIN_VALID_FRACTION:
        raise EOUnavailable(f"Not enough cloud-free Sentinel-2 imagery within 25 days of {target:%d %b %Y} "
                            f"(best was {share:.0%} clear over the area). Try another date.")
    return [scenes[i] for i in chosen], share


def _pass_coverage(scenes: list[access.Scene], coarse: Grid, aoi: np.ndarray) -> float:
    vv = read_mosaic([s.assets["vv"] for s in scenes], coarse, Resampling.nearest)
    return float(np.isfinite(vv)[aoi].mean()) if aoi.any() else 0.0


def _pick_s1(bbox: dict[str, float], geometry, target: date, days: int, orbit: int | None = None,
             exclude_day: str | None = None) -> tuple[list[access.Scene], float]:
    coarse = make_grid(bbox, max_pixels=40_000)
    aoi = aoi_mask(coarse, geometry)
    passes = access.group_passes(access.search_sentinel1(bbox, target, days))
    if orbit is not None:
        passes = [p for p in passes if p[0].relative_orbit == orbit]
    if exclude_day:
        passes = [p for p in passes if p[0].acquired.strftime("%Y-%m-%d") != exclude_day]
    if not passes:
        what = f" on relative orbit {orbit}" if orbit is not None else ""
        raise EOUnavailable(f"No Sentinel-1 pass{what} within {days} days of {target:%d %b %Y}.")
    best: tuple[list[access.Scene], float] | None = None
    for group in passes[:5]:
        cover = _optional(lambda: _pass_coverage(group, coarse, aoi))   # one unreadable pass must not end the search
        if cover is None:
            continue
        if best is None or cover > best[1]:
            best = (group, cover)
        if cover >= 0.95:
            break
    if best is None:
        raise EOUnavailable(f"The Sentinel-1 passes near {target:%d %b %Y} could not be read. The provider may be busy; try again shortly.")
    if best[1] < MIN_VALID_FRACTION:
        raise EOUnavailable(f"Sentinel-1 passes near {target:%d %b %Y} cover only {best[1]:.0%} of the area.")
    return best


# ---------------------------------------------------------------------------- raster reads

def _read_many(jobs: dict[str, Callable[[], np.ndarray]]) -> dict[str, np.ndarray]:
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {name: pool.submit(fn) for name, fn in jobs.items()}
        return {name: f.result() for name, f in futures.items()}


def _read_s2_scene(scene: access.Scene, grid: Grid) -> dict[str, Any]:
    bands = ("red", "green", "blue", "nir", "swir16")
    jobs: dict[str, Callable[[], np.ndarray]] = {b: (lambda b=b: read_band(scene.assets[b], grid, Resampling.bilinear)) for b in bands}
    jobs["scl"] = lambda: read_band(scene.assets["scl"], grid, Resampling.nearest)
    raw = _read_many(jobs)
    offset_applied, flag_wrong = ix.s2_offset_present(raw["red"], scene.boa_offset_applied)
    out: dict[str, Any] = {}
    for b in bands:
        out[b] = ix.s2_reflectance(raw[b], offset_applied)
        out[b][~np.isfinite(raw[b])] = np.nan     # keep NaN where the source had no data
    out["clear"] = ix.scl_clear(raw["scl"])
    out["flag_wrong"] = flag_wrong
    return out


def merge_s2(layers: list[dict[str, Any]], suffix: str, aoi: np.ndarray) -> dict[str, Any]:
    """Nearest-first mosaic of per-scene reflectance (pure): each pixel takes the nearest clear observation.

    Cloudy observations stay visible in the true-colour overlay but are never ``clear``, so detectors ignore them."""
    bands = ("red", "green", "blue", "nir", "swir16")
    merged = {b: np.full(aoi.shape, np.nan, dtype="float32") for b in bands}
    clear = np.zeros(aoi.shape, dtype=bool)
    flag_wrong = False
    for layer in layers:
        take = layer["clear"] & ~clear
        for b in bands:
            cosmetic = np.isnan(merged[b]) & np.isfinite(layer[b])
            merged[b][cosmetic] = layer[b][cosmetic]
            merged[b][take] = layer[b][take]
        clear |= take
        flag_wrong = flag_wrong or bool(layer["flag_wrong"])
    out: dict[str, Any] = {}
    for b in bands:
        merged[b][~aoi] = np.nan
        out[f"{'swir' if b == 'swir16' else b}_{suffix}"] = merged[b]
    out[f"clear_{suffix}"] = clear & aoi
    out[f"offset_flag_wrong_{suffix}"] = flag_wrong
    return out


def _read_s2(scenes: list[access.Scene], grid: Grid, aoi: np.ndarray, suffix: str) -> dict[str, Any]:
    return merge_s2([_read_s2_scene(s, grid) for s in scenes], suffix, aoi)


def _ancillary(bbox: dict[str, float], grid: Grid, want: tuple[str, ...]) -> dict[str, np.ndarray | None]:
    def dem() -> np.ndarray:
        return slope_degrees(read_mosaic(access.ancillary_hrefs("cop-dem-glo-30", "data", bbox), grid), grid.res_m)

    def water() -> np.ndarray:
        return read_mosaic(access.ancillary_hrefs("jrc-gsw", "occurrence", bbox), grid, Resampling.nearest)

    def cover() -> np.ndarray:
        return read_mosaic(access.ancillary_hrefs("esa-worldcover", "map", bbox), grid, Resampling.nearest, nodata=0)

    sources = {"slope": dem, "permanent_water": water, "landcover": cover}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {k: pool.submit(_optional, sources[k]) for k in want}
        return {k: f.result() for k, f in futures.items()}


# ---------------------------------------------------------------------------- display overlays

def _to_display(arr: np.ndarray, grid: Grid, dgrid: Grid, resampling: Resampling) -> np.ndarray:
    out = np.full(dgrid.shape, np.nan, dtype="float32")
    reproject(arr.astype("float32"), out, src_transform=grid.transform, src_crs=grid.crs, src_nodata=np.nan,
              dst_transform=dgrid.transform, dst_crs=dgrid.crs, dst_nodata=np.nan, resampling=resampling)
    return out


def _overlay(out_dir: Path, name: str, label: str, when: str | None, image) -> dict[str, Any]:
    render.save(image, out_dir / f"{name}.png")
    return {"id": name, "label": label, "date": when, "file": f"{name}.png"}


def _s2_meta(scenes: list[access.Scene], clear: float) -> dict[str, Any]:
    days = sorted(s.acquired for s in scenes)
    return {**scenes[0].metadata(), "scenes": len(scenes), "scene_ids": [s.id for s in scenes],
            "first_acquired": days[0].isoformat(), "last_acquired": days[-1].isoformat(), "clear_fraction": round(clear, 3)}


# ---------------------------------------------------------------------------- main entry points

def run_detection(kind: str, bbox: dict[str, float], geometry, name: str, before: date, after: date,
                  out_root: Path, progress: Progress, record_id: str | None = None) -> dict[str, Any]:
    spec = ANALYSES[kind]
    detector = REGISTRY[spec["detector"]]
    record_id = record_id or f"det-{uuid.uuid4().hex[:10]}"
    out_dir = out_root / record_id
    started = time.time()
    grid = make_grid(bbox)
    dgrid = display_grid(bbox)
    aoi = aoi_mask(grid, geometry)
    if not aoi.any():
        raise EOUnavailable("The area is smaller than one analysis pixel.")
    overlays: list[dict[str, Any]] = []
    disp = lambda a, r=Resampling.bilinear: _to_display(a, grid, dgrid, r)  # noqa: E731
    mosaic_flags: list[str] = []

    # 1. Discovery
    progress("discovery", "running", f"Searching {spec['sensor']} imagery…")
    if spec["sensor"] == "Sentinel-2":
        scenes_a, clear_a = _pick_s2(bbox, geometry, after)
        earliest = min(s.acquired for s in scenes_a)
        scenes_b, clear_b = _pick_s2(bbox, geometry, before, before_limit=earliest)
        meta_a, meta_b = _s2_meta(scenes_a, clear_a), _s2_meta(scenes_b, clear_b)
        for tag, scenes in (("before", scenes_b), ("after", scenes_a)):
            days = sorted({s.acquired.date() for s in scenes})
            if len(days) > 1:
                mosaic_flags.append(f"The {tag} image is a mosaic of {len(scenes)} scenes from {days[0]:%d %b} to "
                                    f"{days[-1]:%d %b %Y}: different parts of the area were seen on different days.")
        progress("discovery", "ok", f"Before {scenes_b[0].acquired:%d %b %Y} ({len(scenes_b)} scene(s), {clear_b:.0%} clear), "
                                    f"after {scenes_a[0].acquired:%d %b %Y} ({len(scenes_a)} scene(s), {clear_a:.0%} clear).")
    else:
        pass_a, cover_a = _pick_s1(bbox, geometry, after, days=8)
        orbit = pass_a[0].relative_orbit
        pass_b, cover_b = _pick_s1(bbox, geometry, before, days=20, orbit=orbit, exclude_day=pass_a[0].acquired.strftime("%Y-%m-%d"))
        if pass_b[0].acquired >= pass_a[0].acquired:
            raise EOUnavailable("No earlier reference pass on the same orbit was found.")
        meta_a = {**pass_a[0].metadata(), "slices": len(pass_a), "coverage": round(cover_a, 3)}
        meta_b = {**pass_b[0].metadata(), "slices": len(pass_b), "coverage": round(cover_b, 3)}
        progress("discovery", "ok", f"Reference {pass_b[0].acquired:%d %b %Y}, event {pass_a[0].acquired:%d %b %Y} "
                                    f"(relative orbit {orbit}, {pass_a[0].orbit_state}).")

    # 2. Read + preprocess onto one grid
    progress("preprocess", "running", f"Reading rasters at {grid.res_m:.0f} m…")
    inputs: dict[str, Any]
    if spec["sensor"] == "Sentinel-2":
        inputs = {**_read_s2(scenes_b, grid, aoi, "before"), **_read_s2(scenes_a, grid, aoi, "after")}
        if kind == "water_change":
            inputs.update(_ancillary(bbox, grid, ("slope",)))
        if kind == "forest_loss":
            cover = _ancillary(bbox, grid, ("landcover",))["landcover"]
            if cover is None:
                raise EOUnavailable("The tree-cover map (ESA WorldCover) could not be read, so forest cannot be told "
                                    "apart from other vegetation.")
            inputs["tree_cover"] = np.isin(cover, (10, 95))
        for tag, when in (("before", scenes_b[0].acquired), ("after", scenes_a[0].acquired)):
            overlays.append(_overlay(out_dir, tag, f"Sentinel-2 true colour, {tag}", when.isoformat(),
                                     render.true_colour(disp(inputs[f"red_{tag}"]), disp(inputs[f"green_{tag}"]), disp(inputs[f"blue_{tag}"]))))
    else:
        reads = _read_many({f"{pol}_{tag}": (lambda pol=pol, grp=grp: read_mosaic([s.assets[pol] for s in grp], grid))
                            for tag, grp in (("before", pass_b), ("after", pass_a)) for pol in ("vv", "vh")})
        for arr in reads.values():
            arr[~aoi] = np.nan
        extra = _ancillary(bbox, grid, ("slope", "permanent_water", "landcover"))
        cover = extra.pop("landcover")
        inputs = {**reads, **extra, "builtup": None if cover is None else (cover == 50)}
        if cover is not None and inputs.get("permanent_water") is not None:
            # WorldCover class 80 = permanent water bodies: treat as always-water too.
            inputs["permanent_water"] = np.where(cover == 80, 100.0, inputs["permanent_water"])
        for tag, when in (("before", pass_b[0].acquired), ("after", pass_a[0].acquired)):
            overlays.append(_overlay(out_dir, tag, f"Sentinel-1 VV backscatter, {tag}", when.isoformat(),
                                     render.grey_db(disp(ix.to_db(ix.boxcar(inputs[f"vv_{tag}"], 3))))))
    inputs["aoi"] = aoi
    progress("preprocess", "ok", f"{grid.width}×{grid.height} px at {grid.res_m:.0f} m, {grid.crs}.")

    # 3. Detection
    progress("detection", "running", detector.metadata.name)
    det: Detection = detector.detect(inputs, grid.res_m)
    if det.valid_fraction < MIN_VALID_FRACTION:
        raise EOUnavailable(f"Only {det.valid_fraction:.0%} of the area could be assessed on both dates — too little for a "
                            "reliable result. Try other dates.")
    det.quality_flags.extend(mosaic_flags)
    for tag in ("before", "after"):
        if inputs.get(f"offset_flag_wrong_{tag}"):
            det.quality_flags.append(f"The {tag} image's reflectance-offset flag contradicted its pixel values; the values "
                                     "were used. Reflectance for that date is slightly less certain.")
    km2 = grid.pixel_area_km2
    limit = 6.0 if kind == "sar_flood" else 0.5
    overlays.append(_overlay(out_dir, "change", {
        "vegetation_change": "NDVI change (after − before)",
        "forest_loss": "NDVI change (after − before)",
        "water_change": "MNDWI change (after − before)",
        "sar_flood": "VV backscatter change, dB (after − before)"}[kind], None,
        render.diverging(render.smooth(disp(det.change), 5 if kind == "sar_flood" else 3), limit)))
    detected = det.area_px > 0
    progress("detection", "ok", (f"{det.area_px * km2:.2f} km² of {spec['noun']} ({det.confidence} confidence)." if detected
                                 else f"No {spec['noun']} detected."))

    # 4. Vectorise
    geometry_fc = vector.mask_to_polygons(det.mask, grid.transform, grid.crs, grid.res_m)
    secondary = {k: vector.mask_to_polygons(m, grid.transform, grid.crs, grid.res_m, 150)
                 for k, m in det.secondary.items() if k != "permanent_water"}
    progress("vectorize", "ok", f"{geometry_fc['patch_count']} patch(es).")

    # 4b. ForestGuard: independent evidence (optional — gaps are recorded, not filled)
    forest_block: dict[str, Any] | None = None
    if kind == "forest_loss":
        progress("context", "running", "Hansen forest-loss record and fire detections…")
        hansen = forest.hansen_evidence(bbox, grid, det.mask, scenes_b[0].acquired.date(), scenes_a[0].acquired.date())
        fires = forest.firms_evidence(bbox, scenes_a[0].acquired.date(), geometry)
        protected = forest.protected_areas(bbox, vector.union_geometry(geometry_fc))
        fusion = forest.fuse(detected, hansen, fires)
        forest_block = {"hansen": hansen, "firms": fires, "hotspots": forest.hotspots(geometry_fc),
                        "protected_areas": protected, "fusion": fusion,
                        "tree_cover": {"source": "ESA WorldCover 10 m", "reference_year": 2021}}
        missing = [n for n, block in (("Hansen", hansen), ("FIRMS", fires), ("protected areas", protected))
                   if block["status"] in ("unavailable", "error", "not_configured")]
        progress("context", "partial" if missing else "ok",
                 f"Hansen: {hansen['status'].replace('_', ' ')}; FIRMS: {fires['status'].replace('_', ' ')}; "
                 f"protected areas: {protected['status']}. Corroboration: {fusion['corroboration']}.")

    # 5. Population in the extent
    pop: dict[str, Any] | None = None
    pop_error: str | None = None
    if not spec["exposure"]:
        progress("population", "skipped", "Not applicable to this analysis.")
    else:
        pop, pop_error = exposure_block(bbox, geometry_fc, detected, progress)

    metrics = dict(det.metrics)
    for key in [k for k in metrics if k.endswith("_px")]:
        metrics[key[:-3] + "_km2"] = round(metrics.pop(key) * km2, 4)

    return {
        "id": record_id, "kind": kind, "event_type": spec["event_type"], "name": name,
        "label": spec["label"], "noun": spec["noun"], "bbox": bbox,
        "created_at": datetime.now(UTC).isoformat(),
        "before": meta_b, "after": meta_a, "sensor": spec["sensor"],
        "model": detector.metadata.as_dict(),
        "grid": {"crs": grid.crs, "res_m": grid.res_m, "width": grid.width, "height": grid.height},
        "detected": detected, "confidence": det.confidence,
        "confidence_reasons": det.confidence_reasons, "quality_flags": det.quality_flags,
        "valid_fraction": round(det.valid_fraction, 3),
        "area_km2": round(det.area_px * km2, 4),
        "area_low_km2": round(min(det.area_low_px, det.area_px) * km2, 4),
        "area_high_km2": round(max(det.area_high_px, det.area_px) * km2, 4),
        "aoi_km2": round(float(aoi.sum()) * km2, 2),
        "metrics": metrics, "geometry": geometry_fc, "secondary": secondary,
        "overlays": overlays, "forest": forest_block,
        "population": pop, "population_error": pop_error,
        "exposure_applicable": bool(spec["exposure"]),
        "processing": {"pipeline": PIPELINE_VERSION, "seconds": round(time.time() - started, 1)},
    }


def finalize(record: dict[str, Any], assets: dict[str, Any] | None) -> dict[str, Any]:
    """Add facilities-in-extent and the risk assessment (pure, no IO)."""
    in_extent: dict[str, Any] | None = None
    if assets is not None and assets.get("status") == "available":
        inside = vector.points_inside(assets["geojson"], vector.union_geometry(record["geometry"]))
        counts: dict[str, int] = {}
        for f in inside["features"]:
            t = f["properties"]["asset_type"]
            counts[t] = counts.get(t, 0) + 1
        in_extent = {
            "status": "available", "total": len(inside["features"]), "counts": counts, "geojson": inside,
            "fetched_at": assets.get("fetched_at"), "source": assets.get("source"), "license": assets.get("license"),
            "area_total": assets.get("total"), "truncated": bool(assets.get("truncated")),
        }
    elif assets is not None:
        in_extent = {"status": "unavailable", "reason": assets.get("reason"), "total": 0, "counts": {},
                     "geojson": {"type": "FeatureCollection", "features": []}}
    record["assets_in_extent"] = in_extent
    record["risk"] = risk.assess(
        detected=record["detected"], area_km2=record["area_km2"], area_low=record["area_low_km2"],
        area_high=record["area_high_km2"], confidence=record["confidence"], population=record.get("population"),
        assets=in_extent, exposure_applicable=record["exposure_applicable"])
    return record
