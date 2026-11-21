"""Maun estimation, the hazard layer and the SIMULATED coverage experiment."""

from __future__ import annotations

import time
from datetime import date

import numpy as np
import pytest

from aeqe.hazard import combine, hazard_grid, make_grid
from aeqe.hazard.adapters import HazardAdapter, HazardCell
from aeqe.hazard.score import normalise
from aeqe.maun import MaunSpecError, compute
from aeqe.maun.oracle import FieldCheckOracle, PendingCheck
from aeqe.providers.base import TileUniverse
from maun_sim import coverage, simulate_run, world


def _spec(seed=3, **kw):
    w = world(seed, areas=False)
    return w, {"cells": w.cells, "seed": seed, "conf": 0.95, "waves": [], "results": {}, "looks": 1, **kw}


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


def test_silent_zones_flag_high_hazard_with_few_reports():
    cells = [{"id": f"c{i}", "hazard": 0.9 if i < 3 else 0.1, "population": 4500, "reported": 0} for i in range(20)]
    cells[19] |= {"reported_earlier": 5, "reported_recent": 0}
    out = compute({"cells": cells, "seed": 1})
    ids = {z["id"] for z in out["silent_zones"]}
    assert {"c0", "c1", "c2", "c19"} <= ids and "c5" not in ids


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


# ---------------------------------------------------------------------------- hazard layer

class _Fake(HazardAdapter):
    def __init__(self, id, values=None, area=False, fail=None, delay=0.0, ok=True):
        self.id, self.name, self.unit, self.area_level = id, id, "u", area
        self.values, self.fail, self.delay, self.ok = values or {}, fail, delay, ok

    def configured(self):
        return (self.ok, "key missing" if not self.ok else "ok")

    def fetch(self, cells, bbox, start: date, end: date):
        time.sleep(self.delay)
        if self.fail:
            raise self.fail
        return [HazardCell(c.id, self.id, "2026-11-20T10:00:00+00:00", 3600.0, self.values.get(c.id, 0.0), self.unit) for c in cells]


def test_grid_ids_and_limits():
    g = make_grid((90.0, 26.0, 90.1, 26.05), 0.05)
    assert [c.id for c in g] == ["c000_000", "c000_001"]
    with pytest.raises(ValueError):
        make_grid((0, 0, 10, 10), 0.01)


def test_score_is_weighted_max_of_available_layers():
    assert normalise("firms", 6) == 1.0 and normalise("glofas", 2.0) == 0.5 and normalise("imerg", None) is None
    layers = {"firms": {"a": HazardCell("a", "firms", None, None, 3.0, "")}, "rain_forecast": {"a": HazardCell("a", "rain_forecast", None, None, 150, "")}}
    assert combine(layers, ["a", "b"]) == {"a": 1.0, "b": 0.0}


def test_hazard_grid_reports_each_source_state():
    bbox = (90.0, 26.0, 90.1, 26.1)
    ads = [_Fake("firms", {"c000_000": 6.0}), _Fake("imerg", ok=False), _Fake("glofas", fail=RuntimeError("boom api_key=SECRET123")),
           _Fake("modis_flood", delay=2.0)]
    g = hazard_grid(bbox, 0.05, 3, adapters=ads, timeout_s=0.5, use_cache=False)
    st = {s["id"]: s for s in g["sources"]}
    assert st["firms"]["state"] == "ok" and st["firms"]["observed_at"] and st["firms"]["age_s"] > 0
    assert st["imerg"]["state"] == "not_configured"
    assert st["glofas"]["state"] == "error" and "SECRET123" not in st["glofas"]["note"]
    assert st["modis_flood"]["state"] == "timeout"
    cell = next(c for c in g["cells"] if c["cell_id"] == "c000_000")
    assert cell["hazard_score"] == 1.0 and "firms" in cell["layers"]
    assert "weighted" in g["score_doc"] or "weight" in g["score_doc"]
