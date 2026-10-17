"""End-to-end runs against live data (bounded). Prints the answer, interval, provenance counts and evidence.

    cd engine && python scripts/live_e2e.py fire|flood|built|burned [region_id] ["question"]
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "engine" / "scripts"))

from smoke_sources import load_env  # noqa: E402

load_env(ROOT / ".env")

from aeqe.cache import ResultCache  # noqa: E402
from aeqe.compiler import compile_question  # noqa: E402
from aeqe.engine import Engine, EngineConfig  # noqa: E402
from aeqe.providers.composite import CompositeProvider  # noqa: E402
from aeqe.providers.live import LiveProvider  # noqa: E402
from aeqe.providers.simulated import SimulatedProvider  # noqa: E402

CASES = {
    "fire": ("in-punjab-sangrur", "How many fire detections were there in the last 10 days?", {}),
    "fire_find": ("in-punjab-sangrur", "Identify areas with recent fire detections and prioritize them for review", {}),
    "flood": ("in-assam-barpeta", "What percentage of cropland was flooded during 1-15 July 2024, within 5 pp?", {"budget_tiles": 240}),
    "built": ("in-haryana-gurgaon", "How much new built-up area appeared between 2020 and 2025, within 25%?", {"budget_tiles": 200}),
    "burned": ("in-punjab-sangrur", "How much cropland was burned between 15 October 2025 and 15 November 2025, within 25%?", {"budget_tiles": 200}),
}


def main() -> int:
    case = sys.argv[1] if len(sys.argv) > 1 else "fire"
    rid, q, ov = CASES[case]
    if len(sys.argv) > 2:
        rid = sys.argv[2]
    if len(sys.argv) > 3:
        q = sys.argv[3]
    data = ROOT / "engine" / "data"
    live = LiveProvider(data)
    prov = CompositeProvider(SimulatedProvider(0.0), live)
    eng = Engine(prov, ResultCache(str(data / "cache.sqlite")), data, EngineConfig(workers=8))
    cr = compile_question(q, region_id=rid, overrides=ov, live=True)
    print("IR:", cr.ir.model_dump_json(exclude={"question"}))
    print("assumptions:", cr.assumptions)
    t0 = time.time()
    plan = eng.plan(cr.ir)
    print(f"plan ok={plan['ok']} ({time.time() - t0:.1f}s)")
    for c in plan["checks"]:
        print(f"  [{'ok' if c['ok'] else 'XX'}] {c['name']}: {c['detail']}")
    if not plan["ok"]:
        return 1
    job = eng.submit(cr)
    last = 0
    while job.status in ("queued", "running"):
        time.sleep(2)
        prog = [e for e in job.events if e["type"] == "progress"]
        if prog and prog[-1]["batch"] != last:
            p = prog[-1]
            last = p["batch"]
            e = p["estimate"]
            print(f"  batch {p['batch']}: n={p['n']} calls={p['oracle_calls']} t={p['elapsed_s']:.0f}s "
                  f"est={e.get('value')} [{e.get('lo')}, {e.get('hi')}] {e.get('interval_method', '')}")
    if job.error:
        print("ERROR:", job.error)
        return 1
    r = job.result
    print("\nANSWER:", r["answer"])
    print("stop:", r["stop_reason"], "| n:", r["n"], "of", r["population"], "| calls:", r["oracle_calls"], "| elapsed:", r["elapsed_s"], "s")
    print("caveats:")
    for c in r["caveats"]:
        print("  -", c)
    print("inputs provenance records:", len(job.trace.get("inputs", [])))
    for e in r.get("supporting_evidence", []):
        print(f"  evidence [{e.get('status')}] {e.get('title')}: {e.get('summary')}")
    if r.get("advisory"):
        print("advisory:", r["advisory"].get("headline"), f"({len(r['advisory'].get('items', []))} items)")
    if r.get("priority_tiles"):
        print("top tiles:", json.dumps(r["priority_tiles"][:3]))
    if case == "burned":
        # plausibility: burn share per sampled tile should rise with independent FIRMS detections
        import numpy as np
        from scipy.stats import spearmanr

        tiles = [t for e in job.events if e["type"] == "progress" for t in e["tiles"] if not t["detail"].get("no_data")]
        share = np.array([t["detail"].get("burned_share_of_cropland", 0.0) for t in tiles])
        det = np.array([t["detail"].get("firms_detections", 0) for t in tiles])
        if len(tiles) > 10:
            rho, p = spearmanr(share, det)
            print(f"plausibility: Spearman(burn share, FIRMS detections) = {rho:.2f} (p={p:.3g}, n={len(tiles)}); "
                  f"mean share with detections {share[det > 0].mean():.3f} vs without {share[det == 0].mean():.3f}")
    nd = r.get("missing_data_tiles")
    if nd:
        print("tiles without data:", nd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
