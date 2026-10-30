"""Raster mask → vector polygons (WGS84), areas, and point-in-extent tests."""

from __future__ import annotations

from typing import Any

import numpy as np
from affine import Affine
from rasterio import features
from rasterio.warp import transform_geom
from shapely.geometry import Point, mapping, shape
from shapely.ops import unary_union
from shapely.prepared import prep

MAX_POLYGONS = 400


def mask_to_polygons(mask: np.ndarray, transform: Affine, crs: str, res_m: float,
                     max_polygons: int = MAX_POLYGONS) -> dict[str, Any]:
    """Polygonise ``mask`` (True = feature). Areas are computed in the metric grid CRS.

    Returns a WGS84 FeatureCollection, largest patches first. When there are
    more than ``max_polygons`` patches the smallest are dropped from the
    geometry (not from area totals, which come from the raster) and
    ``truncated`` is set.
    """
    polys = []
    if mask.any():
        for geom, value in features.shapes(mask.astype("uint8"), mask=mask, transform=transform):
            if value != 1:
                continue
            g = shape(geom)
            if g.is_empty:
                continue
            polys.append(g)
    polys.sort(key=lambda g: g.area, reverse=True)
    truncated = len(polys) > max_polygons
    out = []
    for i, g in enumerate(polys[:max_polygons]):
        area_km2 = g.area / 1e6
        simple = g.simplify(res_m * 0.75, preserve_topology=True)
        if simple.is_empty or not simple.is_valid:
            simple = g
        out.append({
            "type": "Feature",
            "id": i,
            "properties": {"area_km2": round(area_km2, 4)},
            "geometry": transform_geom(crs, "EPSG:4326", mapping(simple), precision=6),
        })
    return {"type": "FeatureCollection", "features": out, "truncated": truncated,
            "patch_count": len(polys)}


def union_geometry(collection: dict[str, Any]):
    """Shapely union of a FeatureCollection's geometries (None when empty)."""
    geoms = [shape(f["geometry"]) for f in collection.get("features", [])]
    geoms = [g if g.is_valid else g.buffer(0) for g in geoms if not g.is_empty]
    return unary_union(geoms) if geoms else None


def points_inside(points: dict[str, Any], extent) -> dict[str, Any]:
    """Subset of a point FeatureCollection lying inside ``extent`` (a shapely geometry)."""
    if extent is None or extent.is_empty:
        return {"type": "FeatureCollection", "features": []}
    prepared = prep(extent)
    inside = [f for f in points.get("features", [])
              if prepared.contains(Point(*f["geometry"]["coordinates"][:2]))]
    return {"type": "FeatureCollection", "features": inside}


def bbox_polygon(bbox: dict[str, float]) -> dict[str, Any]:
    w, s, e, n = bbox["west"], bbox["south"], bbox["east"], bbox["north"]
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}
