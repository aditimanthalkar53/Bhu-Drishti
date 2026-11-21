"""Maun estimation, its grid and the SIMULATED coverage experiment."""

from __future__ import annotations


import numpy as np
import pytest

from aeqe.maun import MaunSpecError, compute
from aeqe.maun.grid import make_grid
from aeqe.maun.oracle import FieldCheckOracle, PendingCheck
from aeqe.providers.base import TileUniverse
from maun_sim import coverage, simulate_run, world


def _spec(seed=3, **kw):
    w = world(seed, areas=False)
    return w, {"cells": w.cells, "seed": seed, "conf": 0.95, "waves": [], "results": {}, "looks": 1, "design_version": 2, **kw}


def _fill(w, spec, out, value=None):
    idx = {c["id"]: i for i, c in enumerate(w.cells)}
    spec["waves"].append({"alloc": out["new_wave"]["alloc"]})
    for cid in out["new_wave"]["cells"]:
        spec["results"][cid] = {"households": float(w.truth[idx[cid]] if value is None else value)}


def test_first_wave_is_a_pilot_random_within_strata():
    w, spec = _spec()
    out = compute({**spec, "new_wave": 30})
    strata = {c["id"]: c["stratum"] for c in out["cells"]}
    per = np.bincount([strata[c] for c in out["new_wave"]["cells"]], minlength=len(out["strata"]))
    assert (per == 3).all(), "the pilot takes 3 cells from every stratum"
    other = compute({**spec, "seed": 4, "new_wave": 30})
    assert set(other["new_wave"]["cells"]) != set(out["new_wave"]["cells"]), "a different seed draws different cells"
    assert out["status"] == "collecting" and out["overall"] is None


def test_replay_is_deterministic_and_estimate_appears_after_the_pilot():
    w, spec = _spec()
    out = compute({**spec, "new_wave": 30})
    _fill(w, spec, out)
    a, b = compute(spec), compute(spec)
    assert a["overall"] == b["overall"] and a["pending"] == []
    assert a["status"] == "estimating"
    o = a["overall"]
    assert o["lo"] <= o["estimate"] <= o["hi"]
    assert o["reported"] == pytest.approx(w.reported_total)
    assert o["hidden"] == pytest.approx(max(0.0, o["estimate"] - o["reported"]))


def test_unreachable_cell_stays_in_the_sample_and_widens_the_range():
    w, spec = _spec()
    out = compute({**spec, "new_wave": 30})
    _fill(w, spec, out)
    base = compute(spec)["overall"]
    victim = out["new_wave"]["cells"][-1]
    spec["results"][victim] = {"unreachable": True}
    res = compute(spec)
    assert victim in res["unreachable"] and victim not in res["pending"]
    assert res["checks_done"] == base["n"] - 1, "never replaced by another cell"
    o = res["overall"]
    assert o["bounded_by_unreachable"]
    assert o["hi"] - o["lo"] >= base["hi"] - base["lo"] - 1e-6
    assert victim in res["observation_suggestion"]["cells"], "unreachable cells are the first to observe"
    # the next wave does not include the unreachable cell again, and nothing was swapped in for it
    nxt = compute({**spec, "new_wave": 10})
    assert victim not in nxt["new_wave"]["cells"]


def test_results_for_cells_that_were_not_selected_are_refused():
    w, spec = _spec()
    out = compute({**spec, "new_wave": 30})
    _fill(w, spec, out)
    chosen = set(out["new_wave"]["cells"])
    outsider = next(c["id"] for c in w.cells if c["id"] not in chosen)
    spec["results"][outsider] = {"households": 999}
    res = compute(spec)
    assert outsider in res["refused_results"]
    assert res["overall"] == compute({**spec, "results": {k: v for k, v in spec["results"].items() if k != outsider}})["overall"]


def test_bad_specs_are_rejected():
    with pytest.raises(MaunSpecError):
        compute({"cells": [{"id": "a"}] * 3})
    w, spec = _spec()
    with pytest.raises(MaunSpecError):
        compute({**spec, "waves": [{"alloc": [1, 2]}]})


def test_silent_zones_come_from_data_not_thresholds():
    # before any check nothing is flagged on hazard alone, however high it is
    cells = [{"id": f"c{i}", "hazard": 0.95 if i < 20 else 0.05, "population": 4900 * (1 + i % 5), "reported": 0} for i in range(60)]
    cells[59] |= {"reported_earlier": 8, "reported_recent": 0}       # P(0 in 24 h | 4 expected) = e^-4: significant
    cells[58] |= {"reported_earlier": 2, "reported_recent": 0}       # P = e^-1 = 0.37: not significant
    out = compute({"cells": cells, "seed": 1, "design_version": 2})
    ids = {z["id"] for z in out["silent_zones"]}
    assert ids == {"c59"}, ids
    assert out["silent_zones"][0]["basis"] == "reports_stopped"
    # after checks: where checked cells show need well above reports, the unchecked cells of that stratum are flagged
    spec = {"cells": cells, "seed": 1, "design_version": 2, "waves": [], "results": {}, "looks": 1}
    o = compute({**spec, "new_wave": 18})
    spec["waves"].append({"alloc": o["new_wave"]["alloc"]})
    idx = {c["id"]: i for i, c in enumerate(cells)}
    for cid in o["new_wave"]["cells"]:
        spec["results"][cid] = {"households": 30 + (idx[cid] % 3) if idx[cid] < 20 else 0}
    res = compute(spec)
    flagged = {z["id"]: z for z in res["silent_zones"]}
    observed = [cid for cid in o["new_wave"]["cells"] if idx[cid] < 20]
    assert observed and all(flagged[cid]["basis"] == "observed" for cid in observed)
    assert any(z["basis"] == "stratum" for z in flagged.values()), "unchecked look-alikes are flagged by a test"
    assert all(idx[cid] < 20 or z["basis"] == "reports_stopped" for cid, z in flagged.items()), "no flags where checks found nothing"
    assert res["reporting_rate"]["rate"] == 0.0


def test_reporting_rate_is_learned_from_checks():
    from aeqe.maun import reporting_rate
    r = reporting_rate(np.array([3.0, 5, 2, 4]), np.array([10.0, 20, 10, 10]))
    assert r["rate"] == pytest.approx(14 / 50) and r["lo"] <= r["rate"] <= r["hi"]
    assert reporting_rate(np.array([1.0]), np.array([2.0])) is None


def test_benjamini_hochberg():
    from aeqe.maun import benjamini_hochberg
    assert benjamini_hochberg([0.001, 0.2, 0.03, 0.04], q=0.1) == [True, False, True, True]
    assert benjamini_hochberg([0.5, 0.6]) == [False, False]


def test_legacy_runs_replay_unchanged():
    """Runs stored before design version 2 must rebuild the same strata (their stored allocations depend on it)."""
    w, spec = _spec()
    legacy = {**spec, "design_version": 1}
    a = compute({**legacy, "new_wave": 30})
    b = compute({**legacy, "new_wave": 30})
    assert a["new_wave"] == b["new_wave"]
    assert a["trace"][0]["design_score"] == "legacy proxy (v1)"


def test_field_check_oracle_only_reads_recorded_results():
    u = TileUniverse("r", ["a", "b"], np.zeros((2, 4)), np.ones(2), np.ones(2), np.zeros((2, 1)), ["x"], np.zeros(2), "")
    o = FieldCheckOracle({"a": {"households": 4}})
    assert o.run(u, 0, None).value == 4
    with pytest.raises(PendingCheck):
        o.run(u, 1, None)


def test_coverage_of_the_95_percent_range_simulated():
    """SIMULATED ground truth: the range should contain the true total in about 95% of runs or more (alpha spending
    and the conservative standard error make it err on the wide side). Covers sampling error only."""
    c = coverage(60, start_seed=100)
    assert c["coverage"] >= 0.9, c["coverage"]
    assert c["mean_reported"] < c["mean_true"], "reports under-count need in the simulation"


def test_one_simulated_run_converges():
    r = simulate_run(7)
    h = r["history"]
    assert h[-1]["hi"] - h[-1]["lo"] < h[0]["hi"] - h[0]["lo"]


# ---------------------------------------------------------------------------- grid

def test_grid_ids_and_limits():
    g = make_grid((90.0, 26.0, 90.1, 26.05), 0.05)
    assert [c.id for c in g] == ["c000_000", "c000_001"]
    with pytest.raises(ValueError):
        make_grid((0, 0, 10, 10), 0.01)
