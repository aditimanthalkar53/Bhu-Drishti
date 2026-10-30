"""Critical-infrastructure assets from OpenStreetMap (Overpass API, keyless).

One bounded query per area, cached in memory for a day (OSM facilities change slowly). The result is either real OSM
data or an explicit ``unavailable`` record with the reason — never a placeholder count.
"""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime
from typing import Any

import httpx

OVERPASS_URLS = ("https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter")
USER_AGENT = "BhuDrishti/0.2 (environmental monitoring)"
MAX_SPAN_DEG = 1.5          # widest box sent to Overpass
MAX_ELEMENTS = 1500
CACHE_TTL_S = 86400
TIMEOUT_S = 60.0

# OSM tag → unified asset type.
ASSET_TYPES: dict[str, tuple[str, str]] = {
    "hospital": ("amenity", "hospital"),
    "clinic": ("amenity", "clinic"),
    "school": ("amenity", "school"),
    "fire_station": ("amenity", "fire_station"),
    "police": ("amenity", "police"),
    "shelter": ("amenity", "shelter"),
    "assembly_point": ("emergency", "assembly_point"),
    "power_substation": ("power", "substation"),
    "airport": ("aeroway", "aerodrome"),
}
# Relative importance for sorting/markers; a documented convention, not a score.
CRITICALITY: dict[str, int] = {
    "hospital": 3, "fire_station": 3, "power_substation": 3, "airport": 3,
    "clinic": 2, "police": 2, "shelter": 2, "assembly_point": 2, "school": 1,
}

_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_lock = threading.Lock()


def clamp_bbox(bbox: dict[str, float], max_span: float = MAX_SPAN_DEG) -> tuple[dict[str, float], bool]:
    """Shrink a bbox around its centre to at most ``max_span`` degrees a side."""
    lat = (bbox["south"] + bbox["north"]) / 2
    lng = (bbox["west"] + bbox["east"]) / 2
    half_lat = min(max_span, bbox["north"] - bbox["south"]) / 2
    half_lng = min(max_span, bbox["east"] - bbox["west"]) / 2
    clamped = {
        "south": round(max(-90.0, lat - half_lat), 5), "north": round(min(90.0, lat + half_lat), 5),
        "west": round(max(-180.0, lng - half_lng), 5), "east": round(min(180.0, lng + half_lng), 5),
    }
    changed = (bbox["north"] - bbox["south"] > max_span + 1e-9 or bbox["east"] - bbox["west"] > max_span + 1e-9)
    return clamped, changed


def build_query(bbox: dict[str, float]) -> str:
    box = f"({bbox['south']},{bbox['west']},{bbox['north']},{bbox['east']})"
    by_key: dict[str, list[str]] = {}
    for key, value in ASSET_TYPES.values():
        by_key.setdefault(key, []).append(value)
    clauses = "".join(f'nwr["{key}"~"^({"|".join(values)})$"]{box};' for key, values in by_key.items())
    return f"[out:json][timeout:45];({clauses});out center tags {MAX_ELEMENTS};"


def classify(tags: dict[str, str]) -> str | None:
    for asset_type, (key, value) in ASSET_TYPES.items():
        if tags.get(key) == value:
            return asset_type
    return None


def parse_elements(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Overpass elements → GeoJSON point features in the unified asset model."""
    features: list[dict[str, Any]] = []
    for el in elements:
        tags = el.get("tags") or {}
        asset_type = classify(tags)
        lat = el.get("lat", (el.get("center") or {}).get("lat"))
        lng = el.get("lon", (el.get("center") or {}).get("lon"))
        if asset_type is None or lat is None or lng is None:
            continue
        features.append({
            "type": "Feature",
            "id": f"osm-{el.get('type', 'n')}-{el.get('id')}",
            "geometry": {"type": "Point", "coordinates": [float(lng), float(lat)]},
            "properties": {
                "asset_type": asset_type,
                "name": tags.get("name") or tags.get("name:en") or "",
                "criticality": CRITICALITY.get(asset_type, 1),
                "source": "OpenStreetMap",
                "osm_type": el.get("type"),
                "osm_id": el.get("id"),
            },
        })
    return features


def summarize(features: list[dict[str, Any]], bbox: dict[str, float], clamped: bool, fetched_at: str) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for f in features:
        t = f["properties"]["asset_type"]
        counts[t] = counts.get(t, 0) + 1
    return {
        "status": "available", "total": len(features), "counts": counts,
        "truncated": len(features) >= MAX_ELEMENTS, "bbox": bbox, "bbox_clamped": clamped,
        "fetched_at": fetched_at, "source": "OpenStreetMap (Overpass API)",
        "license": "ODbL — © OpenStreetMap contributors",
        "geojson": {"type": "FeatureCollection", "features": features},
    }


def _unavailable(reason: str, bbox: dict[str, float]) -> dict[str, Any]:
    return {"status": "unavailable", "reason": reason, "bbox": bbox, "total": 0, "counts": {},
            "geojson": {"type": "FeatureCollection", "features": []}}


def overpass_query(query: str, post=httpx.post, timeout: float = TIMEOUT_S) -> dict[str, Any]:
    """Run one query, moving to the next public server when one is overloaded (the main one often answers 502/504)."""
    last: Exception | None = None
    for url in OVERPASS_URLS:
        try:
            resp = post(url, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=timeout)
            resp.raise_for_status()
            payload = resp.json()
            # a query that times out on the server still answers 200, with no elements and a "remark"
            if "error" in str(payload.get("remark", "")).lower() or "timed out" in str(payload.get("remark", "")).lower():
                raise ValueError(f"Overpass: {str(payload['remark'])[:120]}")
            return payload
        except (httpx.TimeoutException, httpx.HTTPStatusError, httpx.TransportError, ValueError) as exc:
            last = exc
    assert last is not None
    raise last


def fetch_assets(bbox: dict[str, float], post=httpx.post) -> dict[str, Any]:
    """Critical facilities inside ``bbox`` (clamped). Never raises; failures are not cached."""
    box, clamped = clamp_bbox(bbox)
    key = "{south},{west},{north},{east}".format(**box)
    with _lock:
        hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL_S:
        return hit[1]
    try:
        elements = overpass_query(build_query(box), post).get("elements", [])
    except httpx.TimeoutException:
        return _unavailable("OpenStreetMap (Overpass) timed out. Try again shortly.", box)
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        why = "is rate-limiting requests" if code == 429 else f"returned HTTP {code}"
        return _unavailable(f"OpenStreetMap (Overpass) {why}. Try again shortly.", box)
    except Exception as exc:  # noqa: BLE001 — network / malformed JSON
        return _unavailable(f"OpenStreetMap (Overpass) could not be reached ({type(exc).__name__}).", box)
    result = summarize(parse_elements(elements), box, clamped, datetime.now(UTC).isoformat())
    with _lock:
        _cache[key] = (time.time(), result)
    return result
