"""ForestGuard — independent evidence around a potential forest-loss detection.

The detection itself is the ``s2-forest-loss`` detector; this module supplies the evidence profile:

* Hansen/UMD Global Forest Change — annual 30 m forest-loss year, read straight from the public GeoTIFF tiles (no
  Earth Engine account).
* NASA FIRMS — active-fire detections through Bhu-Drishti's FIRMS adapter, only when ``NASA_FIRMS_MAP_KEY`` is set.
* Hotspots — the largest detected patches with centroid and area.
* Protected areas — OpenStreetMap parks / reserves the detection overlaps.
* Fusion — how many independent datasets agree: an evidence-coverage level, never a probability.

The scientific rules: an NDVI decline is *potential* forest loss, never confirmed deforestation; Hansen's loss year is
annual context, not an event date; a fire detection is not proof of cause. Tree context comes from ESA WorldCover
(2021), and Sentinel-2 mosaics are compared rather than seasonal median composites.
"""

from __future__ import annotations

import math
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx
import numpy as np
from rasterio.enums import Resampling
from shapely.geometry import LineString, Point, Polygon, box, shape
from shapely.ops import polygonize, unary_union

from ..sources.base import SourceError, redact
from ..sources.firms import firms
from . import EOUnavailable
from .assets import overpass_query
from .grid import Grid, read_mosaic

HANSEN_VERSION = "GFC-2025-v1.13"
HANSEN_LAST_YEAR = 2025
HANSEN_BASE = f"https://storage.googleapis.com/earthenginepartners-hansen/{HANSEN_VERSION}"
HANSEN_META = {
    "name": "Hansen/UMD Global Forest Change",
    "version": HANSEN_VERSION,
    "resolution": "30 m, annual",
    "url": "https://glad.earthengine.app/view/global-forest-change",
    "license": "CC BY 4.0",
}
CANOPY_MIN_PCT = 30            # conservative year-2000 forest baseline

HOTSPOT_MIN_KM2 = 0.05
HOTSPOT_LIMIT = 20

FIRMS_WINDOW_DAYS = 30
FIRMS_MAX_ROWS = 100


# ---------------------------------------------------------------------------- Hansen Global Forest Change

def hansen_tile_urls(layer: str, bbox: dict[str, float]) -> list[str]:
    """URLs of the 10°×10° tiles covering ``bbox`` (tiles are named by their top-left corner)."""
    urls = []
    top = math.ceil(bbox["north"] / 10) * 10
    while top > bbox["south"]:
        left = math.floor(bbox["west"] / 10) * 10
        while left < bbox["east"]:
            lat = f"{abs(top):02d}{'N' if top >= 0 else 'S'}"
            lng = f"{abs(left):03d}{'E' if left >= 0 else 'W'}"
            urls.append(f"{HANSEN_BASE}/Hansen_{HANSEN_VERSION}_{layer}_{lat}_{lng}.tif")
            left += 10
        top -= 10
    return urls


def loss_years(before: date, after: date) -> tuple[list[int], str | None]:
    """Calendar years a before→after pair spans that Hansen can speak to, plus a caveat."""
    years = [y for y in range(max(2001, before.year), after.year + 1) if y <= HANSEN_LAST_YEAR]
    note = None
    if after.year > HANSEN_LAST_YEAR:
        first = max(before.year, HANSEN_LAST_YEAR + 1)
        span = str(after.year) if first == after.year else f"{first}–{after.year}"
        note = f"The dataset ends in {HANSEN_LAST_YEAR}; loss during {span} is not covered."
    return years, note


def hansen_evidence(bbox: dict[str, float], grid: Grid, detected: np.ndarray, before: date, after: date) -> dict[str, Any]:
    """Annual forest loss recorded by Hansen in the years the comparison spans."""
    years, note = loss_years(before, after)
    base = {"source": HANSEN_META["name"], "dataset": HANSEN_VERSION, "years": years,
            "note": "Annual forest-loss evidence; not treated as an exact event date." + (f" {note}" if note else "")}
    if not years:
        return {**base, "status": "not_covered", "matching_annual_loss_km2": None, "overlap_km2": None}
    try:
        lossyear = read_mosaic(hansen_tile_urls("lossyear", bbox), grid, Resampling.nearest, nodata=255)
        canopy = read_mosaic(hansen_tile_urls("treecover2000", bbox), grid, Resampling.nearest, nodata=255)
    except EOUnavailable as exc:
        return {**base, "status": "unavailable", "matching_annual_loss_km2": None, "overlap_km2": None, "reason": str(exc)}
    return {**base, **summarize_hansen(lossyear, canopy, detected, years, grid.pixel_area_km2)}


def summarize_hansen(lossyear: np.ndarray, canopy: np.ndarray, detected: np.ndarray, years: list[int], pixel_km2: float) -> dict[str, Any]:
    """Pure part of ``hansen_evidence`` (arrays in, numbers out)."""
    codes = [y - 2000 for y in years]
    forest2000 = np.nan_to_num(canopy, nan=0.0) >= CANOPY_MIN_PCT
    loss = np.isin(np.nan_to_num(lossyear, nan=0.0), codes) & forest2000
    overlap = loss & detected
    loss_km2 = float(loss.sum() * pixel_km2)
    overlap_km2 = float(overlap.sum() * pixel_km2)
    if overlap_km2 > 0:
        status = "supporting"
    elif loss_km2 > 0:
        status = "nearby_only"
    else:
        status = "no_matching_annual_loss"
    return {"status": status, "matching_annual_loss_km2": round(loss_km2, 3), "overlap_km2": round(overlap_km2, 3),
            "forest_2000_km2": round(float(forest2000.sum() * pixel_km2), 2)}


# ---------------------------------------------------------------------------- hotspots

def hotspots(geometry: dict[str, Any], min_km2: float = HOTSPOT_MIN_KM2, limit: int = HOTSPOT_LIMIT) -> list[dict[str, Any]]:
    """Largest detected patches with their centroid, biggest first."""
    out = []
    for feature in geometry.get("features", []):
        area = float(feature["properties"].get("area_km2", 0.0))
        if area < min_km2:
            continue
        centre = shape(feature["geometry"]).centroid
        out.append({"id": f"forest_{feature.get('id', len(out))}", "area_km2": round(area, 3),
                    "latitude": round(centre.y, 5), "longitude": round(centre.x, 5),
                    "event_type": "potential_forest_loss"})
    out.sort(key=lambda h: h["area_km2"], reverse=True)
    return out[:limit]


# ---------------------------------------------------------------------------- NASA FIRMS active fires

def firms_window(after: date, today: date | None = None) -> tuple[date, date]:
    """(start, end) — the last 30 days up to the event image."""
    today = today or datetime.now(UTC).date()
    end = min(after, today)
    return end - timedelta(days=FIRMS_WINDOW_DAYS - 1), end


def firms_evidence(bbox: dict[str, float], after: date, geometry=None, source=None) -> dict[str, Any]:
    """Fire detections in the area before the event image. Never raises.

    FIRMS needs a free MAP_KEY; without one the result says ``not_configured`` instead of pretending there were no
    fires. The key is part of the request path, so every message is redacted.
    """
    start, end = firms_window(after)
    base = {"source": "NASA FIRMS", "window": {"start": start.isoformat(), "end": end.isoformat()},
            "note": "Fire detections are supporting evidence only; they do not prove that fire caused the vegetation change."}
    src = source or firms()
    if not src.configured()[0]:
        return {**base, "status": "not_configured", "fire_detections": None,
                "reason": "Set NASA_FIRMS_MAP_KEY (free from NASA FIRMS) to add fire evidence."}
    try:
        rows, _ = src.detections((bbox["west"], bbox["south"], bbox["east"], bbox["north"]), start, end)
    except SourceError as exc:
        return {**base, "status": "error", "fire_detections": None, "reason": f"FIRMS request failed ({exc.kind})."}
    except Exception as exc:  # noqa: BLE001 — evidence must never fail the analysis
        return {**base, "status": "error", "fire_detections": None, "reason": redact(f"FIRMS request failed ({type(exc).__name__}).")}
    if geometry is not None:
        rows = [r for r in rows if geometry.contains(Point(r["lon"], r["lat"]))]
    return {**base, "status": "detected" if rows else "not_detected", "fire_detections": len(rows),
            "detections": [{"latitude": r["lat"], "longitude": r["lon"], "date": r.get("acq_date"),
                            "confidence": r.get("confidence"), "frp_mw": r.get("frp_mw")} for r in rows[:FIRMS_MAX_ROWS]]}


# ---------------------------------------------------------------------------- evidence fusion

def fuse(detected: bool, hansen: dict[str, Any], fires: dict[str, Any]) -> dict[str, Any]:
    """Deterministic evidence-coverage summary. Not a probability, not a cause."""
    indicators = {
        "sentinel2_ndvi_loss": detected,
        "tree_cover_context": detected,             # the detector only reports loss on mapped trees
        "hansen_annual_loss": hansen.get("status") == "supporting",
        "firms_fire_detected": fires.get("status") == "detected",
    }
    independent = int(indicators["tree_cover_context"]) + int(indicators["hansen_annual_loss"])
    corroboration = "stronger" if independent >= 2 else "supporting" if independent == 1 else "limited"
    if not detected:
        assessment = "no_detected_forest_loss"
    elif indicators["hansen_annual_loss"]:
        assessment = "potential_forest_loss_with_independent_support"
    else:
        assessment = "potential_forest_loss_without_independent_loss_record"
    return {
        "assessment": assessment, "corroboration": corroboration,
        "independent_forest_evidence_sources": independent, "indicators": indicators,
        "fire_is_supporting_only": True, "not_a_calibrated_probability": True,
        "interpretation": ("Sentinel-2 detects the vegetation change; the tree-cover map and the Hansen record are "
                           "independent forest evidence; FIRMS can support a fire hypothesis. None of them alone "
                           "establishes a cause or confirmed deforestation."),
    }


# ---------------------------------------------------------------------------- protected areas (OpenStreetMap)

PROTECTED_NOTE = "OpenStreetMap protected-area tagging; not a complete or authoritative inventory of protected land."
PROTECTED_LIMIT = 10


def protected_query(bbox: dict[str, float]) -> str:
    bx = f"{bbox['south']},{bbox['west']},{bbox['north']},{bbox['east']}"
    lat, lng = (bbox["south"] + bbox["north"]) / 2, (bbox["west"] + bbox["east"]) / 2
    kinds = ('["boundary"~"^(protected_area|national_park)$"]', '["leisure"="nature_reserve"]')
    parts = [f"{kind}{tags}({bx});" for tags in kinds for kind in ("way", "relation")]
    # Areas that enclose the whole analysis rectangle have no node inside it.
    parts += [f"{kind}(pivot.a){tags};" for tags in kinds for kind in ("way", "relation")]
    return f"[out:json][timeout:40];is_in({lat},{lng})->.a;({''.join(parts)});out geom;"


def _ring(points: list[dict[str, float]]) -> list[tuple[float, float]]:
    return [(float(pt["lon"]), float(pt["lat"])) for pt in points if "lon" in pt and "lat" in pt]


def parse_protected(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Overpass elements → named protected-area polygons (unnamed / broken ones are skipped)."""
    areas: dict[str, dict[str, Any]] = {}
    for el in elements:
        tags = el.get("tags") or {}
        geom = None
        if el.get("type") == "way":
            ring = _ring(el.get("geometry") or [])
            if len(ring) >= 4 and ring[0] == ring[-1]:
                geom = Polygon(ring)
        elif el.get("type") == "relation":
            lines = [LineString(r) for m in el.get("members") or []
                     if m.get("role") in ("outer", "") and len(r := _ring(m.get("geometry") or [])) >= 2]
            polys = list(polygonize(unary_union(lines))) if lines else []
            geom = unary_union(polys) if polys else None
        if geom is None or geom.is_empty:
            continue
        if not geom.is_valid:
            geom = geom.buffer(0)
        key = f"{el['type']}/{el['id']}"
        areas[key] = {"osm_id": key, "name": tags.get("name") or tags.get("name:en") or "Unnamed protected area",
                      "kind": tags.get("protect_class") and f"protect class {tags['protect_class']}"
                              or tags.get("boundary") or tags.get("leisure"),
                      "geometry": geom}
    return list(areas.values())


def protected_areas(bbox: dict[str, float], extent: Any, post=httpx.post) -> dict[str, Any]:
    """Mapped protected areas in the analysis rectangle and those the detection overlaps."""
    base = {"source": "OpenStreetMap (Overpass API)", "note": PROTECTED_NOTE}
    try:
        payload = overpass_query(protected_query(bbox), post, timeout=50.0)
        areas = parse_protected(payload.get("elements", []))
    except Exception as exc:  # noqa: BLE001 — evidence must never fail the analysis
        return {**base, "status": "unavailable", "in_area": None, "overlapping": [],
                "reason": f"OpenStreetMap protected-area lookup failed ({type(exc).__name__})."}
    rectangle = box(bbox["west"], bbox["south"], bbox["east"], bbox["north"])
    in_area = [a for a in areas if a["geometry"].intersects(rectangle)]
    overlapping = ([a for a in in_area if a["geometry"].intersects(extent)]
                   if extent is not None and not extent.is_empty else [])
    strip = lambda a: {k: v for k, v in a.items() if k != "geometry"}  # noqa: E731
    return {**base, "status": "available", "in_area": len(in_area),
            "names_in_area": sorted({a["name"] for a in in_area})[:PROTECTED_LIMIT],
            "overlapping": [strip(a) for a in overlapping[:PROTECTED_LIMIT]],
            "overlapping_total": len(overlapping)}
