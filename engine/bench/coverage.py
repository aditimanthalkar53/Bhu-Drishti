"""Empirical coverage + cost benchmark for the anytime engine.

For each scenario the query is repeated with R different seeds. Each run is
compared with the exhaustive answer (the oracle run on every tile). We report:

* coverage   — share of runs whose interval contains the exhaustive answer
               (target ≈ the nominal confidence, e.g. 95%)
* mean n     — oracle tiles used per run, and the reduction vs exhaustive
* bias       — mean (estimate − exhaustive)
* mean half-width at stop

Usage:  python -m bench.coverage --runs 200 --out bench/results.json
"""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path

import numpy as np

from aeqe.cache import ResultCache
from aeqe.compiler import compile_question
from aeqe.engine import Engine, EngineConfig
from aeqe.providers.simulated import SimulatedProvider

SCENARIOS = [
    ("flood share ±3pp", "What percentage of cropland was flooded during 1-15 July 2023?"),
    ("flood share ±1.5pp", "What percentage of cropland was flooded during 1-15 August 2022, within 1.5 pp?"),
    ("new built-up ±10%", "How much new built-up area appeared between 2020 and 2024?"),
    ("kiln count ±15%", "How many brick kilns are there in 2024?"),
    ("find kilns recall 90%", "Find all brick kilns in 2024 with recall 90%"),
    ("flood total ±10%", "How many km² of cropland were flooded during 1-15 August 2022?"),
]
REGIONS = ["lower-brahmaputra-a", "lower-brahmaputra-b"]


def run(runs: int, out: Path, only: str | None = None) -> dict:
    provider = SimulatedProvider(oracle_latency_s=0.0)
    engine = Engine(provider, ResultCache(), Path(tempfile.gettempdir()) / "aeqe-bench", EngineConfig(workers=4))
    report = {"runs_per_scenario": runs, "scenarios": []}
    previous = json.loads(out.read_text())["scenarios"] if (only and out.exists()) else []
    for name, q in SCENARIOS:
        if only and only not in name:
            report["scenarios"] += [r for r in previous if r["scenario"] == name]
            continue
        for region in REGIONS:
            ests, covered, ns, hws, achieved = [], [], [], [], []
            truth = None
            t0 = time.time()
            for seed in range(runs):
                cr = compile_question(q, region_id=region, overrides={"seed": 1000 + seed, "budget_seconds": 600, "budget_tiles": 5000})
                job = engine.submit(cr)
                while job.status in ("queued", "running"):
                    time.sleep(0.005)
                if job.error:
                    raise RuntimeError(job.error)
                ex = engine.exhaustive(job)
                truth = ex["oracle_answer"]
                ests.append(ex["anytime_estimate"])
                covered.append(ex["inside_interval"])
                ns.append(job.result["n"])
                hws.append(job.result["estimate"].get("halfwidth", np.nan))
                if "achieved_recall" in ex:
                    achieved.append(ex["achieved_recall"])
                engine.jobs.pop(job.id, None)
            N = job.result["population"]
            row = {
                "scenario": name, "region": region, "population_tiles": N,
                "exhaustive_answer": truth,
                "coverage": round(float(np.mean(covered)), 4),
                "mean_estimate": round(float(np.mean(ests)), 4),
                "bias": round(float(np.mean(ests) - truth), 4),
                "mean_halfwidth": round(float(np.nanmean(hws)), 4),
                "mean_oracle_tiles": round(float(np.mean(ns)), 1),
                "call_reduction_vs_exhaustive": round(N / float(np.mean(ns)), 2),
                "seconds": round(time.time() - t0, 1),
            }
            if achieved:
                row["recall_target_met_share"] = round(float(np.mean(np.array(achieved) >= job.ir.precision / 100)), 4)
                row["mean_achieved_recall"] = round(float(np.mean(achieved)), 4)
            print(json.dumps(row), flush=True)
            report["scenarios"].append(row)
    report["generated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    report["note"] = ("Simulated districts; 'coverage' = share of runs whose interval contained the exhaustive "
                      "oracle answer. Nominal level 95%. For find-all, 'coverage' refers to the interval on the "
                      "number of target tiles and 'recall_target_met_share' to the recall certificate.")
    out.write_text(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=200)
    ap.add_argument("--out", type=Path, default=Path("bench/results.json"))
    ap.add_argument("--only", default=None, help="re-run only scenarios whose name contains this text; keep the rest")
    a = ap.parse_args()
    run(a.runs, a.out, a.only)
