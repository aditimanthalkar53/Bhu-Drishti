"""Live end-to-end change detections through the real pipeline (read-only; downloads imagery windows).

    python scripts/live_detection.py sar_flood in-assam-barpeta 2024-06-05 2024-07-05
    python scripts/live_detection.py forest_loss <region id> 2023-02-01 2025-02-01

Prints each stage and the result summary; the record and PNG overlays stay in ``$AEQE_DATA_DIR/detections/``.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aeqe.eo.service import DetectionService  # noqa: E402
from aeqe.providers.live import LiveProvider  # noqa: E402


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    kind, region = sys.argv[1], sys.argv[2]
    before = date.fromisoformat(sys.argv[3]) if len(sys.argv) > 3 else None
    after = date.fromisoformat(sys.argv[4]) if len(sys.argv) > 4 else None
    data = Path(os.getenv("AEQE_DATA_DIR", "./data"))
    svc = DetectionService(LiveProvider(data), data, workers=1)
    job = svc.submit(kind, region, before, after)
    print(f"{job['id']}: {job['label']} — {job['name']}, {job['before']} → {job['after']}")
    seen: dict[str, str] = {}
    t0 = time.time()
    while True:
        cur = svc.get(job["id"])
        for s in cur["steps"]:
            state = f"{s['status']}|{s['detail']}"
            if seen.get(s["key"]) != state and s["status"] != "pending":
                seen[s["key"]] = state
                print(f"  [{time.time() - t0:6.1f}s] {s['key']:<15} {s['status']:<12} {s['detail']}")
        if cur["status"] not in ("queued", "running"):
            break
        time.sleep(1)
    if cur["status"] != "done":
        print("FAILED:", cur["error"])
        return 1
    r = cur["record"]
    forest = r.get("forest") or {}
    print(json.dumps({
        "detected": r["detected"], "area_km2": r["area_km2"], "range_km2": [r["area_low_km2"], r["area_high_km2"]],
        "aoi_km2": r["aoi_km2"], "grid": r["grid"], "valid_fraction": r["valid_fraction"], "confidence": r["confidence"],
        "reasons": r["confidence_reasons"], "flags": r["quality_flags"], "metrics": r["metrics"],
        "before": r["before"].get("first_acquired") or r["before"]["acquired"], "after": r["after"].get("last_acquired") or r["after"]["acquired"],
        "population": {k: (r["population"] or {}).get(k) for k in ("value", "low", "high", "area_population")} if r["population"] else r["population_error"],
        "facilities": (r.get("assets_in_extent") or {}).get("counts"), "risk": r["risk"]["level"], "risk_basis": r["risk"]["basis"],
        "hansen": {k: (forest.get("hansen") or {}).get(k) for k in ("status", "years", "matching_annual_loss_km2", "overlap_km2", "reason")} if forest else None,
        "firms": {k: (forest.get("firms") or {}).get(k) for k in ("status", "fire_detections", "reason")} if forest else None,
        "protected": {k: (forest.get("protected_areas") or {}).get(k) for k in ("status", "in_area", "overlapping_total", "reason")} if forest else None,
        "hotspots": len(forest.get("hotspots") or []), "corroboration": (forest.get("fusion") or {}).get("corroboration"),
        "patches": r["geometry"]["patch_count"], "seconds": r["processing"]["seconds"],
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
