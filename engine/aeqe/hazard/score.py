"""Combine hazard layers into one score per cell, and run all adapters for an area."""

from __future__ import annotations

import concurrent.futures as cf
import threading
import time
from datetime import timedelta
from typing import Optional

from ..ir import utc_today
from ..sources.base import SourceError, redact
from .adapters import ADAPTERS, HazardAdapter, HazardCell, LayerResult
from .grid import make_grid

# No tuned weights: every layer counts equally, and each is put on 0-1 by a published reference or a scale-free form.
# The display score is only used to draw the map, build Maun's strata and rank requests; Maun's estimate learns from
# field checks how much each layer actually matters (each layer is a separate covariate of its proxy model).
IMD_VERY_HEAVY_MM = 115.6     # India Meteorological Department: "very heavy rainfall" starts at 115.6 mm in 24 h
WEIGHTS: dict[str, float] = {"modis_flood": 1.0, "firms": 1.0, "imerg": 1.0, "glofas": 1.0, "rain_forecast": 1.0}

SCORE_DOC = (
    "hazard_score = the largest of the available layers, each on 0-1, all weighted equally, so one strong signal is "
    "enough and a missing layer never lowers the score. Layers: MODIS flood = the share of observed land flooded (a "
    "fraction already); FIRMS = 1 if the cell has an active-fire detection; IMERG and the rain forecast = wettest day "
    "÷ 115.6 mm (IMD's 'very heavy rainfall' threshold); GloFAS = 1 − (normal flow ÷ forecast peak), the share of the "
    "peak that is above the last 7 days' mean. Area-level layers (IMERG, MODIS) give every cell the same value. Forecast "
    "layers are model forecasts, not observations. Maun does not use these scales for its estimate: it learns each "
    "layer's effect from the field checks."
)


def normalise(source: str, value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    if source == "firms":
        return 1.0 if value >= 1 else 0.0
    if source == "modis_flood":
        return max(0.0, min(1.0, value))
    if source in ("imerg", "rain_forecast"):
        return max(0.0, min(1.0, value / IMD_VERY_HEAVY_MM))
    if source == "glofas":
        return max(0.0, min(1.0, 1.0 - 1.0 / value)) if value > 0 else 0.0
    return None


def combine(layers: dict[str, dict[str, HazardCell]], cell_ids: list[str]) -> dict[str, float]:
    out = {}
    for cid in cell_ids:
        best = 0.0
        for src, cells in layers.items():
            hc = cells.get(cid)
            n = normalise(src, hc.value) if hc else None
            if n is not None:
                best = max(best, WEIGHTS.get(src, 1.0) * n)
        out[cid] = round(best, 4)
    return out


def _run(adapter: HazardAdapter, cells, bbox, start, end) -> LayerResult:
    ok, why = adapter.configured()
    res = LayerResult(adapter.id, adapter.name, "not_configured", area_level=adapter.area_level, kind=adapter.kind, note=why)
    if not ok:
        return res
    try:
        hcs = adapter.fetch(cells, bbox, start, end)
    except SourceError as e:
        res.state, res.note = ("not_configured" if e.kind == "not_configured" else "error"), redact(e.message)
        return res
    except Exception as e:  # noqa: BLE001 - one broken source must not break the layer
        res.state, res.note = "error", redact(f"{type(e).__name__}: {e}")[:300]
        return res
    if not hcs:
        res.state, res.note = "no_data", "no data for this area and window"
        return res
    res.state, res.cells = "ok", hcs
    times = [h.observed_at for h in hcs if h.observed_at]
    res.observed_at = max(times) if times else None
    lats = [h.latency_s for h in hcs if h.latency_s is not None]
    res.latency_s = min(lats) if lats else None
    res.note = "area-level value" if adapter.area_level else ""
    return res


_cache: dict[tuple, tuple[float, dict]] = {}
_lock = threading.Lock()
CACHE_S = 900


def hazard_grid(bbox, cell_deg: float = 0.05, days: int = 3, adapters: Optional[list[HazardAdapter]] = None,
                timeout_s: float = 120.0, use_cache: bool = True) -> dict:
    bbox = tuple(round(float(v), 4) for v in bbox)
    key = (bbox, round(cell_deg, 4), days, tuple(a.id for a in adapters) if adapters else None)
    if use_cache:
        with _lock:
            hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_S:
            return hit[1]
    cells = make_grid(bbox, cell_deg)
    end = utc_today()
    start = end - timedelta(days=max(1, days) - 1)
    ads = adapters if adapters is not None else ADAPTERS
    pool = cf.ThreadPoolExecutor(max_workers=max(1, len(ads)))
    futs = {pool.submit(_run, a, cells, bbox, start, end): a for a in ads}
    done, _ = cf.wait(futs, timeout=timeout_s)
    results: list[LayerResult] = []
    for f, a in futs.items():
        if f in done:
            results.append(f.result())
        else:
            results.append(LayerResult(a.id, a.name, "timeout", note=f"no answer within {int(timeout_s)} s; try again later",
                                       area_level=a.area_level, kind=a.kind))
    pool.shutdown(wait=False, cancel_futures=True)
    layers = {r.source: {h.cell_id: h for h in r.cells} for r in results if r.state == "ok"}
    scores = combine(layers, [c.id for c in cells])
    out_cells = []
    for c in cells:
        lay = {}
        for src, m in layers.items():
            h = m.get(c.id)
            if h is not None:
                lay[src] = {"value": h.value, "norm": normalise(src, h.value), "unit": h.unit, "observed_at": h.observed_at}
        out_cells.append({"cell_id": c.id, "bbox": list(c.bbox), "area_km2": round(c.area_km2(), 3), "hazard_score": scores[c.id], "layers": lay})
    out = {"bbox": list(bbox), "cell_deg": cell_deg, "days": days, "cells": out_cells, "sources": [r.to_json() for r in results],
           "score_doc": SCORE_DOC, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if use_cache:
        with _lock:
            _cache[key] = (time.time(), out)
    return out
