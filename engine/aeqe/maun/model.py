"""Per-cell covariates for Maun. No tuned constants: the relationship between hazard, people and need is learned from
the field checks by the cross-fitted proxy model (``SampleState``), not assumed.

* ``households``: population / PEOPLE_PER_HOUSEHOLD. Population comes from the HRSL 30 m raster summed per cell
  (``population.cell_population``). Only when that is unavailable does the caller fall back to a documented flat
  density, and every result says how many cells used it.
* ``design_score``: what the strata are built on, before any check exists. It is the average of two percentile ranks,
  households exposed to the hazard (households × hazard score) and reports in the cell, so neither needs a weight or a
  scale. Any score keeps the estimate valid (selection stays random within strata); a better one only narrows the range.
* ``features``: the covariates the proxy model learns from: each hazard layer separately (so the data decide how much
  fire, rain, flood or river forecast matter), households, reports and the exposure interactions.

PEOPLE_PER_HOUSEHOLD is the census figure (Census of India 2011: 1,210.9 million people in 246.7 million households,
about 4.9 per household); it converts people to households and is not a modelling choice.
"""

from __future__ import annotations

import numpy as np

PEOPLE_PER_HOUSEHOLD = 4.9
FALLBACK_DENSITY_PER_KM2 = 400.0   # only when no population raster could be read; reported as such

# kept for runs created before design version 2 (replay must rebuild their strata exactly)
LEGACY_NEED_RATE = 0.2
LEGACY_PEOPLE_PER_HOUSEHOLD = 4.5


def population(cells: list[dict]) -> tuple[np.ndarray, int]:
    """People per cell and how many cells fell back to the flat density."""
    out, fallback = [], 0
    for c in cells:
        p = c.get("population")
        if p is None:
            fallback += 1
            p = FALLBACK_DENSITY_PER_KM2 * float(c.get("area_km2") or 1.0)
        out.append(max(0.0, float(p)))
    return np.asarray(out, dtype=float), fallback


def households(cells: list[dict], version: int = 2) -> np.ndarray:
    pop, _ = population(cells)
    return pop / (PEOPLE_PER_HOUSEHOLD if version >= 2 else LEGACY_PEOPLE_PER_HOUSEHOLD)


def _rank01(v: np.ndarray) -> np.ndarray:
    """Percentile rank in [0, 1]; ties share their average rank, all-equal gives 0.5."""
    n = len(v)
    if n == 0 or np.all(v == v[0]):
        return np.full(n, 0.5)
    order = np.argsort(v, kind="mergesort")
    ranks = np.empty(n)
    ranks[order] = np.arange(n)
    for val in np.unique(v):                       # average ranks of ties
        m = v == val
        ranks[m] = ranks[m].mean()
    return ranks / (n - 1)


def _arr(cells, key) -> np.ndarray:
    return np.asarray([float(c.get(key) or 0.0) for c in cells])


def design_score(cells: list[dict], version: int = 2) -> np.ndarray:
    hz = np.clip(_arr(cells, "hazard"), 0, 1)
    rep = _arr(cells, "reported")
    if version < 2:
        return rep + households(cells, 1) * LEGACY_NEED_RATE * hz
    return (_rank01(households(cells) * hz) + _rank01(rep)) / 2


def layer_names(cells: list[dict]) -> list[str]:
    return sorted({k for c in cells for k in (c.get("layers") or {})})


def features(cells: list[dict], version: int = 2) -> np.ndarray:
    """Covariates for the cross-fitted proxy model (all cheap, known for every cell)."""
    hh = households(cells, version)
    hz = np.clip(_arr(cells, "hazard"), 0, 1)
    rep = _arr(cells, "reported")
    cols = [hz, np.log1p(hh), rep, hz * hh]
    if version >= 2:
        for name in layer_names(cells):
            v = np.asarray([float((c.get("layers") or {}).get(name) or 0.0) for c in cells])
            cols += [v, v * hh]
    return np.column_stack(cols)
