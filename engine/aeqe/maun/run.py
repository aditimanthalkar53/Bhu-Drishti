"""One Maun estimation run, recomputed deterministically from what was recorded.

The backend stores the run (cells with their covariates, the seed, the per-stratum allocation of every wave of field
checks, and the results entered so far). ``compute`` rebuilds the exact same sample from that record and returns the
estimate, so nothing has to live in engine memory and a restart changes nothing.

Design (unchanged AEQE components):
* strata: ``build_strata`` on the design score (see model.py: percentile ranks, no weights);
* selection: each wave's allocation comes from ``SampleState.allocate`` (sequential Neyman, every stratum keeps a
  minimum share, a pilot of 3 per stratum first); cells are taken from each stratum's seeded random order, so a wave is
  a random sample within strata;
* estimate: ``SampleState.best`` (cross-fitted difference estimator from 30 checks on, stratified before that), at the
  confidence given by ``spent_confidence`` for the number of looks, so peeking after every wave keeps the coverage.
  The proxy model learns from the checks how need relates to each hazard layer, households and reports.

Data-driven outputs, no thresholds:
* reporting rate: reports ÷ measured need over the checked cells (ratio estimator with a 95% interval), per stratum
  and overall;
* silent zones: cells where need is significantly above reports, tested per cell and controlled for false discoveries
  (Benjamini-Hochberg, 10%): with the proxy model's prediction and its residual spread once it exists, with the
  stratum's measured gap before that; checked cells show their observed unreported need directly; "reports stopped"
  is a Poisson test of no reports in the last 24 h given the previous 48 h.

Two rules keep the sample honest:
* a selected cell that cannot be reached is never swapped for an easier one. It stays in the sample; the range is
  widened to cover both extremes (no need there, and every household in need) and the cell is flagged as a priority;
* checks in cells that were not selected are refused: adding them would break the random selection.

The range covers sampling error only; it does not cover counting mistakes in the field or errors in the population map.
"""

from __future__ import annotations

import copy
import math
from typing import Optional

import numpy as np
from scipy import stats

from ..engine import spent_confidence
from ..estimators import CROSSFIT_MIN_N, MIN_PER_STRATUM, SampleState, build_strata
from .model import design_score, features, households, population

MIN_CELLS = 12
MIN_DONE_PER_STRATUM = 2       # a stratum's variance needs two checks; below this there is no honest range yet
FDR = 0.10                     # false-discovery rate for silent-zone flags (Benjamini-Hochberg)


class MaunSpecError(ValueError):
    pass


def _clean(v: float) -> float:
    return float(v) if v is not None and math.isfinite(v) else 0.0


def _estimate(state: SampleState, X: np.ndarray, conf: float, mask: Optional[np.ndarray]) -> dict:
    if mask is None:
        e = state.best(X, conf)
    else:
        s = copy.copy(state)
        s.y = np.where(mask, state.y, 0.0)
        e = s.stratified(conf)          # domain totals: stratified estimator of the masked variable
    return {"estimate": _clean(e.estimate), "lo": _clean(e.lo), "hi": _clean(e.hi), "se": _clean(e.se), "method": e.method, "n": e.n,
            "r2": None if e.r2 is None else round(float(e.r2), 4)}


def _bounded(state: SampleState, X, unreachable: list[int], cap: np.ndarray, conf: float, mask=None) -> dict:
    """Estimate; with unreachable cells, the union of the ranges with them at 0 and at their maximum."""
    if not unreachable:
        e = _estimate(state, X, conf, mask)
        e["bounded_by_unreachable"] = False
    else:
        s0, s1 = copy.deepcopy(state), copy.deepcopy(state)
        for i in unreachable:
            s0.record(i, 0.0)
            s1.record(i, float(cap[i]))
        e0, e1 = _estimate(s0, X, conf, mask), _estimate(s1, X, conf, mask)
        e = {"estimate": (e0["estimate"] + e1["estimate"]) / 2, "lo": min(e0["lo"], e1["lo"]), "hi": max(e0["hi"], e1["hi"]),
             "se": max(e0["se"], e1["se"]), "method": e1["method"], "n": e1["n"], "r2": e1["r2"], "bounded_by_unreachable": True,
             "if_unreachable_zero": e0["estimate"], "if_unreachable_max": e1["estimate"]}
    e["lo"] = max(0.0, e["lo"])
    return e


def benjamini_hochberg(p: list[float], q: float = FDR) -> list[bool]:
    """Which hypotheses are rejected at false-discovery rate q."""
    m = len(p)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: p[i])
    k = 0
    for rank, i in enumerate(order, 1):
        if p[i] <= q * rank / m:
            k = rank
    keep = set(order[:k])
    return [i in keep for i in range(m)]


def reporting_rate(rep: np.ndarray, meas: np.ndarray) -> Optional[dict]:
    """Reports per household in need over checked cells: ratio estimator with a linearised 95% interval."""
    n = len(meas)
    if n < 2 or meas.sum() <= 0:
        return None
    r = float(rep.sum() / meas.sum())
    d = rep - r * meas
    se = math.sqrt(max(float(np.var(d, ddof=1)), 0.0) / n) / float(meas.mean())
    t = stats.t.ppf(0.975, n - 1)
    return {"rate": round(r, 4), "lo": round(max(0.0, r - t * se), 4), "hi": round(r + t * se, 4), "checks": n}


def compute(spec: dict) -> dict:
    cells: list[dict] = spec.get("cells") or []
    if len(cells) < MIN_CELLS:
        raise MaunSpecError(f"a run needs at least {MIN_CELLS} cells (got {len(cells)})")
    ids = [str(c["id"]) for c in cells]
    if len(set(ids)) != len(ids):
        raise MaunSpecError("cell ids must be unique")
    index = {cid: i for i, cid in enumerate(ids)}
    seed = int(spec.get("seed", 1))
    conf = float(spec.get("conf", 0.95))
    looks = max(1, int(spec.get("looks", 1)))
    version = int(spec.get("design_version", 1))
    conf_used = spent_confidence(conf, looks)

    score = design_score(cells, version)
    X = features(cells, version)
    hh = households(cells, version)
    _, pop_fallback = population(cells)
    cap = np.ceil(hh)                                         # every household of the cell in need: the honest maximum
    reported = np.asarray([float(c.get("reported") or 0.0) for c in cells])
    hazard = np.asarray([float(c.get("hazard") or 0.0) for c in cells])
    strata = build_strata(score)
    state = SampleState(strata, seed)
    trace: list[dict] = [{"step": "design", "cells": len(cells), "strata": int(state.H), "seed": seed, "design_version": version,
                          "stratum_sizes": state.N_h.tolist(),
                          "design_score": "mean percentile rank of exposed households and reports" if version >= 2 else "legacy proxy (v1)",
                          "population_fallback_cells": pop_fallback}]

    # replay the waves exactly
    waves = []
    taken: list[int] = []
    for k, w in enumerate(spec.get("waves") or []):
        alloc = np.asarray(w.get("alloc") or [], dtype=int)
        if alloc.shape != (state.H,):
            raise MaunSpecError(f"wave {k + 1}: allocation must have one entry per stratum ({state.H})")
        got = state.take(alloc)
        taken += got
        waves.append({"wave": k + 1, "alloc": alloc.tolist(), "cells": [ids[i] for i in got]})

    results: dict = spec.get("results") or {}
    taken_set = set(taken)
    refused = sorted(cid for cid in results if cid not in index or index[cid] not in taken_set)
    pending, unreachable = [], []
    for i in taken:
        r = results.get(ids[i])
        if r is None:
            pending.append(i)
        elif r.get("unreachable"):
            unreachable.append(i)
        else:
            v = float(r["households"])
            if not math.isfinite(v) or v < 0:
                raise MaunSpecError(f"cell {ids[i]}: households must be a number >= 0")
            state.record(i, v)

    def stratum_mean(h: int) -> Optional[float]:
        m = state.sampled & (strata == h)
        return float(state.y[m].mean()) if m.any() else None

    new_wave = None
    size = int(spec.get("new_wave") or 0)
    if size > 0:
        # allocation only: count pending and unreachable cells as visited (at their stratum's measured mean) so the
        # pilot and the Neyman shares account for checks already assigned. The estimate never uses these values.
        tmp = copy.deepcopy(state)
        for i in pending + unreachable:
            tmp.record(i, stratum_mean(int(strata[i])) or 0.0)
        weights = tmp.residual_sd(X) if tmp.n >= CROSSFIT_MIN_N else None
        alloc = tmp.allocate(size, weights)
        got = state.take(alloc)
        pending += got
        new_wave = {"wave": len(waves) + 1, "alloc": alloc.tolist(), "cells": [ids[i] for i in got]}
        waves.append(new_wave)
        trace.append({"step": "wave", "wave": new_wave["wave"], "alloc": new_wave["alloc"], "cells": len(got),
                      "weights": "residual SD" if weights is not None else "stratum SD (pilot or < 30 checks)"})

    done_mask = state.sampled.copy()
    for i in unreachable:
        done_mask[i] = True
    done_h = np.bincount(strata[done_mask], minlength=state.H)
    ready = bool((done_h >= np.minimum(MIN_DONE_PER_STRATUM, state.N_h)).all())
    R = float(reported.sum())

    overall, by_area = None, []
    if ready:
        e = _bounded(state, X, unreachable, cap, conf_used)
        e.update({"reported": R, "hidden": max(0.0, e["estimate"] - R), "hidden_lo": max(0.0, e["lo"] - R), "hidden_hi": max(0.0, e["hi"] - R)})
        overall = e
        trace.append({"step": "estimate", "look": looks, "confidence_used": round(conf_used, 5), "n": int(state.n),
                      "unreachable": len(unreachable), "method": e["method"], "estimate": round(e["estimate"], 2),
                      "lo": round(e["lo"], 2), "hi": round(e["hi"], 2)})
        areas = sorted({str(c.get("area")) for c in cells if c.get("area")})
        for a in areas:
            mask = np.asarray([str(c.get("area")) == a for c in cells])
            ea = _bounded(state, X, unreachable, cap, conf_used, mask)
            Ra = float(reported[mask].sum())
            ea.update({"area": a, "cells": int(mask.sum()), "reported": Ra, "hidden": max(0.0, ea["estimate"] - Ra),
                       "hidden_lo": max(0.0, ea["lo"] - Ra), "hidden_hi": max(0.0, ea["hi"] - Ra)})
            by_area.append(ea)

    status = {i: "pending" for i in pending}
    status.update({i: "unreachable" for i in unreachable})
    for i in np.flatnonzero(state.sampled):
        status[int(i)] = "checked"

    # per-cell need: measured where checked; elsewhere the proxy model once it exists, else the stratum's measured mean
    model = _cell_model(state, X)
    per_cell = []
    for i, c in enumerate(cells):
        if state.sampled[i]:
            est: Optional[float] = float(state.y[i])
        elif model is not None:
            est = max(0.0, float(model[0][i]))
        else:
            est = stratum_mean(int(strata[i]))
        per_cell.append({"id": ids[i], "stratum": int(strata[i]), "design_score": round(float(score[i]), 4), "status": status.get(i, "not_selected"),
                         "measured": float(state.y[i]) if state.sampled[i] else None,
                         "estimated_need": None if est is None else round(est, 2),
                         "hidden_need": None if est is None else round(max(0.0, est - reported[i]), 2),
                         "reported": reported[i], "hazard": hazard[i], "households": round(float(hh[i]), 1)})

    # strata summary and where the range is widest
    sd = state.stratum_sd(state.y)
    n_h = state.n_h()
    contrib = []
    for h in range(state.H):
        if n_h[h] >= 2:
            contrib.append(float(state.N_h[h] ** 2 * (1 - n_h[h] / state.N_h[h]) * sd[h] ** 2 / n_h[h]))
        else:
            contrib.append(float("inf"))
    checked = state.sampled
    strata_out = []
    for h in range(state.H):
        m = checked & (strata == h)
        strata_out.append({"stratum": h, "cells": int(state.N_h[h]), "checked": int(n_h[h]), "unreachable": int(sum(1 for i in unreachable if strata[i] == h)),
                           "pending": int(sum(1 for i in pending if strata[i] == h)), "mean_reported": round(float(reported[strata == h].mean()), 2),
                           "mean_measured": round(float(state.y[m].mean()), 2) if n_h[h] else None,
                           "reporting_rate": reporting_rate(reported[m], state.y[m]), "variance_share": None})
    finite = [c for c in contrib if math.isfinite(c)]
    tot = sum(finite)
    for h in range(state.H):
        strata_out[h]["variance_share"] = round(contrib[h] / tot, 3) if tot > 0 and math.isfinite(contrib[h]) else None
    widest = int(np.argmax([c if math.isfinite(c) else 1e300 for c in contrib]))
    unsampled = [i for i in np.flatnonzero(strata == widest) if not state.sampled[i] and i not in pending and i not in unreachable]
    obs_cells = [ids[i] for i in unreachable] + [ids[i] for i in sorted(unsampled, key=lambda i: -hh[i] * hazard[i])[:12]]
    observation = {"stratum": widest, "reason": "the range is widest here" if math.isfinite(contrib[widest]) else "too few checks in this stratum yet",
                   "cells": obs_cells[:20]}

    rate = reporting_rate(reported[checked], state.y[checked])
    silent = silent_zones(cells, ids, strata, reported, hh, hazard, status, state, model)
    return {
        "status": "estimating" if ready else "collecting",
        "message": None if ready else (f"Collecting: each stratum needs {MIN_DONE_PER_STRATUM} completed checks before an honest range exists "
                                       f"({int(np.maximum(np.minimum(MIN_DONE_PER_STRATUM, state.N_h) - done_h, 0).sum())} more)."),
        "confidence": conf, "confidence_used": conf_used, "looks": looks, "design_version": version,
        "overall": overall, "by_area": by_area, "strata": strata_out, "waves": waves, "new_wave": new_wave,
        "pending": [ids[i] for i in pending], "unreachable": [ids[i] for i in unreachable], "refused_results": refused,
        "checks_done": int(state.n), "min_checks": int(MIN_PER_STRATUM * state.H),
        "reporting_rate": rate, "population_fallback_cells": pop_fallback,
        "cells": per_cell, "silent_zones": silent, "observation_suggestion": observation, "trace": trace,
        "covers": "sampling error only (not counting mistakes in the field, nor errors in the population map)",
    }


def _cell_model(state: SampleState, X: np.ndarray) -> Optional[tuple[np.ndarray, np.ndarray]]:
    """Per-cell prediction from the cross-fitted proxy models and the residual spread of the cell's stratum."""
    cf = state.crossfit_models(X)
    if cf is None:
        return None
    models, oof, _ = cf
    pred = np.mean([m.predict(X) for m in models], axis=0)
    resid = np.where(state.sampled, state.y - oof, np.nan)
    sd_h = state.stratum_sd(resid)
    pooled = float(np.nanstd(resid[state.sampled], ddof=1)) if state.n > 2 else 0.0
    sd = np.where(sd_h[state.strata] > 0, sd_h[state.strata], pooled)
    return pred, sd


def _action(st: str, measured: Optional[float]) -> str:
    if st == "checked":
        return "Checked: act on the measured need" if (measured or 0) > 0 else "Checked: no need found"
    if st == "pending":
        return "A field check is already assigned: prioritise it"
    if st == "unreachable":
        return "Unreachable: request sharper observation and try another route"
    return "Send a volunteer team or call ward contacts; request sharper observation"


def silent_zones(cells, ids, strata, reported, hh, hazard, status, state, model) -> list[dict]:
    out: list[dict] = []

    def add(i: int, reason: str, gap: Optional[float], p: Optional[float], basis: str):
        st = status.get(i, "not_selected")
        out.append({"id": ids[i], "bbox": cells[i].get("bbox"), "hazard": round(float(hazard[i]), 3), "reported": int(reported[i]),
                    "estimated_gap": None if gap is None else round(float(gap), 1), "p_value": None if p is None else round(float(p), 4),
                    "basis": basis, "reason": reason, "status": st,
                    "action": _action(st, float(state.y[i]) if state.sampled[i] else None)})

    # 1. checked cells: unreported need observed directly
    for i in np.flatnonzero(state.sampled):
        gap = float(state.y[i] - reported[i])
        if gap >= 1:
            add(int(i), f"field check found {state.y[i]:.0f} households in need; {reported[i]:.0f} reported", gap, None, "observed")

    # 2. other cells: is need significantly above reports? (one-sided tests, Benjamini-Hochberg across cells)
    others = [i for i in range(len(cells)) if not state.sampled[i]]
    tests: list[tuple[int, float, float, str]] = []
    if model is not None:
        pred, sd = model
        for i in others:
            if sd[i] > 0:
                p = float(stats.norm.sf((pred[i] - reported[i]) / sd[i]))
                tests.append((i, p, float(pred[i] - reported[i]), "model"))
    else:
        for h in np.unique(strata):
            m = state.sampled & (strata == h)
            if m.sum() < 2:
                continue
            d = state.y[m] - reported[m]
            se = float(np.std(d, ddof=1)) / math.sqrt(m.sum())
            if se == 0:
                p = 0.0 if d.mean() > 0 else 1.0
            else:
                p = float(stats.t.sf(d.mean() / se, m.sum() - 1))
            for i in others:
                if strata[i] == h:
                    tests.append((i, p, float(d.mean()), "stratum"))
    keep = benjamini_hochberg([t[1] for t in tests])
    for (i, p, gap, basis), k in zip(tests, keep):
        if k:
            why = (f"model estimates about {gap:.0f} more households in need than reported" if basis == "model"
                   else f"checked cells like this one average {gap:.1f} more households in need than reports")
            add(i, why, gap, p, basis)

    # 3. reports stopped: Poisson test of zero reports in 24 h given the rate of the previous 48 h
    burst = []
    for i, c in enumerate(cells):
        earlier, recent = float(c.get("reported_earlier") or 0), float(c.get("reported_recent") or 0)
        if earlier > 0 and recent == 0:
            burst.append((i, math.exp(-earlier / 2.0), earlier))
    for (i, p, earlier), k in zip(burst, benjamini_hochberg([b[1] for b in burst])):
        if k and not any(z["id"] == ids[i] for z in out):
            add(i, f"{earlier:.0f} reports in the 48 h before, none in the last 24 h (reports stopped)", None, p, "reports_stopped")

    return sorted(out, key=lambda z: (z["estimated_gap"] is None, -(z["estimated_gap"] or 0), z["p_value"] or 0))
