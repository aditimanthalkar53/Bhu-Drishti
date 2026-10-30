"""Offline tests for the live-data layer: adapters (mocked HTTP), pure raster logic, compiler, census, advisory.

Nothing here touches the network; ``scripts/smoke_sources.py`` and ``scripts/live_e2e.py`` are the live checks.
"""

from __future__ import annotations

import time
from datetime import date

import httpx
import numpy as np
import pytest

from aeqe.advisory import advisory_for, season, severity
from aeqe.compiler import RuleCompiler, parse_dates
from aeqe.engine import Engine, EngineConfig, spent_confidence, summarize_inputs
from aeqe.cache import ResultCache
from aeqe.compiler import CompileResult
from aeqe.ir import QueryIR, Target, Task
from aeqe.providers import live as L
from aeqe.providers.base import Check, Oracle, OracleOutput, Provider, Region, TileUniverse
from aeqe.providers.composite import CompositeProvider
from aeqe.providers.simulated import SimulatedProvider
from aeqe.sources import base as B
from aeqe.sources.copernicus import CopernicusSource, estimate_pu
from aeqe.sources.earthdata import area_mean, imerg_indices, mcdwd_summary, mcdwd_tile_bounds
from aeqe.sources.firms import norm_confidence, parse_csv
from aeqe.sources.ttlcache import TTLCache

TODAY = date(2026, 10, 17)


# ---------------------------------------------------------------- compiler (live regions)
@pytest.mark.parametrize("q,task,target", [
    ("How many fire detections were there in the last 10 days?", Task.COUNT, Target.ACTIVE_FIRE),
    ("Identify areas with recent fire detections and prioritize them for review", Task.FIND_ALL, Target.ACTIVE_FIRE),
    ("Where were stubble burning hotspots this week?", Task.FIND_ALL, Target.ACTIVE_FIRE),
    ("How much cropland was burned between 15 October 2025 and 15 November 2025?", Task.TOTAL, Target.BURNED_CROPLAND),
    ("What percentage of cropland was burned in the last 30 days?", Task.AREA_FRACTION, Target.BURNED_CROPLAND),
    ("What percentage of cropland was flooded in the last 14 days?", Task.AREA_FRACTION, Target.FLOODED_CROPLAND),
])
def test_compiler_live_targets(q, task, target):
    ir = RuleCompiler().compile(q, region_id="in-x", live=True, today=TODAY).ir
    assert (ir.task, ir.target) == (task, target)
    assert ir.end <= TODAY


def test_relative_and_cross_month_dates():
    assert parse_dates("last 10 days", TODAY)[:2] == (date(2026, 10, 8), TODAY)
    assert parse_dates("past 2 weeks", TODAY)[:2] == (date(2026, 10, 4), TODAY)
    assert parse_dates("last month", TODAY)[:2] == (date(2026, 9, 1), date(2026, 9, 30))
    assert parse_dates("since 1 Oct", TODAY)[:2] == (date(2026, 10, 1), TODAY)
    assert parse_dates("between 15 October 2025 and 15 November 2025", TODAY)[:2] == (date(2025, 10, 15), date(2025, 11, 15))
    assert parse_dates("1 Oct to 15 Nov 2025", TODAY)[:2] == (date(2025, 10, 1), date(2025, 11, 15))


def test_live_defaults_are_recent_and_never_future():
    cr = RuleCompiler().compile("Is cropland flooded?", region_id="in-x", live=True, today=TODAY)
    assert cr.ir.end == TODAY and (TODAY - cr.ir.start).days == 13
    cr = RuleCompiler().compile("fires", region_id="in-x", live=True, today=TODAY)
    assert cr.ir.target == Target.ACTIVE_FIRE and (cr.ir.end - cr.ir.start).days == 9
    cr = RuleCompiler().compile("flooded cropland 10-20 October 2026", region_id="in-x", live=True, today=TODAY)
    assert cr.ir.end <= TODAY and (cr.ir.end - cr.ir.start).days >= 12
    # "last 30 minutes" is a window, not a time budget
    cr = RuleCompiler().compile("fires in the last 5 days within 120 s", region_id="in-x", live=True, today=TODAY)
    assert cr.ir.budget_seconds == 120
    # simulated regions keep their fixed archive defaults
    sim = RuleCompiler().compile("Is cropland flooded?", region_id="lower-brahmaputra-a")
    assert sim.ir.start.year <= 2025


# ---------------------------------------------------------------- shared plumbing
def test_redact_removes_secrets(monkeypatch):
    monkeypatch.setenv("NASA_FIRMS_MAP_KEY", "abcdef0123456789abcdef0123456789")
    s = B.redact("GET /api/area/csv/abcdef0123456789abcdef0123456789/VIIRS?x=1 Authorization: Bearer eyJhbGciOi.xyz.abc "
                 "https://x.blob.core.windows.net/a.tif?st=1&se=2026&sig=SECRETSIG client_secret=hunter2hunter2")
    assert "abcdef0123456789" not in s and "SECRETSIG" not in s and "eyJhbGciOi" not in s and "hunter2" not in s


def test_http_retries_transient_and_not_permanent():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(503 if calls["n"] < 3 else 200, json={"ok": True})

    c = httpx.Client(transport=httpx.MockTransport(handler))
    r = B.http_request("t", "GET", "https://x/y", client=c, backoff=0.0)
    assert r.status_code == 200 and calls["n"] == 3

    calls["n"] = 0
    c2 = httpx.Client(transport=httpx.MockTransport(lambda req: (calls.__setitem__("n", calls["n"] + 1), httpx.Response(403, text="forbidden"))[1]))
    with pytest.raises(B.SourceError) as e:
        B.http_request("t", "GET", "https://x/y", client=c2, backoff=0.0)
    assert e.value.kind == "forbidden" and calls["n"] == 1
    assert B.classify_status(403, "Processing units quota exceeded") == "quota"
    assert B.classify_status(429) == "rate_limited" and B.classify_status(401) == "auth"


def test_ttlcache_expiry(tmp_path):
    c = TTLCache(tmp_path / "c.sqlite")
    c.put("a", {"v": 1}, ttl_s=0.05)
    assert c.get("a") == {"v": 1}
    time.sleep(0.08)
    assert c.get("a") is None


def test_status_ladder_never_overclaims():
    s = B.Source()
    s.mark(B.Status.RETRIEVAL_VERIFIED, "x")
    s.mark(B.Status.AUTHENTICATED, "y")      # lower rung does not downgrade
    assert s._status == B.Status.RETRIEVAL_VERIFIED
    s.mark(B.Status.BLOCKED, "denied")        # but a block always wins
    assert s._status == B.Status.BLOCKED and not s.usable


# ---------------------------------------------------------------- Copernicus
def test_cdse_token_is_cached_and_quota_guarded(monkeypatch):
    monkeypatch.setenv("CDSE_CLIENT_ID", "id")
    monkeypatch.setenv("CDSE_CLIENT_SECRET", "secret-value-123")
    monkeypatch.setenv("CDSE_PU_BUDGET", "1")
    n = {"tok": 0}

    def fake(source, method, url, **kw):
        n["tok"] += 1
        return httpx.Response(200, json={"access_token": f"t{n['tok']}", "expires_in": 1800})

    monkeypatch.setattr("aeqe.sources.copernicus.http_request", fake)
    c = CopernicusSource()
    assert c.token() == c.token() == "t1" and n["tok"] == 1
    assert c.token(force=True) == "t2"
    with pytest.raises(B.SourceError) as e:
        c._charge(2.0)
    assert e.value.kind == "quota"
    assert estimate_pu(512, 512) == pytest.approx(1 / 3) and estimate_pu(10, 10) == 0.005


# ---------------------------------------------------------------- FIRMS
def test_firms_csv_parsing_and_confidence():
    viirs = ("latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n"
             "30.1,75.9,330.2,0.4,0.4,2026-10-13,824,N,VIIRS,n,2.0NRT,290.1,5.5,D\n"
             "30.2,75.8,350.0,0.4,0.4,2026-10-14,2010,N,VIIRS,h,2.0NRT,295.0,12.0,N\n")
    rows = parse_csv(viirs, "VIIRS_SNPP_NRT")
    assert len(rows) == 2 and rows[0]["acq_time_utc"] == "08:24" and rows[1]["confidence"] == "high"
    assert norm_confidence("85", "MODIS_NRT") == "high" and norm_confidence("20", "MODIS_NRT") == "low"
    assert parse_csv("", "VIIRS_SNPP_NRT") == []
    with pytest.raises(B.SourceError):
        parse_csv("Invalid MAP_KEY.", "VIIRS_SNPP_NRT")


def test_points_binned_to_tiles():
    bbox = (75.0, 30.0, 75.03, 30.02)
    ids, boxes = L.grid_tiles(bbox, 0.01)
    dets = [{"lon": 75.005, "lat": 30.015}, {"lon": 75.006, "lat": 30.016}, {"lon": 75.025, "lat": 30.005}]
    counts, per = L._bin_points(dets, boxes, 0.01, bbox)
    assert counts.sum() == 3 and counts.max() == 2
    sm = L._smooth_counts(counts, ids, 0.01)
    assert sm.max() > 0 and len(sm) == len(ids)


# ---------------------------------------------------------------- Earthdata parsers
def test_imerg_grid_indices_and_mean():
    i0, i1, j0, j1 = imerg_indices((90.8, 26.2, 91.4, 26.65))
    assert (i0, i1) == (2708, 2713) and (j0, j1) == (1162, 1166)
    a = np.array([[1.0, 3.0], [np.nan, -9999.9]])
    assert area_mean(a) == pytest.approx(2.0)
    assert area_mean(np.full((2, 2), np.nan)) is None


def test_mcdwd_tile_summary():
    assert mcdwd_tile_bounds(27, 6) == (90, 20, 100, 30)
    arr = np.ones((100, 100), dtype=np.uint8)
    arr[:10, :10] = 3      # NW corner flooded
    arr[90:, :] = 0        # southern strip cloud
    s = mcdwd_summary(arr, (90, 20, 100, 30), (90, 29, 91, 30))   # NW 1°×1° box = rows 0–9, cols 0–9
    assert s["flood_share_of_observed"] == 1.0 and s["insufficient_data_share"] == 0.0
    s2 = mcdwd_summary(arr, (90, 20, 100, 30), (90, 20, 100, 30))
    assert s2["insufficient_data_share"] == pytest.approx(0.1)


# ---------------------------------------------------------------- raster logic
def test_flood_change_mask_excludes_reference_water_slopes_and_non_crop():
    event = np.full((4, 4), -10.0)
    ref = np.full((4, 4), -10.0)
    event[:, :2] = -22.0          # dark (water) on the left half
    ref[:, 0] = -22.0             # column 0 was already water in the dry season
    wc = np.full((4, 4), L.WORLDCOVER_CROPLAND)
    wc[3, :] = 10                 # bottom row is tree cover
    slope = np.zeros((4, 4))
    slope[0, 1] = 12.0            # steep pixel
    inside = np.ones((4, 4), bool)
    flooded, crop_obs, crop = L.flood_change_mask(event, ref, wc, slope, inside, -18.0)
    # only column 1, rows 1–2 (row 0 steep, row 3 not cropland)
    assert flooded.sum() == 2 and flooded[1, 1] and flooded[2, 1] and not flooded[:, 0].any()
    assert crop.sum() == 12


def test_builtup_needs_persistence_and_burn_mask():
    t, h, w = 3, 2, 2
    b03 = np.full((t, h, w), 0.08); b04 = np.full((t, h, w), 0.12); b08 = np.full((t, h, w), 0.18); b11 = np.full((t, h, w), 0.25)
    b08[1, 0, 0] = 0.45           # pixel (0,0) greens up once → cropland, not built
    m = L.builtup_from_stack(b03, b04, b08, b11)
    assert m[0, 0] == 0 and m[1, 1] == 1
    pre = np.array([[0.5, 0.5], [0.1, 0.5]]); post = np.array([[0.0, 0.45], [0.0, np.nan]])
    crop = np.ones((2, 2), bool)
    burned, obs = L.burn_mask(pre, post, crop)
    assert burned.tolist() == [[True, False], [False, False]] and obs.sum() == 3


def test_tile_size_scales_with_region_and_threshold_fallback():
    assert L.choose_tile_deg((90.8, 26.2, 91.4, 26.65)) == 0.01
    assert L.choose_tile_deg((68.0, 22.0, 72.0, 25.0)) >= 0.025
    thr, how = L.regional_threshold(np.full(1000, -12.0))
    assert thr == -18.0 and "fixed" in how
    assert L.dry_reference_window(date(2024, 7, 1)) == (date(2024, 2, 1), date(2024, 4, 30))
    assert L.dry_reference_window(date(2024, 1, 10)) == (date(2023, 2, 1), date(2023, 4, 30))


# ---------------------------------------------------------------- engine pieces
def test_alpha_spending_sums_to_alpha():
    alphas = [1 - spent_confidence(0.95, k) for k in range(1, 20000)]
    assert sum(alphas) < 0.05 and spent_confidence(0.95, 1) > 0.95


def test_inputs_summary_groups_provenance():
    s = summarize_inputs([
        {"source": "planetary_computer", "product": "sentinel-1-rtc", "acquired_start": "2024-07-04", "acquired_end": "2024-07-04"},
        {"source": "planetary_computer", "product": "sentinel-1-rtc", "acquired_start": "2024-07-11", "acquired_end": "2024-07-11"},
        {"source": "firms", "product": "VIIRS_SNPP_NRT", "acquired_start": "2026-10-08", "acquired_end": "2026-10-12"},
    ])
    s1 = next(x for x in s if x["product"] == "sentinel-1-rtc")
    assert s1["items"] == 2 and s1["first"] == "2024-07-04" and s1["last"] == "2024-07-11"


def test_advisory_never_attributes_and_scales_with_severity():
    ir = QueryIR(task=Task.AREA_FRACTION, target=Target.FLOODED_CROPLAND, region_id="x", start=date(2024, 7, 1), end=date(2024, 7, 15))
    a = advisory_for(ir, {"estimate": {"value": 25.0}}, Region("x", "Barpeta", (0, 0, 1, 1), {}, False, state="Assam"))
    assert a["severity"] == "severe" and any("PMFBY" in i["reference"] for i in a["items"]) and any("Sub1" in i["detail"] for i in a["items"])
    f = advisory_for(QueryIR(task=Task.COUNT, target=Target.ACTIVE_FIRE, region_id="x", start=date(2026, 10, 8), end=date(2026, 10, 17)),
                     {"estimate": {"value": 3}}, Region("x", "Sangrur", (0, 0, 1, 1), {}, False, state="Punjab"))
    assert any("does not identify who" in i["detail"] for i in f["items"])
    assert season(date(2024, 7, 1)) == "kharif" and severity(3) == "low"


class _CensusProvider(Provider):
    name = "fake-live"

    def regions(self):
        return [Region("r", "R", (0, 0, 1, 1), {}, False, kind="district")]

    def check_inputs(self, ir):
        return [Check("ok", True, "")]

    def choose_sensor(self, ir):
        return "viirs", "test"

    def universe(self, ir):
        ids, boxes = L.grid_tiles((0, 0, 0.03, 0.01), 0.01)
        vals = np.array([0.0, 2.0, 5.0])
        return TileUniverse("r", ids, boxes, np.ones(3), np.ones(3), vals[:, None], ["d"], vals, "test",
                            {"census_values": vals, "tile_deg": 0.01})

    def oracle(self, ir, sensor):
        return L.FirmsCountOracle()

    def scene_key(self, ir, sensor):
        return "k"

    def census_values(self, ir, u):
        v = u.extra["census_values"]
        return v, [{"detections": int(x)} for x in v], {"detections": int(v.sum()), "by_confidence": {"high": 7}, "on_cropland": 6,
                                                        "tiles_with_detections": 2, "newest_detection": None}


def test_census_path_is_exact_and_ranked(tmp_path):
    eng = Engine(_CensusProvider(), ResultCache(), tmp_path, EngineConfig(workers=2, evidence_wait_s=2))
    ir = QueryIR(task=Task.FIND_ALL, target=Target.ACTIVE_FIRE, region_id="r", start=date(2026, 10, 8), end=date(2026, 10, 17),
                 precision=90)
    job = eng.submit(CompileResult(ir, "test"))
    t0 = time.time()
    while job.status in ("queued", "running"):
        assert time.time() - t0 < 20
        time.sleep(0.02)
    r = job.result
    assert job.error is None and r["stop_reason"] == "census"
    assert r["estimate"]["value"] == 7 and r["estimate"]["lo"] == r["estimate"]["hi"] == 7
    assert [t["detections"] for t in r["priority_tiles"]] == [5, 2]
    assert r["data_mode"] == "live" and r["advisory"]["topic"] == "fire"


def test_composite_routes_by_region():
    sim = SimulatedProvider(0.0)

    class _Live(_CensusProvider):
        def regions(self):
            return [Region("in-x", "X", (0, 0, 1, 1), {}, False, kind="district")]

    comp = CompositeProvider(sim, _Live())
    sim_id = sim.regions()[0].id
    assert comp.region(sim_id).simulated and not comp.region("in-x").simulated
    ir = QueryIR(task=Task.COUNT, target=Target.ACTIVE_FIRE, region_id=sim_id, start=date(2024, 1, 1), end=date(2024, 1, 5))
    checks = comp.check_inputs(ir)
    assert any(not c.ok and c.blocking for c in checks), "the simulator refuses fire questions instead of inventing data"
    assert comp.is_live(ir.model_copy(update={"region_id": "in-x"}))


def test_s2_reflectance_offset_and_char_test():
    xr = pytest.importorskip("xarray")     # live-data extra (requirements-real.txt)
    da = xr.DataArray(np.array([[[1500.0]], [[2500.0]], [[0.0]]]), dims=("time", "y", "x"),
                      coords={"time": np.array(["2021-06-01", "2023-06-01", "2023-07-01"], dtype="datetime64[ns]")})
    r = L.s2_reflectance(da)
    assert r[0, 0, 0] == pytest.approx(0.15) and r[1, 0, 0] == pytest.approx(0.15) and np.isnan(r[2, 0, 0])
    pre = np.array([[0.5, 0.5]]); post = np.array([[0.0, 0.0]]); crop = np.ones((1, 2), bool)
    b08 = np.array([[0.08, 0.28]]); b12 = np.array([[0.07, 0.30]])     # ash vs harvested straw
    burned, _ = L.burn_mask(pre, post, crop, b08, b12)
    assert burned.tolist() == [[True, False]]


class _FlakyOracle(Oracle):
    name, model_version, sensor, unit, description = "flaky", "1", "s", "km²", "fails on odd tiles"

    def run(self, u, idx, ir):
        if idx % 2:
            raise RuntimeError("Chunk and warp failed")
        return OracleOutput(1.0, {})


class _FlakyProvider(_CensusProvider):
    def oracle(self, ir, sensor):
        return _FlakyOracle()

    def universe(self, ir):
        ids, boxes = L.grid_tiles((0, 0, 0.2, 0.1), 0.01)
        n = len(ids)
        x = np.linspace(0, 1, n)
        return TileUniverse("r", ids, boxes, np.ones(n), np.ones(n), x[:, None], ["x"], x, "test", {})


def test_failing_tiles_do_not_kill_the_run_and_flag_insufficient_evidence(tmp_path):
    eng = Engine(_FlakyProvider(), ResultCache(), tmp_path, EngineConfig(workers=2, evidence_wait_s=1))
    ir = QueryIR(task=Task.TOTAL, target=Target.NEW_BUILTUP, region_id="r", start=date(2025, 1, 1), end=date(2025, 12, 31),
                 baseline_start=date(2020, 1, 1), baseline_end=date(2020, 12, 31), precision=5, budget_tiles=80)
    job = eng.submit(CompileResult(ir, "test"))
    t0 = time.time()
    while job.status in ("queued", "running"):
        assert time.time() - t0 < 60
        time.sleep(0.02)
    assert job.error is None
    assert job.result["missing_data_tiles"] > 0
    assert job.result["stop_reason"] == "insufficient_evidence" and job.result["answer"].startswith("Insufficient evidence")


def test_library_logs_are_redacted(caplog):
    import logging
    import aeqe.sources.planetary  # noqa: F401 — installs the record factory
    with caplog.at_level(logging.WARNING):
        logging.getLogger("odc.loader._builder").warning("Failed to load https://x.blob.core.windows.net/a.tif?st=1&sig=SECRETSIG%3D")
    assert "SECRETSIG" not in caplog.text and "sig=<redacted>" in caplog.text

# ---------------------------------------------------------------- question scope
from aeqe.compiler import OutOfScopeError, compile_question
from aeqe.scope import classify


@pytest.mark.parametrize("q,target", [
    ("Are fields under water in the last week?", Target.FLOODED_CROPLAND),
    ("waterlogging situation now", Target.FLOODED_CROPLAND),
    ("parali burning this week", Target.ACTIVE_FIRE),
    ("crop fires today", Target.ACTIVE_FIRE),
    ("how many new houses came up between 2020 and 2025", Target.NEW_BUILTUP),
    ("encroachment growth since 2020", Target.NEW_BUILTUP),
])
def test_more_ways_to_ask(q, target):
    assert compile_question(q, region_id="in-x", live=True, today=TODAY).ir.target == target


@pytest.mark.parametrize("q,category,topic", [
    ("hello", "help", None),
    ("what can you do?", "help", None),
    ("What is the AQI in Delhi today?", "related", "air quality / pollution"),
    ("Will it rain tomorrow?", "related", "weather, rainfall or forecasts"),
    ("How much forest cover was lost?", "related", "forest / tree cover change"),
    ("Who won the cricket match?", "off_topic", None),
    ("Give me a recipe for biryani", "off_topic", None),
])
def test_out_of_scope_questions_get_a_clear_reply(q, category, topic):
    with pytest.raises(OutOfScopeError) as e:
        compile_question(q, region_id="in-x", live=True, today=TODAY)
    r = e.value.reply.to_json()
    assert r["kind"] == "out_of_scope" and r["category"] == category and r["topic"] == topic
    assert r["message"] and r["suggestions"]


def test_unanswerable_phrasing_falls_back_and_says_so():
    cr = compile_question("Is there flooding near 26.42, 91.05 this week?", region_id="in-x", live=True, today=TODAY)
    assert cr.ir.task == Task.AREA_FRACTION and any("single point" in a for a in cr.assumptions)
    cr = compile_question("Show me all burned fields in the last 30 days", region_id="in-x", live=True, today=TODAY)
    assert cr.ir.target == Target.BURNED_CROPLAND and cr.ir.task == Task.TOTAL
    assert classify("flooded cropland in barpeta") is not None  # classify alone is only used after target detection fails

def test_finished_jobs_survive_an_engine_restart(tmp_path):
    """Answers and evidence maps are served from disk after the engine process restarts."""
    import time as _t
    from aeqe.compiler import compile_question
    from aeqe.providers.simulated import SimulatedProvider

    prov = SimulatedProvider(oracle_latency_s=0.0)
    eng = Engine(prov, ResultCache(), tmp_path, EngineConfig(workers=2))
    job = eng.submit(compile_question("What percentage of cropland was flooded during 1-15 July 2023?",
                                      region_id="lower-brahmaputra-a"))
    t0 = _t.time()
    while job.status in ("queued", "running"):
        assert _t.time() - t0 < 120
        _t.sleep(0.02)
    assert job.status == "done", job.error
    for _ in range(50):                         # archiving happens right after the status flips
        if (tmp_path / "jobs" / f"{job.id}.json").exists():
            break
        _t.sleep(0.02)
    fresh = Engine(prov, ResultCache(), tmp_path, EngineConfig(workers=2))   # a "restarted" engine
    a = fresh.archived(job.id)
    assert a is not None and a["summary"]["status"] == "done"
    assert a["summary"]["result"]["estimate"]["value"] == job.result["estimate"]["value"]
    assert a["evidence"]["type"] == "FeatureCollection" and a["evidence"]["features"]
    assert fresh.archived("../etc") is None


def test_every_module_compiles():
    """server.py is not imported by the tests (it builds live providers on import); at least make sure it parses."""
    import py_compile
    from pathlib import Path
    for f in Path(__file__).resolve().parents[1].joinpath("aeqe").rglob("*.py"):
        py_compile.compile(str(f), doraise=True)


def test_spending_runs_stop_at_the_first_look_that_meets_the_precision(tmp_path):
    """Anytime-valid intervals hold at every look, so no extra 'confirmation' batch is spent."""
    import time as _t
    from aeqe.compiler import compile_question
    from aeqe.providers.simulated import SimulatedProvider

    eng = Engine(SimulatedProvider(oracle_latency_s=0.0), ResultCache(), tmp_path, EngineConfig(workers=4))
    assert eng.config.sequential == "spending"
    job = eng.submit(compile_question("What percentage of cropland was flooded during 1-15 July 2023?",
                                      region_id="lower-brahmaputra-a"))
    t0 = _t.time()
    while job.status in ("queued", "running"):
        assert _t.time() - t0 < 120
        _t.sleep(0.02)
    assert job.result["stop_reason"] == "precision_met"
    batches = job.trace["batches"]
    precision = job.ir.precision
    met = [b["estimate"]["halfwidth"] <= precision and b["estimate"]["interval_method"].startswith("anytime") for b in batches]
    assert met[-1] and not any(met[:-1]), "stopped later than the first qualifying look"


def test_dry_season_reference_is_computed_once_and_reused(tmp_path):
    """The reference composite does not depend on the question's dates: read it once, then from disk."""
    import numpy as np
    import xarray as xr
    from aeqe.providers.live import LiveProvider

    calls = []

    class FakePC:
        def load(self, items, bands, bbox, res):
            calls.append([i.id for i in items])
            return {"vv": xr.DataArray(np.full((len(items), 4, 4), 0.01), dims=("time", "y", "x"))}

    class Item:
        def __init__(self, i):
            self.id = i

    p = LiveProvider(tmp_path)
    p.pc = FakePC()
    bbox = (91.0, 26.4, 91.01, 26.41)
    a = p.reference_db([Item("s1a"), Item("s1b")], bbox, 0.0001)
    b = p.reference_db([Item("s1b"), Item("s1a")], bbox, 0.0001)   # same passes, other order → cached
    assert len(calls) == 1 and np.allclose(a, b) and np.allclose(a, -20.0)
    p.reference_db([Item("s1a"), Item("s1b"), Item("s1c")], bbox, 0.0001)   # a new pass → recomputed
    assert len(calls) == 2
