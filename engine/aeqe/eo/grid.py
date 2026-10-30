"""Analysis grid and aligned raster reads.

Every band of every scene is warped onto one metric (UTM) grid covering the area, so arrays line up pixel-for-pixel
regardless of source CRS, tile or resolution, and pixel counts convert to areas exactly (``res_m ** 2``). Reads are
windowed over HTTP against cloud-optimised GeoTIFFs — only the area (at a suitable overview level) is transferred,
never a whole scene.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass

import numpy as np
import rasterio
from affine import Affine
from rasterio.enums import Resampling
from rasterio.features import geometry_mask
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds, transform_geom
from shapely.geometry import mapping

from . import EOUnavailable
from .access import sign

MAX_PIXELS = int(os.getenv("AEQE_EO_MAX_PIXELS", "1400000"))
NATIVE_RES_M = 10.0

GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "GDAL_HTTP_TIMEOUT": "45",
    "GDAL_HTTP_MAX_RETRY": "2",
    "GDAL_HTTP_RETRY_DELAY": "1",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.tiff,.vrt,.zip",
    "VSI_CACHE": "TRUE",
}


@dataclass(frozen=True)
class Grid:
    crs: str
    transform: Affine
    width: int
    height: int
    res_m: float
    bbox: dict[str, float]          # WGS84 rectangle the grid covers

    @property
    def shape(self) -> tuple[int, int]:
        return (self.height, self.width)

    @property
    def pixel_area_km2(self) -> float:
        return (self.res_m ** 2) / 1e6

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        left, top = self.transform.c, self.transform.f
        return (left, top - self.height * self.res_m, left + self.width * self.res_m, top)


def utm_epsg(lat: float, lng: float) -> str:
    zone = int(math.floor((lng + 180.0) / 6.0)) % 60 + 1
    return f"EPSG:{(32600 if lat >= 0 else 32700) + zone}"


def make_grid(bbox: dict[str, float], max_pixels: int = MAX_PIXELS, min_res_m: float = NATIVE_RES_M) -> Grid:
    """UTM grid over ``bbox`` at the finest resolution that stays under ``max_pixels``."""
    lat = (bbox["south"] + bbox["north"]) / 2
    lng = (bbox["west"] + bbox["east"]) / 2
    crs = utm_epsg(lat, lng)
    left, bottom, right, top = transform_bounds(
        "EPSG:4326", crs, bbox["west"], bbox["south"], bbox["east"], bbox["north"], densify_pts=21)
    width_m, height_m = right - left, top - bottom
    res = max(min_res_m, math.sqrt(width_m * height_m / max_pixels))
    res = math.ceil(res / 10.0) * 10.0          # 10, 20, 30… m: clean multiples of native
    width, height = max(1, math.ceil(width_m / res)), max(1, math.ceil(height_m / res))
    return Grid(crs=crs, transform=Affine(res, 0, left, 0, -res, top), width=width, height=height, res_m=res, bbox=dict(bbox))


def display_grid(bbox: dict[str, float], max_side: int = 900) -> Grid:
    """Web-Mercator grid for map overlays (image corners then match the bbox exactly)."""
    left, bottom, right, top = transform_bounds("EPSG:4326", "EPSG:3857", bbox["west"], bbox["south"], bbox["east"], bbox["north"])
    res = max(right - left, top - bottom) / max_side
    width, height = max(1, round((right - left) / res)), max(1, round((top - bottom) / res))
    return Grid(crs="EPSG:3857", transform=Affine(res, 0, left, 0, -res, top), width=width, height=height, res_m=res, bbox=dict(bbox))


def aoi_mask(grid: Grid, geometry) -> np.ndarray:
    """True for pixels whose centre lies inside ``geometry`` (shapely, WGS84); everywhere when there is no geometry."""
    if geometry is None:
        return np.ones(grid.shape, dtype=bool)
    projected = transform_geom("EPSG:4326", grid.crs, mapping(geometry))
    return geometry_mask([projected], out_shape=grid.shape, transform=grid.transform, invert=True)


def overview_level(overviews: list[int], source_res_m: float, target_res_m: float) -> int | None:
    """Index of the coarsest overview still at least as fine as the target; ``None`` = read full resolution (pure)."""
    level = None
    for i, factor in enumerate(overviews):
        if factor * source_res_m <= target_res_m:
            level = i
    return level


def _source_res_m(src, grid: Grid) -> float:
    res = abs(src.res[0])
    if src.crs and src.crs.is_geographic:
        lat = (grid.bbox["south"] + grid.bbox["north"]) / 2
        return res * 111320.0 * math.cos(math.radians(lat))
    return res


def read_band(href: str, grid: Grid, resampling: Resampling = Resampling.bilinear, nodata: float | None = None) -> np.ndarray:
    """One band warped onto ``grid`` as float32, NaN where the source has no data.

    A WarpedVRT does not use the source's overviews by itself: without choosing a level here, a 300 m grid reads the
    whole 10 m scene over HTTP (minutes per band instead of seconds)."""
    try:
        url = sign(href)
        with rasterio.Env(**GDAL_ENV):
            with rasterio.open(url) as probe:
                level = overview_level(probe.overviews(1), _source_res_m(probe, grid), grid.res_m)
            options = {} if level is None else {"overview_level": level}
            with rasterio.open(url, **options) as src:
                src_nodata = nodata if nodata is not None else src.nodata
                with WarpedVRT(src, crs=grid.crs, transform=grid.transform, width=grid.width, height=grid.height,
                               resampling=resampling, src_nodata=src_nodata, nodata=np.nan, dtype="float32") as vrt:
                    return vrt.read(1)
    except EOUnavailable:
        raise
    except Exception as exc:
        raise EOUnavailable(f"Satellite raster could not be read ({type(exc).__name__}). "
                            "The data provider may be slow or unavailable.") from exc


def read_mosaic(hrefs: list[str], grid: Grid, resampling: Resampling = Resampling.bilinear, nodata: float | None = None) -> np.ndarray:
    """First-valid mosaic of several sources (adjacent tiles / slices of one pass)."""
    if not hrefs:
        raise EOUnavailable("No source rasters cover this area.")
    out = np.full(grid.shape, np.nan, dtype="float32")
    for href in hrefs:
        if not np.isnan(out).any():
            break
        tile = read_band(href, grid, resampling, nodata)
        fill = np.isnan(out) & ~np.isnan(tile)
        out[fill] = tile[fill]
    return out


def slope_degrees(dem: np.ndarray, res_m: float) -> np.ndarray:
    """Terrain slope in degrees from an elevation grid (NaN propagates)."""
    dzdy, dzdx = np.gradient(dem.astype("float64"), res_m)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy))).astype("float32")
