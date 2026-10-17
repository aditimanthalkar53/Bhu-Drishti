"""Render bench/results.json as a Markdown table (bench/RESULTS.md)."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main(src: Path = Path("bench/results.json"), dst: Path = Path("bench/RESULTS.md")) -> None:
    d = json.loads(src.read_text())
    rows = [
        "| Question | District | Tiles | Exhaustive answer | Mean estimate | Interval covered exhaustive | "
        "Mean ± at stop | Oracle tiles used | Fewer model runs |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for s in d["scenarios"]:
        extra = ""
        if "recall_target_met_share" in s:
            extra = f" (recall target met in {100 * s['recall_target_met_share']:.0f}% of runs, mean recall {100 * s['mean_achieved_recall']:.1f}%)"
        rows.append(
            f"| {s['scenario']}{extra} | {s['region'][-1].upper()} | {s['population_tiles']:,} | {s['exhaustive_answer']:.1f} | "
            f"{s['mean_estimate']:.1f} | {100 * s['coverage']:.0f}% | {s['mean_halfwidth']:.1f} | {s['mean_oracle_tiles']:.0f} | "
            f"{s['call_reduction_vs_exhaustive']:.1f}× |"
        )
    text = (
        f"# Benchmark results\n\n{d['runs_per_scenario']} runs per row with different random seeds, "
        f"generated {d.get('generated_at', 'n/a')}.\n\n{d.get('note', '')}\n\n" + "\n".join(rows) + "\n"
    )
    dst.write_text(text)
    print(text)


if __name__ == "__main__":
    main(*(Path(a) for a in sys.argv[1:3]))
