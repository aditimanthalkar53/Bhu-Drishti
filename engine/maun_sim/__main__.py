"""python -m maun_sim [--runs 500] [--out ../data/maun_sim]   (run from engine/)

Prints one SIMULATED run (reported vs estimated vs true, wave by wave), then the empirical coverage of the 95% range
over many runs, and saves a JSON summary and, when matplotlib is installed, a chart.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from .sim import coverage, simulate_run


def main() -> None:
    ap = argparse.ArgumentParser(description="Maun SIMULATION: coverage of the 95% range")
    ap.add_argument("--runs", type=int, default=500)
    ap.add_argument("--out", default="../data/maun_sim")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    print("SIMULATED data: the true need below is generated, not observed.\n")
    one = simulate_run(0, areas=True)
    print(f"One run ({one['cells']} cells): reported {one['reported_total']:.0f} households, true {one['true_total']:.0f} (hidden from the engine)")
    for h in one["history"]:
        print(f"  wave {h['wave']}: {h['checks']:3d} checks  estimate {h['estimate']:8.0f}  95% range {h['lo']:8.0f} - {h['hi']:8.0f}")
    print(f"  silent zones flagged: {one['silent_zones']}\n")

    t = time.time()
    c = coverage(a.runs)
    print(f"Coverage over {c['runs']} runs: {c['coverage'] * 100:.1f}% (+/- {c['coverage_se'] * 196:.1f} points at 95%) in {time.time() - t:.0f} s")
    print(f"Mean true total {c['mean_true']:.0f}, mean reported {c['mean_reported']:.0f}, mean half-width {c['mean_halfwidth']:.0f}")
    print(c["note"])
    (out / "coverage.json").write_text(json.dumps({k: v for k, v in c.items() if k != "results"} | {"example_run": one}, indent=2))
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        rs = sorted(c["results"], key=lambda r: r["estimate"] - r["true_total"])[:: max(1, len(c["results"]) // 100)]
        fig, ax = plt.subplots(1, 2, figsize=(12, 4.5))
        for i, r in enumerate(rs):
            ax[0].plot([i, i], [r["lo"] - r["true_total"], r["hi"] - r["true_total"]], color="#1f77b4" if r["covered"] else "#d62728", lw=1.2)
        ax[0].axhline(0, color="black", lw=0.8)
        ax[0].set_title(f"95% ranges minus the true total (SIMULATED), coverage {c['coverage'] * 100:.1f}%")
        ax[0].set_xlabel("runs (sample of 100, sorted)")
        ax[0].set_ylabel("households")
        hs = one["history"]
        ax[1].fill_between([h["checks"] for h in hs], [h["lo"] for h in hs], [h["hi"] for h in hs], alpha=0.25, label="95% range")
        ax[1].plot([h["checks"] for h in hs], [h["estimate"] for h in hs], marker="o", label="estimate")
        ax[1].axhline(one["true_total"], color="green", ls="--", label="true (SIMULATED)")
        ax[1].axhline(one["reported_total"], color="gray", ls=":", label="reported")
        ax[1].set_title("One run: estimate as field checks arrive")
        ax[1].set_xlabel("field checks")
        ax[1].legend()
        fig.tight_layout()
        fig.savefig(out / "coverage.png", dpi=120)
        print(f"Chart saved to {out / 'coverage.png'}")
    except ImportError:
        print("matplotlib not installed: chart skipped (pip install matplotlib)")


if __name__ == "__main__":
    main()
