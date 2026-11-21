"""The cheap per-cell proxy for need. Kept deliberately simple and documented; the estimator corrects its bias.

predicted_need = reported + households x BASE_NEED_RATE x hazard_score

* ``reported``: help requests, SOS and Drain Watch reports in the cell, counted as one household each.
* ``households``: population / PEOPLE_PER_HOUSEHOLD. Without population data the caller passes a documented
  placeholder (a uniform density), and says so in the result.
* ``hazard_score``: the combined 0-1 score of the hazard layer.

A wrong proxy cannot bias the estimate (the field checks correct it); it only makes the range wider.
"""

from __future__ import annotations

import numpy as np

PEOPLE_PER_HOUSEHOLD = 4.5
BASE_NEED_RATE = 0.2                 # share of households needing help when hazard_score = 1
PLACEHOLDER_DENSITY_PER_KM2 = 400.0  # people per km² when no population data is given (documented placeholder)
EXPECTED_REPORTING_RATE = 0.3        # share of needy households expected to report when networks work (silent zones)


def households(cells: list[dict]) -> np.ndarray:
    out = []
    for c in cells:
        pop = c.get("population")
        if pop is None:
            pop = PLACEHOLDER_DENSITY_PER_KM2 * float(c.get("area_km2") or 1.0)
        out.append(max(0.0, float(pop)) / PEOPLE_PER_HOUSEHOLD)
    return np.asarray(out, dtype=float)


def predicted_need(cells: list[dict]) -> np.ndarray:
    hh = households(cells)
    hz = np.asarray([float(c.get("hazard") or 0.0) for c in cells])
    rep = np.asarray([float(c.get("reported") or 0.0) for c in cells])
    return rep + hh * BASE_NEED_RATE * np.clip(hz, 0, 1)


def features(cells: list[dict]) -> np.ndarray:
    """Covariates for the cross-fitted proxy model (all cheap, known for every cell)."""
    hh = households(cells)
    hz = np.clip(np.asarray([float(c.get("hazard") or 0.0) for c in cells]), 0, 1)
    rep = np.asarray([float(c.get("reported") or 0.0) for c in cells])
    return np.column_stack([hz, np.log1p(hh), rep, hz * hh])
