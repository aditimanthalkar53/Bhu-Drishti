"""
Risk framework: HAZARD → EXPOSURE → VULNERABILITY → RISK.

A transparent convention, not a calibrated model. Each component gets a
level from documented bands, with the evidence and the uncertainty that fed
it; risk is read from a standard hazard × exposure matrix. Vulnerability has
no data source in this deployment and is therefore UNKNOWN — it is carried
through explicitly and the overall result is marked as not including it.

The bands live in ``RISK_METHOD`` and are returned with every assessment so a
reader can see exactly how a level was reached.
"""

from __future__ import annotations

from typing import Any

LEVELS = ("low", "medium", "high", "critical")

RISK_METHOD: dict[str, Any] = {
    "id": "risk-matrix", "version": "1.0.0",
    "summary": "Level bands per component, combined with a hazard × exposure matrix. "
               "A documented convention, not a calibrated model.",
    "hazard_bands_km2": {"low": "< 0.5", "medium": "0.5 – 5", "high": "5 – 25", "critical": "≥ 25"},
    "exposure_bands_people": {"low": "< 100", "medium": "100 – 1,000",
                              "high": "1,000 – 10,000", "critical": "≥ 10,000"},
    "exposure_rule": "Raised one level when a hospital, fire station, power substation or "
                     "airport lies inside the extent.",
    "matrix": "Risk = the higher of the two levels when they differ by one or less; "
              "otherwise one below the higher.",
    "vulnerability": "UNKNOWN — no vulnerability data source is integrated; not included.",
}

_HAZARD_KM2 = (0.5, 5.0, 25.0)
_EXPOSURE_PEOPLE = (100.0, 1000.0, 10000.0)
_CRITICAL_ASSETS = ("hospital", "fire_station", "power_substation", "airport")


def _band(value: float, cuts: tuple[float, float, float]) -> int:
    return sum(value >= c for c in cuts)


def hazard_level(area_km2: float) -> int:
    return _band(area_km2, _HAZARD_KM2)


def exposure_level(people: float, asset_counts: dict[str, int] | None) -> tuple[int, bool]:
    """(level index, raised_by_critical_asset)."""
    level = _band(people, _EXPOSURE_PEOPLE)
    critical = any((asset_counts or {}).get(t, 0) > 0 for t in _CRITICAL_ASSETS)
    return (min(3, level + 1), True) if critical else (level, False)


def combine(hazard: int, exposure: int) -> int:
    top = max(hazard, exposure)
    return top if abs(hazard - exposure) <= 1 else top - 1


def assess(*, detected: bool, area_km2: float, area_low: float, area_high: float,
           confidence: str, population: dict[str, Any] | None,
           assets: dict[str, Any] | None, exposure_applicable: bool = True) -> dict[str, Any]:
    """Full assessment for one detection. All inputs are measured values or None."""
    if not detected:
        return {
            "level": "low", "complete": True, "basis": "nothing detected",
            "explanation": "No change was detected, so there is no hazard to assess.",
            "method": RISK_METHOD,
            "components": [
                {"name": "hazard", "status": "available", "score": 0.0, "label": "NONE DETECTED",
                 "basis": "The detector found no patch beyond its thresholds.", "details": []},
                {"name": "exposure", "status": "available", "score": 0.0, "label": "NONE",
                 "basis": "No extent, so nothing is exposed.", "details": []},
                {"name": "vulnerability", "status": "unavailable", "score": None, "label": "UNKNOWN",
                 "basis": RISK_METHOD["vulnerability"], "details": []},
            ],
            "range": None,
        }

    h = hazard_level(area_km2)
    h_low, h_high = hazard_level(area_low), hazard_level(area_high)
    hazard = {
        "name": "hazard", "status": "available", "score": (h + 1) / 4, "label": LEVELS[h].upper(),
        "basis": (f"Detected extent {area_km2:.2f} km² (range {area_low:.2f}–{area_high:.2f} km² "
                  f"across detection thresholds); detection confidence: {confidence}."),
        "details": [{"label": "Band", "value": RISK_METHOD["hazard_bands_km2"][LEVELS[h]], "unit": "km²"}],
    }

    asset_counts = (assets or {}).get("counts") if assets and assets.get("status") == "available" else None
    if not exposure_applicable:
        exposure = {"name": "exposure", "status": "not_assessed", "score": None, "label": "NOT APPLICABLE",
                    "basis": "Population exposure is not a meaningful measure for this event type.",
                    "details": []}
        e = e_low = e_high = None
    elif population is None:
        exposure = {"name": "exposure", "status": "unavailable", "score": None, "label": "UNAVAILABLE",
                    "basis": "Population data could not be retrieved, so exposure was not scored.",
                    "details": []}
        e = e_low = e_high = None
    else:
        e, raised = exposure_level(population["value"], asset_counts)
        e_low, _ = exposure_level(population["low"], asset_counts)
        e_high, _ = exposure_level(population["high"], asset_counts)
        basis = (f"About {population['value']:,} people inside the detected extent "
                 f"(range {population['low']:,}–{population['high']:,} across population datasets).")
        if asset_counts is None:
            basis += " Critical facilities could not be checked."
        elif raised:
            basis += " Raised one level: a critical facility lies inside the extent."
        exposure = {
            "name": "exposure", "status": "available", "score": (e + 1) / 4, "label": LEVELS[e].upper(),
            "basis": basis,
            "details": [{"label": "Band", "value": RISK_METHOD["exposure_bands_people"][LEVELS[_band(population['value'], _EXPOSURE_PEOPLE)]], "unit": "people"}],
        }

    vulnerability = {"name": "vulnerability", "status": "unavailable", "score": None,
                     "label": "UNKNOWN", "basis": RISK_METHOD["vulnerability"], "details": []}

    if e is None:
        level, lo, hi = h, h_low, h_high
        basis = "hazard only"
        why = (f"Rated {LEVELS[level].upper()} from the detected extent alone. "
               + exposure["basis"] + " Vulnerability is unknown.")
    else:
        level = combine(h, e)
        options = [combine(a, b) for a in (h_low, h, h_high) for b in (e_low, e, e_high)]
        lo, hi = min(options), max(options)
        basis = "hazard × exposure (vulnerability unknown)"
        driver = ("both the extent and the number of people inside it" if h == e else
                  "the size of the detected extent" if h > e else
                  "the number of people and facilities inside the extent")
        why = (f"Rated {LEVELS[level].upper()}, driven mainly by {driver}. "
               "Vulnerability is unknown and not included.")
    if lo != hi:
        why += f" Given the input ranges, the level could be {LEVELS[lo].upper()} to {LEVELS[hi].upper()}."

    return {
        "level": LEVELS[level], "complete": False, "basis": basis, "explanation": why,
        "method": RISK_METHOD, "components": [hazard, exposure, vulnerability],
        "range": {"low": LEVELS[lo], "high": LEVELS[hi]},
    }
