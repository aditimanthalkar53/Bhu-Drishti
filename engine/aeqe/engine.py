"""The anytime query runtime: plan → stratify → sample → estimate → stop."""

from __future__ import annotations

import json
import math
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import numpy as np

from .advisory import advisory_for
from .cache import ResultCache
from .compiler import CompileResult
from .estimators import Estimate, FrontierAudit, SampleState, build_strata
from .ir import CENSUS_TARGETS, CROPLAND_TARGETS, TASK_TARGETS, QueryIR, Target, Task
from .providers.base import Check, Oracle, Provider, TileUniverse

ENGINE_VERSION = "aeqe-0.3.0"

# A tile counts as "containing the target" for find-all when the oracle output
# reaches this value (oracle units). Small change/flood fragments are noise.
POSITIVE_THRESHOLD = {
    Target.BRICK_KILN: 1.0,          # ≥ 1 detected kiln
    Target.NEW_BUILTUP: 0.02,        # ≥ 2 ha of new built-up area
    Target.FLOODED_CROPLAND: 0.05,   # ≥ 5 ha of flooded cropland
    Target.ACTIVE_FIRE: 1.0,         # ≥ 1 detection
    Target.BURNED_CROPLAND: 0.05,    # ≥ 5 ha of burn scar
}

TARGET_WORDS = {
    Target.FLOODED_CROPLAND: ("flooded", "cropland"),
    Target.BURNED_CROPLAND: ("burned", "cropland"),
}


def spent_confidence(conf: float, look: int) -> float:
    """Per-look confidence so that the error over *all* looks is at most 1 − conf.

    Alpha spending α_k = α · 6 / (π² k²) sums to α over k = 1, 2, …, so the
    interval reported at whichever look the run stops on (precision met,
    budget, or the user pressing stop) keeps its nominal coverage despite the
    repeated peeking. Union bound: conservative, needs no assumptions.
    """
    alpha = 1.0 - conf
    return 1.0 - alpha * 6.0 / (math.pi ** 2 * max(look, 1) ** 2)


@dataclass
class EngineConfig:
    batch_size: int = 24
    workers: int = 8
    min_n_to_stop: int = 60
    stable_batches_to_stop: int = 2   # precision must hold for this many consecutive batches
    max_inspect_tiles: int = 80
    # "spending": anytime-valid intervals under repeated looks (default);
    # "fixed": nominal fixed-sample interval at every look (faster, validated only by simulation)
    sequential: str = "spending"
    evidence_wait_s: float = 90.0


@dataclass
class Job:
    id: str
    ir: QueryIR
    compile_info: dict
    status: str = "queued"           # queued | running | done | stopped | failed
    events: list[dict] = field(default_factory=list)
    result: Optional[dict] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    stop_requested: bool = False
    replay_of: Optional[str] = None
    replay_n: Optional[int] = None
    universe: Optional[TileUniverse] = None
    strata: Optional[np.ndarray] = None
    state: Optional[SampleState] = None
    trace: dict = field(default_factory=dict)
    evidence: Optional[list] = None
    live: bool = False
    replay_batch_sizes: Optional[list] = None
    _cond: threading.Condition = field(default_factory=threading.Condition)

    def emit(self, event: dict) -> None:
        with self._cond:
            event["seq"] = len(self.events)
            event["t"] = round(time.time() - self.created_at, 3)
            self.events.append(event)
            self._cond.notify_all()

    def wait_events(self, since: int, timeout: float = 1.0) -> list[dict]:
        with self._cond:
            if len(self.events) <= since and self.status in ("queued", "running"):
                self._cond.wait(timeout)
            return self.events[since:]

    def summary(self) -> dict:
        last = next((e for e in reversed(self.events) if e["type"] in ("progress", "result")), None)
        return {
            "id": self.id,
            "status": self.status,
            "ir": json.loads(self.ir.model_dump_json()),
            "compile": self.compile_info,
            "created_at": self.created_at,
            "latest": last,
            "result": self.result,
            "error": self.error,
            "replay_of": self.replay_of,
            "data_mode": "live" if self.live else "simulated",
        }


def summarize_inputs(inputs: list[dict]) -> list[dict]:
    """Group provenance records by (source, product): item count and acquisition span."""
    groups: dict[tuple, dict] = {}
    for p in inputs:
        if "source" not in p:
            continue
        g = groups.setdefault((p["source"], p.get("product")), {"source": p["source"], "product": p.get("product"),
                                                                  "items": 0, "first": None, "last": None})
        g["items"] += 1
        for k, pick in (("acquired_start", "first"), ("acquired_end", "last")):
            v = p.get(k)
            if v and v != "None":
                cur = g[pick]
                g[pick] = v if cur is None else (min(cur, v) if pick == "first" else max(cur, v))
    return list(groups.values())


def units_for(ir: QueryIR) -> dict:
    if ir.task == Task.AREA_FRACTION:
        return {"value": "% of cropland", "short": "%"}
    if ir.task == Task.TOTAL:
        return {"value": "km²", "short": "km²"}
    if ir.task == Task.COUNT:
        if ir.target == Target.ACTIVE_FIRE:
            return {"value": "fire detections", "short": "detections"}
        return {"value": "kilns", "short": "kilns"}
    if ir.task == Task.FIND_ALL:
        return {"value": "tiles with target", "short": "tiles"}
    return {"value": "per-tile answers", "short": ""}


class Engine:
    def __init__(self, provider: Provider, cache: ResultCache, store_dir: str | Path, config: Optional[EngineConfig] = None):
        self.provider = provider
        self.cache = cache
        self.store = Path(store_dir)
        (self.store / "traces").mkdir(parents=True, exist_ok=True)
        self.config = config or EngineConfig()
        self.jobs: dict[str, Job] = {}
        self._pool = ThreadPoolExecutor(max_workers=self.config.workers, thread_name_prefix="oracle")

    # ------------------------------------------------------------------ planning
    def validate(self, ir: QueryIR) -> list[Check]:
        checks = [
            Check(
                "Task supports target",
                ir.target in TASK_TARGETS[ir.task],
                f"{ir.task.value} × {ir.target.value}",
            )
        ]
        checks += self.provider.check_inputs(ir)
        if ir.task == Task.INSPECT and ir.point is not None:
            r = self.provider.region(ir.region_id)
            if r:
                minx, miny, maxx, maxy = r.bbox
                inside = minx <= ir.point.lon <= maxx and miny <= ir.point.lat <= maxy
                checks.append(Check("Point inside region", inside, f"({ir.point.lat:.4f}, {ir.point.lon:.4f})"))
        return checks

    def plan(self, ir: QueryIR, quick: bool = False) -> dict:
        """Validate and describe the run. ``quick`` skips building the tile universe (it can take
        minutes for a new live district); the full steps then arrive in the job's ``plan`` event."""
        checks = self.validate(ir)
        ok = all(c.ok or not c.blocking for c in checks)
        sensor, reason = self.provider.choose_sensor(ir)
        steps: list[dict] = []
        pending = False
        if ok and not quick:
            u = self.provider.universe(ir)
            oracle = self.provider.oracle(ir, sensor)
            steps = self._plan_steps(ir, u, oracle, sensor, reason)
        elif ok:
            pending = True
            steps = [{"op": "prepare", "detail": "tile the region and compute cheap proxy scores for every tile (live data: "
                                               "the first run in a district can take a few minutes; later runs reuse it)"}]
        return {"ok": ok, "checks": [c.to_json() for c in checks], "sensor": sensor, "sensor_reason": reason,
                "steps": steps, "steps_pending": pending}

    def _plan_steps(self, ir: QueryIR, u: TileUniverse, oracle: Oracle, sensor: str, reason: str) -> list[dict]:
        pop = {
            Target.FLOODED_CROPLAND: "tiles containing cropland (land-cover mask)",
            Target.BURNED_CROPLAND: "tiles containing cropland (land-cover mask)",
            Target.NEW_BUILTUP: "all tiles in the region",
            Target.BRICK_KILN: "all tiles in the region",
            Target.ACTIVE_FIRE: "all tiles in the region",
        }[ir.target]
        td = u.extra.get("tile_deg")
        size = f"{td:g}° (~{(td * 111) ** 2:.1f} km²)" if td else "~1 km²"
        steps = [
            {"op": "discretise", "detail": f"{u.n:,} tiles of {size} — population: {pop}"},
            {"op": "proxy", "detail": f"cheap score for every tile: {u.proxy_description}"},
            {"op": "select_oracle", "detail": f"{oracle.name} ({oracle.model_version}) on {sensor}: {reason}"},
        ]
        if ir.target in CENSUS_TARGETS:
            steps.append({"op": "census", "detail": "the detection catalogue covers every tile → exact count per tile, no sampling or interval"})
            return steps
        if ir.task == Task.INSPECT:
            steps.append({"op": "exact", "detail": "small area → run the oracle on every tile within the radius (no sampling)"})
            return steps
        if ir.task == Task.FIND_ALL:
            steps += [
                {"op": "rank", "detail": "order all tiles by the proxy score (fixed before any labels)"},
                {"op": "verify_frontier", "detail": f"run the oracle top-down in batches of {self.config.batch_size}; every reported tile is oracle-confirmed"},
                {"op": "audit", "detail": "uniform random audit of the unverified remainder; each batch goes to frontier or audit, whichever raises the recall bound more"},
                {"op": "stop", "detail": f"exact Clopper–Pearson certificate: recall ≥ {ir.precision:g}% at {ir.confidence:.0%} confidence, or {ir.budget_seconds:g} s / {ir.budget_tiles} oracle tiles"},
            ]
            return steps
        prec = {
            Task.AREA_FRACTION: f"±{ir.precision:g} percentage points",
            Task.TOTAL: f"±{ir.precision:g}% of the estimate",
            Task.COUNT: f"±{ir.precision:g}% of the estimate",
        }[ir.task]
        steps += [
            {"op": "stratify", "detail": "6 strata by proxy-score quantiles (finer at the top); 3 pilot tiles per stratum"},
            {"op": "sample", "detail": f"batches of {self.config.batch_size} tiles, sequential Neyman allocation, {self.config.workers} parallel oracle workers, cache-first"},
            {"op": "estimate", "detail": "stratified expansion estimator → cross-fitted difference estimator once ≥30 labels (ridge proxy on cheap features)"},
            {"op": "stop", "detail": f"target {prec} at {ir.confidence:.0%} confidence, or {ir.budget_seconds:g} s / {ir.budget_tiles} oracle tiles, or user stop"
             + ("; intervals use alpha spending so they stay valid however often the run is checked" if self.config.sequential == "spending" else "")},
        ]
        return steps

    # ------------------------------------------------------------------ jobs
    def submit(self, compile_result: CompileResult, *, replay_of: Optional[str] = None, replay_n: Optional[int] = None,
               replay_batch_sizes: Optional[list] = None) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], ir=compile_result.ir, compile_info=compile_result.to_json(),
                  replay_of=replay_of, replay_n=replay_n, replay_batch_sizes=replay_batch_sizes)
        self.jobs[job.id] = job
        threading.Thread(target=self._run_safe, args=(job,), daemon=True, name=f"job-{job.id}").start()
        return job

    def stop(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        job.stop_requested = True
        return True

    def _run_safe(self, job: Job) -> None:
        try:
            self._run(job)
        except Exception as e:  # noqa: BLE001
            job.status = "failed"
            job.error = f"{type(e).__name__}: {e}"
            job.emit({"type": "error", "message": job.error})

    # ------------------------------------------------------------------ oracle calls
    def _call_oracle(self, oracle: Oracle, u: TileUniverse, idx: int, ir: QueryIR, scene_key: str,
                     use_cache: bool = True, write_cache: bool = True, simulate_latency: bool = True) -> dict:
        tile_id = u.tile_ids[idx]
        key, ph = ResultCache.make_key(tile_id, scene_key, oracle.name, oracle.model_version, oracle.params_key(ir))
        if use_cache:
            hit = self.cache.get(key)
            if hit is not None:
                return {"idx": idx, "value": hit.value, "detail": hit.detail, "cache": True, "latency_s": 0.0,
                        "saved_s": hit.latency_s}
        t0 = time.perf_counter()
        lat = self.provider.oracle_latency(ir)
        if simulate_latency and lat:
            # jitter makes the simulation look like real model calls (deterministic per tile)
            time.sleep(lat * (0.75 + 0.5 * ((hash(tile_id) % 1000) / 1000)))
        try:
            out = oracle.run(u, idx, ir)
        except Exception as e1:  # noqa: BLE001 — one retry, then the tile is recorded as unobserved
            try:
                out = oracle.run(u, idx, ir)
            except Exception as e2:  # noqa: BLE001
                msg = f"{type(e2).__name__}: {e2}"[:300] or str(e1)[:300]
                return {"idx": idx, "value": 0.0, "detail": {"no_data": True, "reason": "data read failed", "error": msg},
                        "cache": False, "latency_s": time.perf_counter() - t0, "saved_s": 0.0}
        dt = time.perf_counter() - t0
        if write_cache:
            self.cache.put(key, tile_id=tile_id, scene_key=scene_key, oracle=oracle.name,
                           model_version=oracle.model_version, params_hash=ph, value=out.value,
                           detail=out.detail, latency_s=dt)
        return {"idx": idx, "value": float(out.value), "detail": out.detail, "cache": False, "latency_s": dt, "saved_s": 0.0}

    # ------------------------------------------------------------------ main loop
    def _run(self, job: Job) -> None:
        ir, cfg = job.ir, self.config
        job.status = "running"
        t_start = time.perf_counter()

        checks = self.validate(ir)
        blocking = [c for c in checks if c.blocking and not c.ok]
        sensor, reason = self.provider.choose_sensor(ir)
        if blocking:
            job.status = "failed"
            job.error = "; ".join(f"{c.name}: {c.detail}" for c in blocking)
            job.emit({"type": "plan", "ok": False, "checks": [c.to_json() for c in checks]})
            job.emit({"type": "error", "message": job.error})
            return

        job.live = self.provider.is_live(ir)
        job.emit({"type": "status", "stage": "preparing",
                  "message": "Tiling the region and computing proxy scores from live data…" if job.live else "Preparing tiles…"})
        u = self.provider.universe(ir)
        oracle = self.provider.oracle(ir, sensor)
        scene_key = self.provider.scene_key(ir, sensor)
        job.universe = u
        units = units_for(ir)
        pname = self.provider.provider_name(ir) if hasattr(self.provider, "provider_name") else self.provider.name
        try:
            inputs = self.provider.inputs_provenance(ir)
        except Exception as e:  # noqa: BLE001 — provenance must never fail a run
            inputs = [{"error": f"provenance unavailable: {type(e).__name__}"}]
        if job.replay_of is None:
            threading.Thread(target=self._collect_evidence, args=(job, u), daemon=True, name=f"evidence-{job.id}").start()
        job.trace = {
            "engine": ENGINE_VERSION,
            "job_id": job.id,
            "replay_of": job.replay_of,
            "provider": pname,
            "data_mode": "live" if job.live else "simulated",
            "inputs": inputs,
            "ir": json.loads(ir.model_dump_json()),
            "compile": job.compile_info,
            "checks": [c.to_json() for c in checks],
            "sensor": sensor,
            "sensor_reason": reason,
            "oracle": oracle.to_json(),
            "scene_key": scene_key,
            "seed": ir.seed,
            "config": cfg.__dict__,
            "population": {"tiles": u.n, "base_km2": float(u.base_km2.sum()), "features": u.feature_names,
                           "proxy": u.proxy_description},
            "batches": [],
        }
        job.emit({"type": "plan", "ok": True, "checks": [c.to_json() for c in checks], "sensor": sensor,
                  "sensor_reason": reason, "oracle": oracle.to_json(), "scene_key": scene_key,
                  "steps": self._plan_steps(ir, u, oracle, sensor, reason), "population": u.n, "units": units})

        if ir.task == Task.INSPECT:
            self._run_inspect(job, u, oracle, scene_key, t_start)
            return
        if ir.target in CENSUS_TARGETS:
            self._run_census(job, u, oracle, scene_key, sensor, units, t_start)
            return
        if ir.task == Task.FIND_ALL:
            self._run_find_all(job, u, oracle, scene_key, sensor, units, t_start)
            return

        strata = build_strata(u.score0)
        state = SampleState(strata, seed=ir.seed)
        job.strata, job.state = strata, state
        job.trace["strata"] = {"H": state.H, "N_h": state.N_h.tolist()}
        X = u.features
        D = float(u.base_km2.sum())
        consecutive_ok = 0
        stop_reason = "exhausted"
        calls = cache_hits = 0
        saved_s = 0.0
        batch_no = 0
        looks = 0
        est: Optional[Estimate] = None
        display: dict = {}

        while True:
            if job.stop_requested:
                stop_reason = "user_stop"
                break
            elapsed = time.perf_counter() - t_start
            if job.replay_n is None:
                if elapsed >= ir.budget_seconds:
                    stop_reason = "time_budget"
                    break
                if state.n >= ir.budget_tiles:
                    stop_reason = "tile_budget"
                    break
            elif state.n >= job.replay_n:
                stop_reason = "replay_complete"
                break

            requested = self._batch_for_time(job, ir, t_start)
            alloc = state.allocate(requested, state.residual_sd(X))
            if job.replay_n is not None:
                over = state.n + int(alloc.sum()) - job.replay_n
                if over > 0:  # trim to reproduce the recorded sample size exactly
                    for h in np.argsort(-alloc):
                        cut = min(over, alloc[h])
                        alloc[h] -= cut
                        over -= cut
                        if over <= 0:
                            break
            elif state.n + int(alloc.sum()) > ir.budget_tiles:
                over = state.n + int(alloc.sum()) - ir.budget_tiles
                for h in np.argsort(-alloc):
                    cut = min(over, alloc[h])
                    alloc[h] -= cut
                    over -= cut
                    if over <= 0:
                        break
            idxs = state.take(alloc)
            if not idxs:
                stop_reason = "census"
                break
            results = list(self._pool.map(lambda i: self._call_oracle(oracle, u, i, ir, scene_key), idxs))
            batch_tiles = []
            for r in results:  # record in deterministic (allocation) order
                state.record(r["idx"], r["value"])
                calls += 0 if r["cache"] else 1
                cache_hits += 1 if r["cache"] else 0
                saved_s += r["saved_s"]
                batch_tiles.append({
                    "tile_id": u.tile_ids[r["idx"]], "idx": r["idx"], "stratum": int(strata[r["idx"]]),
                    "value": round(r["value"], 6), "cache": r["cache"], "latency_s": round(r["latency_s"], 4),
                    "detail": r["detail"],
                })
            batch_no += 1

            eligible = state.n >= cfg.min_n_to_stop
            looks += 1 if eligible else 0
            conf_k = spent_confidence(ir.confidence, looks) if (cfg.sequential == "spending" and eligible) else ir.confidence
            est = state.best(X, conf_k)
            display = self._display(ir, est, D)
            display["interval_confidence"] = round(conf_k, 6)
            display["interval_method"] = ("anytime-valid (alpha spending, look %d)" % looks if cfg.sequential == "spending" and eligible
                                          else "provisional (before the first stopping look)" if cfg.sequential == "spending"
                                          else "fixed-sample")
            met = eligible and self._precision_met(ir, display)
            consecutive_ok = consecutive_ok + 1 if met else 0

            elapsed = time.perf_counter() - t_start
            ev = {
                "type": "progress", "batch": batch_no, "n": state.n, "population": u.n,
                "oracle_calls": calls, "cache_hits": cache_hits, "elapsed_s": round(elapsed, 3),
                "estimate": display, "allocation": alloc.tolist(), "tiles": batch_tiles,
            }
            job.emit(ev)
            job.trace["batches"].append({
                "batch": batch_no, "allocation": alloc.tolist(), "requested": int(requested),
                "tiles": [{k: t[k] for k in ("tile_id", "stratum", "value", "cache")} for t in batch_tiles],
                "estimate": display, "elapsed_s": round(elapsed, 3),
            })
            if job.replay_n is None and consecutive_ok >= cfg.stable_batches_to_stop:
                stop_reason = "precision_met"
                break

        elapsed = time.perf_counter() - t_start
        if est is None:
            est = state.best(X, ir.confidence)
            display = self._display(ir, est, D)
        result = self._result_common(job, u, state.n, calls, cache_hits, saved_s, elapsed, sensor, oracle,
                                     scene_key, units, stop_reason, display)
        if stop_reason == "census":
            result["caveats"].insert(0, "Every tile in the population was analysed (census), so there is no sampling error; "
                                        "model and data errors still apply.")
        no_data = sum(1 for e in job.events if e["type"] == "progress" for t in e["tiles"] if t["detail"].get("no_data"))
        if no_data:
            result["missing_data_tiles"] = no_data
            result["caveats"].append(f"{no_data} sampled tile(s) had no usable imagery and were counted as 0 — the estimate "
                                     "is a lower bound for those areas.")
            if no_data > 0.3 * max(state.n, 1):
                stop_reason = "insufficient_evidence"
                result["stop_reason"] = stop_reason
                result["answer"] = (f"Insufficient evidence: {no_data} of {state.n} sampled tiles had no usable imagery "
                                    "(cloud, missing scenes or read failures), so no reliable estimate can be given. "
                                    "Widen the date window or try again later. Partial figure: " + result["answer"])
        self._finish(job, result, [u.tile_ids[i] for i in state.order], stop_reason)

    def _batch_for_time(self, job: Job, ir: QueryIR, t_start: float) -> int:
        """Shrink the batch when the time budget is nearly used, so a batch of slow live reads cannot overrun it by much."""
        cfg = self.config
        k = len(job.trace.get("batches", []))
        if job.replay_n is not None:
            sizes = job.replay_batch_sizes or []
            return sizes[k] if k < len(sizes) else cfg.batch_size
        lats = self._latencies(job)
        if len(lats) < cfg.workers:
            return cfg.batch_size
        remaining = ir.budget_seconds - (time.perf_counter() - t_start)
        per_wave = float(np.percentile(lats, 75))           # one wave = `workers` tiles in parallel
        waves = max(1, int(remaining // max(per_wave, 1e-6)))
        return int(max(cfg.workers, min(cfg.batch_size, waves * cfg.workers)))

    def _finish(self, job: Job, result: dict, sample_order: list[str], stop_reason: str) -> None:
        # supporting evidence runs in parallel; wait a bounded time for it
        if job.replay_of is None:
            t0 = time.time()
            while job.evidence is None and time.time() - t0 < self.config.evidence_wait_s:
                time.sleep(0.2)
        result["supporting_evidence"] = job.evidence if job.evidence is not None else [
            {"id": "pending", "status": "unavailable", "title": "Supporting evidence",
             "summary": "still being fetched when the run finished — it will be added to the trace when it arrives"}]
        result["inputs_summary"] = summarize_inputs(job.trace.get("inputs", []))
        try:
            result["advisory"] = advisory_for(job.ir, result, self.provider.region(job.ir.region_id))
        except Exception as e:  # noqa: BLE001
            result["advisory"] = {"error": f"{type(e).__name__}"}
        job.result = result
        job.trace["result"] = {k: v for k, v in result.items() if k != "selected_tile_ids"}
        job.trace["sample_order"] = sample_order
        self._save_trace(job)
        job.status = "stopped" if stop_reason == "user_stop" else "done"
        if job.live and job.replay_of is None:
            try:
                self.provider.on_job_done(job.ir, result.get("oracle_calls", 0))
            except Exception:  # noqa: BLE001
                pass
        job.emit({"type": "result", **result})

    def _collect_evidence(self, job: Job, u: TileUniverse) -> None:
        try:
            ev = self.provider.supporting_evidence(job.ir, u)
        except Exception as e:  # noqa: BLE001
            ev = [{"id": "error", "status": "error", "title": "Supporting evidence", "summary": f"{type(e).__name__}: {e}"[:300]}]
        job.evidence = ev
        job.trace["supporting_evidence"] = ev
        job.emit({"type": "evidence", "items": ev})
        if job.result is not None and job.status in ("done", "stopped"):
            job.result["supporting_evidence"] = ev   # arrived after the result: keep trace and summary current
            self._save_trace(job)

    # ------------------------------------------------------------------ census (complete catalogues)
    def _run_census(self, job: Job, u: TileUniverse, oracle: Oracle, scene_key: str, sensor: str, units: dict,
                    t_start: float) -> None:
        ir = job.ir
        vals, details, summary = self.provider.census_values(ir, u)
        order = np.argsort(-vals, kind="stable")
        tiles = [{"tile_id": u.tile_ids[i], "idx": int(i), "stratum": 0, "value": float(vals[i]), "cache": False,
                  "latency_s": 0.0, "detail": details[i]} for i in order if vals[i] > 0]
        rank = np.zeros(u.n, dtype=int)
        pos = vals > 0
        if pos.any():
            q = np.quantile(vals[pos], [0.5, 0.8, 0.95])
            rank[pos] = 1 + (vals[pos] >= q[0]).astype(int) + (vals[pos] >= q[1]).astype(int) + (vals[pos] >= q[2]).astype(int)
        job.strata = rank
        total = float(vals.sum())
        display = {"value": total, "lo": total, "hi": total, "halfwidth": 0.0, "method": "census", "n": u.n, **summary}
        elapsed = time.perf_counter() - t_start
        job.emit({"type": "progress", "batch": 1, "n": u.n, "population": u.n, "oracle_calls": 0, "cache_hits": 0,
                  "elapsed_s": round(elapsed, 3), "estimate": display, "allocation": [], "tiles": tiles})
        job.trace["design"] = "census"
        job.trace["batches"] = [{"batch": 1, "tiles": [{k: t[k] for k in ("tile_id", "value")} for t in tiles]}]
        result = self._result_common(job, u, u.n, 0, 0, 0.0, elapsed, sensor, oracle, scene_key, units, "census", display)
        result["selected_tile_ids"] = [t["tile_id"] for t in tiles]
        result["priority_tiles"] = [{"tile_id": t["tile_id"], "bbox": [round(float(v), 4) for v in u.bboxes[t["idx"]]],
                                     **t["detail"]} for t in tiles[:25]]
        self._finish(job, result, [], "census")

    def _result_common(self, job: Job, u: TileUniverse, n: int, calls: int, cache_hits: int, saved_s: float,
                       elapsed: float, sensor: str, oracle: Oracle, scene_key: str, units: dict, stop_reason: str,
                       display: dict) -> dict:
        ir = job.ir
        lats = self._latencies(job)
        mean_latency = float(np.mean(lats)) if lats else getattr(self.provider, "oracle_latency_s", 0.0)
        return {
            "estimate": display, "units": units, "stop_reason": stop_reason, "n": n, "population": u.n,
            "oracle_calls": calls, "cache_hits": cache_hits, "compute_saved_by_cache_s": round(saved_s, 2),
            "elapsed_s": round(elapsed, 3), "mean_oracle_latency_s": round(mean_latency, 4),
            "projected_exhaustive_s": round(u.n * (mean_latency or 0.0) / self.config.workers, 1),
            "sampled_fraction": round(n / max(u.n, 1), 4), "sensor": sensor, "oracle": oracle.to_json(),
            "scene_key": scene_key, "answer": self._answer_text(ir, display, n, u.n, oracle, sensor, self.provider.region(ir.region_id)),
            "caveats": self._caveats(ir, display) + self.provider.caveats(ir),
            "data_mode": "live" if job.live else "simulated",
            "region": (lambda r: r.to_json(geometry=False) if r else None)(self.provider.region(ir.region_id)),
        }

    # ------------------------------------------------------------------ find-all
    def _run_find_all(self, job: Job, u: TileUniverse, oracle: Oracle, scene_key: str, sensor: str,
                      units: dict, t_start: float) -> None:
        """Verify top-down by proxy score + random audit below; stop on a recall certificate."""
        ir, cfg = job.ir, self.config
        alpha = 1 - ir.confidence
        target = ir.precision / 100
        fa = FrontierAudit(u.score0, seed=ir.seed)
        pos_thr = POSITIVE_THRESHOLD[ir.target]
        job.trace["positive_threshold"] = {"value": pos_thr, "unit": oracle.unit}
        rank_dec = np.minimum((fa.rank * 10) // max(u.n, 1), 9)
        job.strata = (9 - rank_dec).astype(int)   # deciles of proxy score, for the map legend
        job.state = fa
        job.trace["design"] = "frontier_audit"
        calls = cache_hits = 0
        saved_s = 0.0
        batch_no = 0
        stop_reason = "exhausted"
        display: dict = {}
        while True:
            elapsed = time.perf_counter() - t_start
            if job.stop_requested:
                stop_reason = "user_stop"; break
            if job.replay_n is None:
                if elapsed >= ir.budget_seconds:
                    stop_reason = "time_budget"; break
                if fa.n >= ir.budget_tiles:
                    stop_reason = "tile_budget"; break
            elif fa.n >= job.replay_n:
                stop_reason = "replay_complete"; break
            cap = (job.replay_n if job.replay_n is not None else ir.budget_tiles) - fa.n
            idxs, kind = fa.plan(min(cfg.batch_size, cap), alpha, target)
            if not idxs:
                stop_reason = "census"; break
            front_set = set(getattr(fa, "_pending_front", []))
            results = list(self._pool.map(lambda i: self._call_oracle(oracle, u, i, ir, scene_key), idxs))
            batch_tiles = []
            for r in results:
                fa.record(r["idx"], 1.0 if r["value"] >= pos_thr else 0.0)
                calls += 0 if r["cache"] else 1
                cache_hits += 1 if r["cache"] else 0
                saved_s += r["saved_s"]
                batch_tiles.append({
                    "tile_id": u.tile_ids[r["idx"]], "idx": r["idx"], "stratum": int(job.strata[r["idx"]]),
                    "role": "frontier" if r["idx"] in front_set else "audit",
                    "value": round(r["value"], 6), "cache": r["cache"], "latency_s": round(r["latency_s"], 4),
                    "detail": r["detail"],
                })
            fa.finish_batch()
            batch_no += 1
            looked = fa.maybe_certify(alpha)
            sm = fa.summary(alpha, ir.confidence)
            display = self._display_find_all(sm, fa.n)
            elapsed = time.perf_counter() - t_start
            job.emit({"type": "progress", "batch": batch_no, "n": fa.n, "population": u.n, "oracle_calls": calls,
                      "cache_hits": cache_hits, "elapsed_s": round(elapsed, 3), "estimate": display,
                      "allocation": {"kind": kind, "frontier": len(front_set), "audit": len(idxs) - len(front_set)},
                      "tiles": batch_tiles})
            job.trace["batches"].append({
                "batch": batch_no, "allocation": kind,
                "tiles": [{k: t[k] for k in ("tile_id", "role", "value", "cache")} for t in batch_tiles],
                "estimate": display, "elapsed_s": round(elapsed, 3)})
            if job.replay_n is None and looked and sm["recall_lower_bound"] >= target and sm["confirmed_positive_tiles"] > 0:
                stop_reason = "recall_certified"; break
        elapsed = time.perf_counter() - t_start
        if not display:
            display = self._display_find_all(fa.summary(alpha, ir.confidence), fa.n)
        result = self._result_common(job, u, fa.n, calls, cache_hits, saved_s, elapsed, sensor, oracle, scene_key,
                                     units, stop_reason, display)
        result["selected_tile_ids"] = [u.tile_ids[i] for i in np.flatnonzero(fa.confirmed())]
        prevalence = display.get("positive_tiles_estimate", 0) / max(u.n, 1)
        if prevalence > 0.25:
            result["caveats"].append(
                f"About {prevalence:.0%} of tiles contain the target, so certified find-all cannot be much cheaper "
                "than labelling every tile. Ask an aggregate question (area, count) instead, or map it exhaustively.")
        result["caveats"].append(
            "Certifying recall for rare targets is expensive: proving that low-score areas are nearly empty needs "
            "hundreds of random audit labels. Expect modest savings here; aggregate questions save far more.")
        self._finish(job, result, [u.tile_ids[i] for i in fa.sample_order], stop_reason)

    def _latencies(self, job: Job) -> list[float]:
        return [t["latency_s"] for e in job.events if e["type"] == "progress" for t in e["tiles"] if not t["cache"]]

    def _run_inspect(self, job: Job, u: TileUniverse, oracle: Oracle, scene_key: str, t_start: float) -> None:
        ir = job.ir
        idxs = list(range(min(u.n, self.config.max_inspect_tiles)))
        results = list(self._pool.map(lambda i: self._call_oracle(oracle, u, i, ir, scene_key), idxs))
        tiles = [{"tile_id": u.tile_ids[r["idx"]], "idx": r["idx"], "stratum": 0, "value": round(r["value"], 6),
                  "cache": r["cache"], "latency_s": round(r["latency_s"], 4), "detail": r["detail"]} for r in results]
        job.emit({"type": "progress", "batch": 1, "n": len(tiles), "population": u.n,
                  "oracle_calls": sum(not t["cache"] for t in tiles), "cache_hits": sum(t["cache"] for t in tiles),
                  "elapsed_s": round(time.perf_counter() - t_start, 3), "estimate": {}, "allocation": [], "tiles": tiles})
        answers: dict[str, int] = {}
        for t in tiles:
            a = t["detail"].get("answer", "")
            answers[a] = answers.get(a, 0) + 1
        top = max(answers.items(), key=lambda kv: kv[1])[0] if answers else "no tiles in radius"
        result = {
            "estimate": {"answers": answers, "tiles": len(tiles)},
            "units": units_for(ir), "stop_reason": "census", "n": len(tiles), "population": u.n,
            "oracle_calls": sum(not t["cache"] for t in tiles), "cache_hits": sum(t["cache"] for t in tiles),
            "compute_saved_by_cache_s": 0.0, "elapsed_s": round(time.perf_counter() - t_start, 3),
            "mean_oracle_latency_s": 0.0, "projected_exhaustive_s": 0.0, "sampled_fraction": 1.0,
            "sensor": oracle.sensor, "oracle": oracle.to_json(), "scene_key": scene_key,
            "answer": f"Within {ir.radius_km:g} km of ({ir.point.lat:.4f}, {ir.point.lon:.4f}): {top} "
                      f"({answers.get(top, 0)} of {len(tiles)} tiles). Every tile was inspected — no sampling.",
            "caveats": ["Exact per-tile answers from the VQA oracle; no statistical interval applies."],
        }
        job.result = result
        job.trace["batches"] = [{"batch": 1, "tiles": [{k: t[k] for k in ("tile_id", "value", "cache")} for t in tiles]}]
        job.trace["result"] = result
        self._save_trace(job)
        job.status = "done"
        job.emit({"type": "result", **result})

    # ------------------------------------------------------------------ presentation
    def _display(self, ir: QueryIR, est: Estimate, D: float) -> dict:
        d = est.to_json()
        if ir.task == Task.AREA_FRACTION:
            scale = 100.0 / D if D > 0 else 0.0
            d.update(value=est.estimate * scale, lo=max(0.0, est.lo * scale), hi=min(100.0, est.hi * scale),
                     total_km2=est.estimate, total_lo_km2=max(0.0, est.lo), total_hi_km2=est.hi, base_km2=D)
        else:
            d.update(value=est.estimate, lo=max(0.0, est.lo), hi=est.hi)
        d["halfwidth"] = (d["hi"] - d["lo"]) / 2
        for k in ("value", "lo", "hi", "halfwidth"):
            d[k] = round(float(d[k]), 4)
        return d

    def _display_find_all(self, sm: dict, n: int) -> dict:
        d = dict(sm)
        d.update(value=sm["positive_tiles_estimate"], lo=sm["positive_tiles_lo"], hi=sm["positive_tiles_hi"],
                 halfwidth=round((sm["positive_tiles_hi"] - sm["positive_tiles_lo"]) / 2, 2),
                 method="frontier_audit", n=n)
        return d

    @staticmethod
    def _precision_met(ir: QueryIR, d: dict) -> bool:
        hw = d["halfwidth"]
        if ir.task == Task.AREA_FRACTION:
            return hw <= ir.precision
        v = abs(d["value"])
        if v < 1e-9:
            return d["hi"] < 0.5
        return 100.0 * hw / v <= ir.precision

    @staticmethod
    def _answer_text(ir: QueryIR, d: dict, n: int, N: int, oracle: Oracle, sensor: str, region=None) -> str:
        conf = f"{ir.confidence:.0%}"
        window = f"{ir.start:%d %b %Y} – {ir.end:%d %b %Y}"
        where = f" in {region.name}" + (f", {region.state}" if region is not None and region.state else "") if region is not None else ""
        tail = f" Based on {n:,} of {N:,} tiles analysed with {oracle.name} ({sensor})."
        if not d:
            return "No estimate was produced." + tail
        if ir.target == Target.ACTIVE_FIRE:
            byc = d.get("by_confidence", {})
            head = (f"{int(d['value']):,} satellite fire detections{where} during {window} "
                    f"({byc.get('high', 0)} high, {byc.get('nominal', 0)} nominal, {byc.get('low', 0)} low confidence); "
                    f"{d.get('on_cropland', 0):,} on cropland, in {d.get('tiles_with_detections', 0):,} of {N:,} tiles.")
            if d.get("newest_detection"):
                head += f" Newest detection: {d['newest_detection']}."
            if ir.task == Task.FIND_ALL:
                head += " Tiles are ranked by detection count for field review."
            return head + " Every tile counted from the NASA FIRMS catalogue — no sampling."
        if ir.task == Task.AREA_FRACTION:
            verb, base = TARGET_WORDS.get(ir.target, ("affected", "cropland"))
            return (f"About {d['value']:.1f}% of {base}{where} was {verb} during {window} "
                    f"({conf} CI {d['lo']:.1f}–{d['hi']:.1f}%), i.e. ≈{d['total_km2']:.0f} km² of "
                    f"{d['base_km2']:.0f} km² {base}." + tail)
        if ir.task == Task.TOTAL:
            what = {Target.NEW_BUILTUP: "new built-up area", Target.BURNED_CROPLAND: "burned cropland"}.get(ir.target, "flooded cropland")
            span = f"between {ir.baseline_start.year} and {ir.end.year}" if ir.baseline_start else f"during {window}"
            return f"About {d['value']:.1f} km² of {what}{where} {span} ({conf} CI {d['lo']:.1f}–{d['hi']:.1f} km²)." + tail
        if ir.task == Task.COUNT:
            return f"About {d['value']:.0f} brick kilns{where} in {ir.end.year} ({conf} CI {d['lo']:.0f}–{d['hi']:.0f})." + tail
        if ir.task == Task.FIND_ALL:
            what = {Target.BRICK_KILN: "tiles with kilns", Target.NEW_BUILTUP: "tiles with new construction",
                    Target.FLOODED_CROPLAND: "tiles with flooded cropland"}.get(ir.target, "tiles with the target")
            ok = d["recall_lower_bound"] >= ir.precision / 100
            head = (f"Found {d['confirmed_positive_tiles']:,} {what}, each confirmed by the specialist model. "
                    f"With {conf} confidence this is at least {100 * d['recall_lower_bound']:.0f}% of all of them"
                    + (f" (target {ir.precision:g}% met)." if ok else f" — target {ir.precision:g}% NOT yet certified; raise the budget."))
            return (head + f" Estimated {d['value']:.0f} in total ({conf} CI {d['lo']:.0f}–{d['hi']:.0f}); "
                    f"{d['frontier_depth']:,} tiles verified top-down by proxy score and {d['audit_tiles']:,} audited at random." + tail)
        return tail.strip()

    @staticmethod
    def _caveats(ir: QueryIR, d: dict) -> list[str]:
        if d and d.get("method") == "census":
            return ["This is an exact count over every tile — there is no sampling error, but the catalogue's own "
                    "limitations (cloud, overpass timing, pixel size) still apply."]
        out = ["The interval covers sampling error relative to what the specialist model would report over every "
               "tile. It does not include the model's own error against reality."]
        if ir.task == Task.FIND_ALL:
            out.append("The recall certificate is relative to what the specialist model would flag; every listed tile is model-confirmed, so its precision equals the model's precision.")
        if d and d.get("method") == "stratified":
            out.append("Proxy model not used yet (fewer than 30 labelled tiles) — interval is from the stratified estimator alone.")
        return out

    # ------------------------------------------------------------------ evidence & trace
    def _save_trace(self, job: Job) -> None:
        path = self.store / "traces" / f"{job.id}.json"
        path.write_text(json.dumps(job.trace, indent=1, default=str))

    def trace_path(self, job_id: str) -> Path:
        return self.store / "traces" / f"{job_id}.json"

    def universe_geojson(self, job: Job) -> dict:
        u = job.universe
        if u is None:
            return {"type": "FeatureCollection", "features": []}
        s = u.score0
        rank = np.argsort(np.argsort(s)) / max(len(s) - 1, 1)
        strata = job.strata if job.strata is not None else np.zeros(u.n, dtype=int)
        feats = [u.geojson(i, {"proxy_rank": round(float(rank[i]), 4), "stratum": int(strata[i]),
                               "base_km2": round(float(u.base_km2[i]), 4)}) for i in range(u.n)]
        return {"type": "FeatureCollection", "features": feats}

    def evidence_geojson(self, job: Job) -> dict:
        u, st = job.universe, job.state
        feats = []
        if u is None:
            return {"type": "FeatureCollection", "features": feats}
        sel = set(job.result.get("selected_tile_ids", [])) if job.result else set()
        sampled = {}
        for e in job.events:
            if e["type"] == "progress":
                for t in e["tiles"]:
                    sampled[t["idx"]] = t
        for i in range(u.n):
            t = sampled.get(i)
            if t is None and u.tile_ids[i] not in sel:
                continue
            props = {"sampled": t is not None, "selected": u.tile_ids[i] in sel, "base_km2": round(float(u.base_km2[i]), 4)}
            if t:
                props.update(value=t["value"], stratum=t["stratum"], cache=t["cache"], **{f"detail_{k}": v for k, v in t["detail"].items()})
            feats.append(u.geojson(i, props))
        return {"type": "FeatureCollection", "features": feats, "properties": {"job_id": job.id, "scene_key": job.trace.get("scene_key")}}

    def exhaustive(self, job: Job, *, simulate_latency: bool = False) -> dict:
        """Run the oracle on every tile (for benchmarking against the anytime answer).

        With ``simulate_latency=False`` results are *not* written to the cache,
        so the demo cannot accidentally make later queries look cheaper.
        """
        if job.universe is None or job.result is None:
            raise ValueError("job has no result yet")
        u, ir = job.universe, job.ir
        sensor = job.trace["sensor"]
        oracle = self.provider.oracle(ir, sensor)
        scene_key = job.trace["scene_key"]
        t0 = time.perf_counter()
        vals = np.array([r["value"] for r in self._pool.map(
            lambda i: self._call_oracle(oracle, u, i, ir, scene_key, use_cache=True, write_cache=simulate_latency,
                                        simulate_latency=simulate_latency), range(u.n))])
        dt = time.perf_counter() - t0
        D = float(u.base_km2.sum())
        if ir.task == Task.AREA_FRACTION:
            oracle_answer = 100 * vals.sum() / D
        elif ir.task == Task.FIND_ALL:
            oracle_answer = float((vals >= POSITIVE_THRESHOLD[ir.target]).sum())
        else:
            oracle_answer = float(vals.sum())
        est = job.result["estimate"]
        out = {
            "oracle_answer": round(float(oracle_answer), 4),
            "anytime_estimate": est.get("value"),
            "anytime_interval": [est.get("lo"), est.get("hi")],
            "inside_interval": bool(est.get("lo", -math.inf) <= oracle_answer <= est.get("hi", math.inf)),
            "exhaustive_tiles": u.n,
            "anytime_oracle_calls": job.result["n"],
            "call_reduction": round(u.n / max(job.result["n"], 1), 2),
            "exhaustive_wallclock_s": round(dt, 2) if simulate_latency else None,
            "projected_exhaustive_s": job.result["projected_exhaustive_s"],
            "anytime_elapsed_s": job.result["elapsed_s"],
        }
        if ir.task == Task.FIND_ALL and job.result.get("selected_tile_ids") is not None:
            sel = set(job.result["selected_tile_ids"])
            pos = [u.tile_ids[i] for i in np.flatnonzero(vals >= POSITIVE_THRESHOLD[ir.target])]
            out["achieved_recall"] = round(sum(p in sel for p in pos) / max(len(pos), 1), 4)
            out["selected_tiles"] = len(sel)
        gt = self.provider.ground_truth(ir)
        if gt is not None:
            if ir.task == Task.AREA_FRACTION:
                reality = 100 * gt.sum() / D
            elif ir.task == Task.FIND_ALL:
                reality = float((gt >= POSITIVE_THRESHOLD[ir.target]).sum())
            else:
                reality = float(gt.sum())
            out["simulated_reality"] = round(float(reality), 4)
            out["oracle_error_vs_reality"] = round(float(oracle_answer - reality), 4)
        return out

    def replay(self, job: Job) -> Job:
        """Re-run a finished job with the same IR, seed and sample size.

        Oracle results come from the cache, so a replay is fast and must
        reproduce the recorded estimate exactly; ``verify_replay`` checks it.
        """
        cr = CompileResult(job.ir, job.compile_info.get("parser", "replay"), job.compile_info.get("assumptions", []))
        sizes = [b.get("requested") for b in job.trace.get("batches", []) if b.get("requested")]
        return self.submit(cr, replay_of=job.id, replay_n=job.result["n"] if job.result else None, replay_batch_sizes=sizes or None)

    @staticmethod
    def verify_replay(original: Job, replay: Job) -> dict:
        a = original.trace.get("sample_order", [])
        b = replay.trace.get("sample_order", [])
        ea = (original.result or {}).get("estimate", {})
        eb = (replay.result or {}).get("estimate", {})
        same = a == b and all(ea.get(k) == eb.get(k) for k in ("value", "lo", "hi"))
        return {"identical": same, "same_sample_order": a == b, "original": {k: ea.get(k) for k in ("value", "lo", "hi")},
                "replay": {k: eb.get(k) for k in ("value", "lo", "hi")}, "replay_oracle_calls": (replay.result or {}).get("oracle_calls")}
