"""Infrastructure digital twin: what satellites have seen at one asset, and the terrain to show it on.

A twin here is a record of a real asset (kept by the backend) joined with observations. This module supplies the engine's
part: finding assets in OpenStreetMap, reading each finished analysis at the asset's location, comparing an observation
with the previous one, and building the 3D terrain. It is not a structural model: nothing here simulates how the asset
behaves, and there are no live sensors unless someone records them.
"""

from __future__ import annotations

import base64
import io
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
from affine import Affine
from PIL import Image
from rasterio.warp import transform_geom
from shapely.geometry import mapping, shape
from shapely.ops import transform as shapely_transform

from . import EOUnavailable, access, pipeline, render, vector
from .assets import overpass_query
from .grid import Grid, make_grid, read_mosaic, utm_epsg

DEFAULT_BUFFER_M = 100.0
MAX_ASSET_SPAN_DEG = 0.1      # about 10 km: a twin is one structure or road segment, not a city
TERRAIN_MARGIN_DEG = 0.01
TERRAIN_PIXELS = 40_000
TEXTURE_RES_M = 10.0
OSM_LIMIT = 40

ASSET_QUERIES = (
    'way["bridge"]["bridge"!="no"]', 'way["man_made"="bridge"]', 'way["man_made"~"^(dyke|embankment)$"]', 'way["waterway"="dam"]',
    'way["embankment"="yes"]', 'way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]',
    'way["building"~"^(hospital|school|government)$"]', 'way["amenity"~"^(hospital|school|fire_station)$"]',
)


CORE_ASSET_QUERIES = ('way["bridge"]["bridge"!="no"]', 'way["waterway"="dam"]', 'way["highway"~"^(motorway|trunk|primary)$"]')


def validate_geometry(geometry: dict) -> Any:
    """The asset's shape, or ``ValueError`` with a reason a person can act on."""
    try:
        g = shape(geometry)
    except Exception as exc:  # noqa: BLE001 — shapely raises several types for malformed input
        raise ValueError("The asset needs a valid point, line or polygon.") from exc
    if g.is_empty or g.geom_type not in ("Point", "LineString", "Polygon", "MultiLineString"):
        raise ValueError("The asset needs a point, line or polygon.")
    w, s, e, n = g.bounds
    if not (-180 <= w <= e <= 180 and -90 <= s <= n <= 90):
        raise ValueError("The asset's coordinates are outside the map.")
    if e - w > MAX_ASSET_SPAN_DEG or n - s > MAX_ASSET_SPAN_DEG:
        raise ValueError("A twin covers one structure or road segment, up to about 10 km. Draw a shorter part.")
    return g


def classify_osm(tags: dict[str, str]) -> str:
    if tags.get("bridge") not in (None, "no") or tags.get("man_made") == "bridge":
        return "bridge"
    if tags.get("man_made") in ("dyke", "embankment") or tags.get("embankment") == "yes":
        return "embankment"
    if tags.get("waterway") == "dam":
        return "dam"
    if "highway" in tags:
        return "road"
    return "building"


def parse_osm_assets(elements: list[dict]) -> list[dict]:
    """Overpass ways → candidate assets, keeping only what OSM actually states."""
    out = []
    for el in elements:
        coords = [[pt["lon"], pt["lat"]] for pt in el.get("geometry") or [] if "lon" in pt and "lat" in pt]
        if len(coords) < 2:
            continue
        tags = el.get("tags") or {}
        closed = len(coords) >= 4 and coords[0] == coords[-1]
        kind = classify_osm(tags)
        geom = {"type": "Polygon", "coordinates": [coords]} if closed and kind == "building" else {"type": "LineString", "coordinates": coords}
        attrs = {k: tags[o] for k, o in (("constructionYear", "start_date"), ("material", "material"), ("structure", "bridge:structure"),
                                         ("lanes", "lanes"), ("operator", "operator"), ("maxWeight", "maxweight"), ("surface", "surface")) if tags.get(o)}
        out.append({"osmId": f"way/{el.get('id')}", "name": tags.get("name") or tags.get("name:en") or tags.get("ref") or "", "assetType": kind,
                    "geometry": geom, "attributes": attrs})
    order = {"bridge": 0, "dam": 1, "embankment": 2, "building": 3, "road": 4}
    out.sort(key=lambda a: (order[a["assetType"]], not a["name"]))
    return out[:OSM_LIMIT]


def find_osm_assets(lat: float, lon: float, radius_m: float = 500.0, post=None) -> list[dict]:
    """Everything mapped nearby. When the public servers are too busy for that, the structures that matter most."""
    around = f"(around:{float(radius_m):.0f},{float(lat)},{float(lon)})"

    def ask(queries: tuple[str, ...], limit: int) -> dict:
        query = "[out:json][timeout:25];(" + "".join(f"{q}{around};" for q in queries) + f");out geom {limit};"
        return overpass_query(query, post) if post else overpass_query(query)

    try:
        payload = ask(ASSET_QUERIES, 200)
    except Exception:  # noqa: BLE001 — overloaded servers answer 502/504; a smaller query often still gets through
        payload = ask(CORE_ASSET_QUERIES, 60)
    return parse_osm_assets(payload.get("elements", []))


# ---------------------------------------------------------------------------- reading analyses at the asset

def _project(geom, crs: str):
    return shape(transform_geom("EPSG:4326", crs, mapping(geom)))


def buffered(geom, buffer_m: float = DEFAULT_BUFFER_M):
    """The asset plus a margin, in WGS84: a road is narrower than the analysis pixels."""
    x, y = geom.centroid.x, geom.centroid.y
    crs = utm_epsg(y, x)
    return shape(transform_geom(crs, "EPSG:4326", mapping(_project(geom, crs).buffer(buffer_m))))


def sample_raster(relative_mm: np.ndarray, coherent: np.ndarray | None, transform: Affine, crs: str, area) -> dict[str, Any]:
    """Statistics of the displacement raster inside ``area`` (pure)."""
    from rasterio.features import geometry_mask

    inside = geometry_mask([transform_geom("EPSG:4326", crs, mapping(area))], out_shape=relative_mm.shape, transform=transform, invert=True, all_touched=True)
    total = int(inside.sum())
    values = relative_mm[inside]
    values = values[np.isfinite(values)]
    if values.size == 0:
        return {"pixels": total, "measured_pixels": 0, "median_mm": None, "low_mm": None, "high_mm": None}
    return {"pixels": total, "measured_pixels": int(values.size), "median_mm": round(float(np.median(values)), 1),
            "low_mm": round(float(np.min(values)), 1), "high_mm": round(float(np.max(values)), 1)}


def observe(record: dict, geom, detection_dir: Path, buffer_m: float = DEFAULT_BUFFER_M) -> dict[str, Any] | None:
    """What one finished analysis saw at the asset; ``None`` when the analysis did not cover it."""
    b = record["bbox"]
    if not (b["west"] <= geom.centroid.x <= b["east"] and b["south"] <= geom.centroid.y <= b["north"]):
        return None
    area = buffered(geom, buffer_m)
    extent = vector.union_geometry(record["geometry"])
    overlap = extent.intersection(area) if extent is not None else None
    # compare in metres: degrees are not square away from the equator
    crs = utm_epsg(geom.centroid.y, geom.centroid.x)
    overlap_share = 0.0 if overlap is None or overlap.is_empty else _project(overlap, crs).area / max(1e-6, _project(area, crs).area)
    before, after = record["before"], record["after"]
    out: dict[str, Any] = {
        "detection_id": record["id"], "kind": record["kind"], "label": record["label"], "noun": record["noun"],
        "before": before.get("first_acquired") or before.get("acquired"), "after": after.get("last_acquired") or after.get("acquired"),
        "confidence": record["confidence"], "quality_flags": record["quality_flags"], "valid_fraction": record["valid_fraction"],
        "resolution_m": record["grid"]["res_m"], "touches_asset": overlap_share > 0, "overlap_share": round(float(overlap_share), 3),
        "patches_truncated": bool(record["geometry"].get("truncated")), "reading": None,
    }
    npz = detection_dir / "displacement.npz"
    if record["kind"] == "ground_deformation" and npz.exists():
        with np.load(npz) as d:
            transform = Affine(*d["transform"][:6])
            out["reading"] = sample_raster(d["relative_mm"], None, transform, str(d["crs"]), area)
    return out


def compare(observations: list[dict]) -> list[dict]:
    """Oldest first, each marked against the previous observation of the same kind (pure)."""
    rows = sorted(observations, key=lambda o: o.get("after") or "")
    last: dict[str, dict] = {}
    for o in rows:
        prev = last.get(o["kind"])
        change = None
        if prev is not None:
            a, b = (prev.get("reading") or {}).get("median_mm"), (o.get("reading") or {}).get("median_mm")
            change = {"previous_id": prev["detection_id"], "newly_touches_asset": bool(o["touches_asset"] and not prev["touches_asset"]),
                      "no_longer_touches_asset": bool(prev["touches_asset"] and not o["touches_asset"]),
                      "median_mm_change": round(b - a, 1) if a is not None and b is not None else None}
        o["change"] = change
        last[o["kind"]] = o
    return rows


# ---------------------------------------------------------------------------- 3D terrain

def terrain_lines(geom, grid: Grid) -> list[list[list[float]]]:
    """The asset's outline as fractions of the terrain square, so the viewer needs no map projection."""
    left, bottom, right, top = grid.bounds
    g = _project(geom, grid.crs)
    def norm(coords) -> list[list[float]]:
        return [[round((x - left) / (right - left), 5), round((top - y) / (top - bottom), 5)] for x, y, *_ in coords]
    if g.geom_type == "Point":
        return [norm(g.coords)]
    if g.geom_type == "LineString":
        return [norm(g.coords)]
    if g.geom_type == "Polygon":
        return [norm(g.exterior.coords)]
    return [norm(part.coords) for part in g.geoms]


def _png_data_uri(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _texture_grid(grid: Grid) -> Grid:
    scale = max(1, int(grid.res_m // TEXTURE_RES_M))
    res = grid.res_m / scale
    return Grid(grid.crs, Affine(res, 0, grid.transform.c, 0, -res, grid.transform.f), grid.width * scale, grid.height * scale, res, grid.bbox)


def satellite_texture(bbox: dict[str, float], grid: Grid) -> tuple[str | None, str | None, str | None]:
    """(data URI, acquisition date, why not): the newest clear Sentinel-2 view. Optional: the terrain works without it."""
    try:
        target = datetime.now(UTC).date() - timedelta(days=5)
        scenes, _ = pipeline._pick_s2(bbox, None, target)
        tex = _texture_grid(grid)
        layers = pipeline._read_s2(scenes, tex, np.ones(tex.shape, dtype=bool), "now")
        image = render.true_colour(layers["red_now"], layers["green_now"], layers["blue_now"])
        return _png_data_uri(image), scenes[0].acquired.date().isoformat(), None
    except EOUnavailable as exc:
        return None, None, str(exc)


def displacement_texture(npz: Path, grid: Grid, limit_mm: float = 30.0) -> str | None:
    """A saved displacement field draped on the terrain (teal: toward the satellite, brown: away)."""
    from rasterio.enums import Resampling
    from rasterio.warp import reproject

    if not npz.exists():
        return None
    tex = _texture_grid(grid)
    out = np.full(tex.shape, np.nan, dtype="float32")
    with np.load(npz) as d:
        reproject(d["relative_mm"], out, src_transform=Affine(*d["transform"][:6]), src_crs=str(d["crs"]), src_nodata=np.nan,
                  dst_transform=tex.transform, dst_crs=tex.crs, dst_nodata=np.nan, resampling=Resampling.nearest)
    return _png_data_uri(render.diverging(out, limit_mm))


def terrain(geom, cache_dir: Path, detection_npz: Path | None = None) -> dict[str, Any]:
    """Elevation grid, asset outline and textures around the asset. The elevation and satellite view are cached on disk."""
    w, s, e, n = geom.bounds
    m = TERRAIN_MARGIN_DEG
    bbox = {"west": w - m, "south": s - m, "east": e + m, "north": n + m}
    grid = make_grid(bbox, max_pixels=TERRAIN_PIXELS, min_res_m=30.0)
    key = "_".join(f"{bbox[k]:.5f}" for k in ("west", "south", "east", "north"))
    cache = cache_dir / f"{key}.json"
    fresh = cache.exists() and datetime.now(UTC).timestamp() - cache.stat().st_mtime < 14 * 86400
    if fresh:
        base = json.loads(cache.read_text(encoding="utf-8"))
    else:
        dem = read_mosaic(access.ancillary_hrefs("cop-dem-glo-30", "data", bbox), grid)
        if not np.isfinite(dem).any():
            raise EOUnavailable("No elevation data covers this asset.")
        dem = np.where(np.isfinite(dem), dem, float(np.nanmedian(dem)))
        uri, when, why = satellite_texture(bbox, grid)
        base = {"width": grid.width, "height": grid.height, "res_m": grid.res_m, "heights": [round(float(v), 1) for v in dem.ravel()],
                "min_m": round(float(dem.min()), 1), "max_m": round(float(dem.max()), 1), "satellite": uri, "satellite_date": when, "satellite_note": why,
                "source": "Copernicus DEM GLO-30"}
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(base), encoding="utf-8")
    return {**base, "lines": terrain_lines(geom, grid), "displacement": displacement_texture(detection_npz, grid) if detection_npz else None}
