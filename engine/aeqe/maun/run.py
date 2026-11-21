"""One Maun estimation run, recomputed deterministically from what was recorded.

The backend stores the run (cells with their proxies, the seed, the per-stratum allocation of every wave of field
checks, and the results entered so far). ``compute`` rebuilds the exact same sample from that record and returns the
estimate, so nothing has to live in engine memory and a restart changes nothing.

Design (unchanged AEQE components):
* strata: ``build_strata`` on predicted need (six strata, finer at the top);
* selection: each wave's allocation comes from ``SampleState.allocate`` (sequential Neyman, every stratum keeps a
  minimum share, a pilot of 3 per stratum first); cells are taken from each stratum's seeded random order, so a wave is
  a random sample within strata;
* estimate: ``SampleState.best`` (cross-fitted difference estimator from 30 checks on, stratified before that), at the
  confidence given by ``spent_confidence`` for the number of looks, so peeking after every wave keeps the coverage.

Two rules keep the sample honest:
* a selected cell that cannot be reached is never swapped for an easier one. It stays in the sample; the range is
  widened to cover both extremes (no need there, and every household in need) and the cell is flagged as a priority;
* checks in cells that were not selected are refused: adding them would break the random selection.

The range covers sampling error only; it does not cover counting mistakes in the field or a wrong population map.
"""

from __future__ import annotations

import copy
import math
from typing import Optional

import numpy as np

from ..engine import spent_confidence
from ..estimators import CROSSFIT_MIN_N, MIN_PER_STRATUM, SampleState, build_strata
from .model import BASE_NEED_RATE, EXPECTED_REPORTING_RATE, features, households, predicted_need

MIN_CELLS = 12
MIN_DONE_PER_STRATUM = 2       # a stratum's variance needs two checks; below this there is no honest range yet


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
    conf_used = spent_confidence(conf, looks)

    pred = predicted_need(cells)
    X = features(cells)
    hh = households(cells)
    cap = np.ceil(hh)                                         # every household of the cell in need: the honest maximum
    reported = np.asarray([float(c.get("reported") or 0.0) for c in cells])
    hazard = np.asarray([float(c.get("hazard") or 0.0) for c in cells])
    strata = build_strata(pred)
    state = SampleState(strata, seed)
    trace: list[dict] = [{"step": "design", "cells": len(cells), "strata": int(state.H), "seed": seed,
                          "stratum_sizes": state.N_h.tolist(), "proxy": "reported + households x 0.2 x hazard_score"}]

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

    new_wave = None
    size = int(spec.get("new_wave") or 0)
    if size > 0:
        # allocation only: treat pending and unreachable cells as visited with their predicted value so the pilot and
        # the Neyman shares account for checks already assigned. The estimate never uses these placeholders.
        tmp = copy.deepcopy(state)
        for i in pending + unreachable:
            tmp.record(i, float(pred[i]))
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

    # per-cell picture: measured where checked, model prediction elsewhere
    scores = state.scores(X, pred)
    per_cell = []
    status = {i: "pending" for i in pending}
    status.update({i: "unreachable" for i in unreachable})
    for i in np.flatnonzero(state.sampled):
        status[int(i)] = "checked"
    for i, c in enumerate(cells):
        est = float(state.y[i]) if state.sampled[i] else max(0.0, float(scores[i]))
        per_cell.append({"id": ids[i], "stratum": int(strata[i]), "predicted": round(float(pred[i]), 2), "status": status.get(i, "not_selected"),
                         "measured": float(state.y[i]) if state.sampled[i] else None, "estimated_need": round(est, 2),
                         "hidden_need": round(max(0.0, est - reported[i]), 2), "reported": reported[i], "hazard": hazard[i]})

    # strata summary and where the range is widest
    sd = state.stratum_sd(state.y)
    n_h = state.n_h()
    contrib = []
    for h in range(state.H):
        if n_h[h] >= 2:
            contrib.append(float(state.N_h[h] ** 2 * (1 - n_h[h] / state.N_h[h]) * sd[h] ** 2 / n_h[h]))
        else:
            contrib.append(float("inf"))
    strata_out = [{"stratum": h, "cells": int(state.N_h[h]), "checked": int(n_h[h]), "unreachable": int(sum(1 for i in unreachable if strata[i] == h)),
                   "pending": int(sum(1 for i in pending if strata[i] == h)), "mean_predicted": round(float(pred[strata == h].mean()), 2),
                   "mean_measured": round(float(np.nanmean(state.y[(strata == h) & state.sampled])), 2) if n_h[h] else None,
                   "variance_share": None} for h in range(state.H)]
    finite = [c for c in contrib if math.isfinite(c)]
    tot = sum(finite)
    for h in range(state.H):
        strata_out[h]["variance_share"] = round(contrib[h] / tot, 3) if tot > 0 and math.isfinite(contrib[h]) else None
    widest = int(np.argmax([c if math.isfinite(c) else 1e300 for c in contrib]))
    unsampled = [i for i in np.flatnonzero(strata == widest) if not state.sampled[i] and i not in pending and i not in unreachable]
    obs_cells = [ids[i] for i in unreachable] + [ids[i] for i in sorted(unsampled, key=lambda i: -hazard[i])[:12]]
    observation = {"stratum": widest, "reason": "the range is widest here" if math.isfinite(contrib[widest]) else "too few checks in this stratum yet",
                   "cells": obs_cells[:20]}

    silent = silent_zones(cells, hh, hazard, reported, status, state)
    return {
        "status": "estimating" if ready else "collecting",
        "message": None if ready else (f"Collecting: each stratum needs {MIN_DONE_PER_STRATUM} completed checks before an honest range exists "
                                       f"({int(np.maximum(np.minimum(MIN_DONE_PER_STRATUM, state.N_h) - done_h, 0).sum())} more)."),
        "confidence": conf, "confidence_used": conf_used, "looks": looks,
        "overall": overall, "by_area": by_area, "strata": strata_out, "waves": waves, "new_wave": new_wave,
        "pending": [ids[i] for i in pending], "unreachable": [ids[i] for i in unreachable], "refused_results": refused,
        "checks_done": int(state.n), "min_checks": int(MIN_PER_STRATUM * state.H),
        "cells": per_cell, "silent_zones": silent, "observation_suggestion": observation, "trace": trace,
        "covers": "sampling error only (not counting mistakes in the field, nor errors in the population map)",
    }


def silent_zones(cells, hh, hazard, reported, status, state) -> list[dict]:
    out = []
    for i, c in enumerate(cells):
        expected_reports = EXPECTED_REPORTING_RATE * hh[i] * BASE_NEED_RATE * hazard[i]
        recent, earlier = float(c.get("reported_recent") or 0), float(c.get("reported_earlier") or 0)
        reason = None
        if hazard[i] >= 0.5 and expected_reports >= 1 and reported[i] <= 0.25 * expected_reports:
            reason = f"high hazard ({hazard[i]:.2f}) but {int(reported[i])} report(s) where about {expected_reports:.0f} would be expected"
        elif earlier >= 3 and recent == 0:
            reason = f"{int(earlier)} reports earlier, none in the last 24 h (reports stopped after a burst)"
        if reason is None:
            continue
        st = status.get(i, "not_selected")
        if st == "checked":
            action = "Field check done: act on the measured need" if state.y[i] > 0 else "Field check found no need; keep watching"
        elif st == "pending":
            action = "A field check is already assigned: prioritise it"
        elif st == "unreachable":
            action = "Unreachable: request sharper observation and try another route"
        else:
            action = "Send a volunteer team or call ward contacts; request sharper observation"
        out.append({"id": c["id"], "bbox": c.get("bbox"), "hazard": round(float(hazard[i]), 3), "reported": int(reported[i]),
                    "expected_reports": round(float(expected_reports), 1), "reason": reason, "status": st, "action": action})
    return sorted(out, key=lambda z: -z["hazard"])
