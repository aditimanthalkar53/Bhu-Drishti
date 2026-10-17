"""Engine tests: estimators, compiler, cache, end-to-end runs, replay, find-all certificate."""

from __future__ import annotations

import time

import numpy as np
import pytest

from aeqe.cache import ResultCache
from aeqe.compiler import CompileError, RuleCompiler, compile_question
from aeqe.engine import Engine, EngineConfig
from aeqe.estimators import FrontierAudit, SampleState, build_strata, cp_lower, cp_upper
from aeqe.ir import Target, Task
from aeqe.providers import planetary as P
from aeqe.providers.simulated import SimulatedProvider

REGION = "lower-brahmaputra-a"


@pytest.fixture(scope="module")
def engine(tmp_path_factory):
    return Engine(SimulatedProvider(oracle_latency_s=0.0), ResultCache(), tmp_path_factory.mktemp("aeqe"),
                  EngineConfig(workers=4))


def run(engine, question, **overrides):
    cr = compile_question(question, region_id=overrides.pop("region", REGION), overrides=overrides)
    job = engine.submit(cr)
    t0 = time.time()
    while job.status in ("queued", "running"):
        assert time.time() - t0 < 120, "job timed out"
        time.sleep(0.01)
    assert job.error is None, job.error
    return job


# ---------------------------------------------------------------- compiler
@pytest.mark.parametrize("q,task,target", [
    ("What percentage of cropland was flooded during 1-15 July 2023?", Task.AREA_FRACTION, Target.FLOODED_CROPLAND),
    ("How many km² of cropland were flooded in August 2022?", Task.TOTAL, Target.FLOODED_CROPLAND),
    ("How much new built-up area appeared between 2020 and 2024?", Task.TOTAL, Target.NEW_BUILTUP),
    ("How many brick kilns are there in 2024?", Task.COUNT, Target.BRICK_KILN),
    ("Find all brick kilns in 2024 with recall 85%", Task.FIND_ALL, Target.BRICK_KILN),
    ("Is there flooding near 26.42, 91.05 in July 2022?", Task.INSPECT, Target.FLOODED_CROPLAND),
])
def test_rule_compiler(q, task, target):
    ir = RuleCompiler().compile(q, region_id=REGION).ir
    assert ir.task == task and ir.target == target


def test_compiler_precision_and_window():
    cr = RuleCompiler().compile("What percentage of cropland was flooded during 1-5 July 2023, within 2 pp?", region_id=REGION)
    assert cr.ir.precision == 2.0
    assert (cr.ir.end - cr.ir.start).days >= 11  # widened so a Sentinel-1 pass falls inside
    assert any("widened" in a for a in cr.assumptions)


def test_compiler_rejects_unknown_target():
    with pytest.raises(CompileError):
        RuleCompiler().compile("How many penguins are there?", region_id=REGION)


# ---------------------------------------------------------------- estimators
def test_stratified_census_is_exact():
    rng = np.random.default_rng(0)
    y = rng.gamma(0.5, 2.0, size=300)
    st = SampleState(build_strata(y + rng.normal(0, 0.5, 300)), seed=1)
    while True:
        idx = st.take(st.allocate(50))
        if not idx:
            break
        for i in idx:
            st.record(i, y[i])
    e = st.stratified(0.95)
    assert e.estimate == pytest.approx(y.sum())
    assert e.hi - e.lo == pytest.approx(0.0, abs=1e-9)


def test_clopper_pearson_bounds():
    assert cp_upper(0, 100, 0.05) == pytest.approx(1 - 0.05 ** (1 / 100), rel=1e-6)
    assert cp_lower(0, 100, 0.05) == 0.0
    assert 0 < cp_lower(10, 100, 0.05) < 0.1 < cp_upper(10, 100, 0.05) < 1


def test_frontier_audit_census_bound_is_one():
    score = np.linspace(1, 0, 200)
    y = (np.arange(200) < 20).astype(float)
    fa = FrontierAudit(score, seed=0)
    while True:
        idx, _ = fa.plan(24, 0.05, 0.9)
        if not idx:
            break
        for i in idx:
            fa.record(i, y[i])
        fa.finish_batch()
    assert fa.confirmed().sum() == 20
    assert fa.bound(0.05)[0] == 1.0


# ---------------------------------------------------------------- end to end
def test_area_fraction_covers_exhaustive(engine):
    job = run(engine, "What percentage of cropland was flooded during 1-15 July 2023?", seed=3)
    r = job.result
    assert r["stop_reason"] == "precision_met"
    assert r["n"] < r["population"] / 4          # far fewer oracle calls than exhaustive
    ex = engine.exhaustive(job)
    assert ex["inside_interval"]
    assert r["estimate"]["halfwidth"] <= 3.0


def test_count_and_total_tasks(engine):
    for q in ("How many brick kilns are there in 2024?", "How much new built-up area appeared between 2020 and 2024?"):
        job = run(engine, q, seed=5)
        assert job.result["estimate"]["lo"] <= job.result["estimate"]["value"] <= job.result["estimate"]["hi"]
        assert job.trace["batches"], "trace must record every batch"


def test_find_all_certificate(engine):
    job = run(engine, "Find all brick kilns in 2024 with recall 90%", seed=2)
    r = job.result
    assert r["stop_reason"] in ("recall_certified", "census")
    ex = engine.exhaustive(job)
    assert ex["achieved_recall"] >= 0.9
    assert r["estimate"]["selected_precision_estimate"] == 1.0  # every returned tile is oracle-confirmed


def test_inspect_is_exact(engine):
    job = run(engine, "Is there flooding near 26.42, 91.05 in July 2022?")
    assert job.result["stop_reason"] == "census"
    assert job.result["estimate"]["tiles"] > 0


def test_validation_blocks_bad_dates(engine):
    cr = compile_question("What percentage of cropland was flooded during 1-15 July 2012?", region_id=REGION)
    plan = engine.plan(cr.ir)
    assert not plan["ok"]
    assert any(c["name"] == "Dates within archive" and not c["ok"] for c in plan["checks"])


def test_cache_reuse_and_replay(engine):
    q = "What percentage of cropland was flooded during 1-15 August 2022?"
    first = run(engine, q, seed=11)
    assert first.result["oracle_calls"] > 0
    second = run(engine, q, seed=11)            # same question → all oracle results from cache
    assert second.result["oracle_calls"] == 0 and second.result["cache_hits"] == second.result["n"]
    rp = engine.replay(first)
    while rp.status in ("queued", "running"):
        time.sleep(0.01)
    v = Engine.verify_replay(first, rp)
    assert v["identical"], v


def test_new_scene_invalidates_cache(engine):
    # a different window (new Sentinel-1 acquisitions) must not reuse old results
    a = run(engine, "What percentage of cropland was flooded during 1-15 July 2022?", seed=1)
    b = run(engine, "What percentage of cropland was flooded during 13-27 July 2022?", seed=1)
    assert a.trace["scene_key"] != b.trace["scene_key"]
    assert b.result["oracle_calls"] > 0


def test_universe_and_evidence_geojson(engine):
    job = run(engine, "How many brick kilns are there in 2024?", seed=9)
    uni = engine.universe_geojson(job)
    ev = engine.evidence_geojson(job)
    assert len(uni["features"]) == job.result["population"]
    assert len(ev["features"]) == job.result["n"]


# ---------------------------------------------------------------- real-data helpers (offline)
def test_grid_and_otsu():
    ids, boxes = P.grid_tiles((90.8, 26.2, 91.0, 26.3))
    assert len(ids) == 20 * 10 and len(set(ids)) == len(ids)
    rng = np.random.default_rng(0)
    vv = np.concatenate([10 ** (rng.normal(-9, 1.5, 5000) / 10), 10 ** (rng.normal(-22, 1.5, 2000) / 10)])
    mask, thr, method = P.water_mask_from_vv(vv)
    assert method == "otsu" and -20 < thr < -14
    assert abs(mask.mean() - 2000 / 7000) < 0.02


def test_fraction_per_tile():
    boxes = np.array([[0, 0, 1, 1], [1, 0, 2, 1]], dtype=float)
    xs = np.array([0.25, 0.75, 1.25, 1.75])
    ys = np.array([0.75, 0.25])
    arr = np.array([[1, 1, 0, 0], [1, 1, 0, 1]], dtype=float)
    np.testing.assert_allclose(P.fraction_per_tile(arr, xs, ys, boxes), [1.0, 0.25])
