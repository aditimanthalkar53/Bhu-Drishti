"""People per grid cell from the Meta HRSL 30 m raster (zonal sums, never area × density).

The cells of a run are read one row of cells at a time (one raster window per row), summing the pixels whose centre
falls in each cell. Results are cached per cell for 30 days in the source cache. Cells that cannot be read are left
out of the answer, so the caller knows exactly which ones fall back to anything else.
"""

from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import numpy as np

from ..sources.ttlcache import TTLCache

MAX_PIXELS = 60_000_000          # about 2.2° × 2.2° at 1 arc-second
CACHE_S = 30 * 86400


def _sum_row(row: list[dict]) -> dict[str, float]:
    import rasterio
    from rasterio.windows import Window, from_bounds
    from rasterio.windows import transform as window_transform

    from ..eo.grid import GDAL_ENV
    from ..eo.population import HRSL_VRT

    w = min(c["bbox"][0] for c in row); s = min(c["bbox"][1] for c in row)
    e = max(c["bbox"][2] for c in row); n = max(c["bbox"][3] for c in row)
    with rasterio.Env(**GDAL_ENV), rasterio.open(HRSL_VRT) as ds:
        win = from_bounds(w, s, e, n, transform=ds.transform)
        win = Window(int(math.floor(win.col_off)), int(math.floor(win.row_off)), int(math.ceil(win.width)) + 1, int(math.ceil(win.height)) + 1)
        data = ds.read(1, window=win, boundless=True, fill_value=0, masked=True).filled(0).astype("float64")
        t = window_transform(win, ds.transform)
    data = np.where(np.isfinite(data) & (data > 0), data, 0.0)
    lons = t.c + (np.arange(data.shape[1]) + 0.5) * t.a
    lats = t.f + (np.arange(data.shape[0]) + 0.5) * t.e
    out = {}
    for c in row:
        cw, cs, ce, cn = c["bbox"]
        cols = (lons >= cw) & (lons < ce)
        rows = (lats >= cs) & (lats < cn)
        out[c["id"]] = float(data[np.ix_(rows, cols)].sum())
    return out


def cell_population(cells: list[dict], cache: Optional[TTLCache] = None, workers: int = 6) -> dict:
    """{"population": {cell_id: people}, "missing": [cell ids], "source": ..., "errors": [...]}"""
    if cache is None:
        from ..sources.registry import source_cache
        cache = source_cache()
    found: dict[str, float] = {}
    todo = []
    for c in cells:
        hit = cache.get(TTLCache.key("hrsl_cell", tuple(round(v, 6) for v in c["bbox"])))
        if hit is not None:
            found[c["id"]] = float(hit)
        else:
            todo.append(c)
    total_px = sum((c["bbox"][2] - c["bbox"][0]) * (c["bbox"][3] - c["bbox"][1]) * 3600 ** 2 for c in todo)
    errors: list[str] = []
    if todo and total_px > MAX_PIXELS:
        errors.append("area too large for a 30 m population read; use a smaller area")
        todo = []
    rows: dict[float, list[dict]] = {}
    for c in todo:
        rows.setdefault(round(c["bbox"][1], 6), []).append(c)
    if rows:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for row, fut in [(r, pool.submit(_sum_row, r)) for r in rows.values()]:
                try:
                    got = fut.result()
                except Exception as exc:  # noqa: BLE001 - a failed row leaves its cells missing, reported below
                    errors.append(f"{type(exc).__name__}: {str(exc)[:120]}")
                    continue
                for c in row:
                    found[c["id"]] = got[c["id"]]
                    cache.put(TTLCache.key("hrsl_cell", tuple(round(v, 6) for v in c["bbox"])), got[c["id"]], CACHE_S)
    missing = [c["id"] for c in cells if c["id"] not in found]
    return {"population": {k: round(v, 1) for k, v in found.items()}, "missing": missing,
            "source": "Meta High Resolution Settlement Layer (HRSL, ~30 m, CC BY 4.0), zonal sum per cell",
            "errors": sorted(set(errors))[:3]}
