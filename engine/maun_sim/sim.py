"""SIMULATED Barpeta-like world, simulated field checks, and the coverage experiment."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from aeqe.hazard.grid import make_grid
from aeqe.maun import compute

BBOX = (90.80, 26.20, 91.30, 26.70)      # roughly the Barpeta district box (Assam)
NEED_RATE = 0.25                          # share of households in need at full flooding (truth model, hidden)


@dataclass
class World:
    cells: list[dict]          # what the engine sees: hazard, population, reports (no truth)
    truth: np.ndarray          # SIMULATED households in need per cell (hidden from the engine)
    low_network: np.ndarray    # True where reporting is much less likely
    flood: np.ndarray          # SIMULATED flood share per cell

    @property
    def true_total(self) -> float:
        return float(self.truth.sum())

    @property
    def reported_total(self) -> float:
        return float(sum(c["reported"] for c in self.cells))


def world(seed: int = 0, cell_deg: float = 0.025, areas: bool = True) -> World:
    rng = np.random.default_rng(seed)
    grid = make_grid(BBOX, cell_deg)
    lat = np.array([c.center[0] for c in grid])
    lon = np.array([c.center[1] for c in grid])
    # a meandering river running roughly north-south; flood extent decays with distance from it
    river_lon = 91.05 + 0.06 * np.sin((lat - 26.2) * 14 + rng.uniform(0, 2 * math.pi)) + rng.normal(0, 0.005)
    dist_km = np.abs(lon - river_lon) * 111.32 * math.cos(math.radians(26.45))
    flood = np.clip(1.15 * np.exp(-dist_km / rng.uniform(4.0, 7.0)) + rng.normal(0, 0.06, len(grid)), 0, 1)
    # population: villages everywhere, a few towns
    pop = rng.lognormal(math.log(1800), 0.5, len(grid))
    towns = rng.uniform([BBOX[1], BBOX[0]], [BBOX[3], BBOX[2]], size=(4, 2))
    town_d = np.min([np.hypot(lat - t[0], lon - t[1]) for t in towns], axis=0)
    pop *= 1 + 6 * np.exp(-town_d / 0.03)
    households = pop / 4.5
    # networks are poor away from towns
    low_network = (town_d > 0.12) & (rng.uniform(size=len(grid)) < 0.8)
    rate = np.where(low_network, 0.08, 0.45)
    truth = rng.poisson(households * NEED_RATE * flood ** 1.3).astype(float)
    reported = rng.binomial(truth.astype(int), rate)
    # an earlier burst of reports that then stopped (phones died) in some low-network cells
    earlier = np.where(low_network & (flood > 0.5) & (rng.uniform(size=len(grid)) < 0.3), rng.integers(3, 7, len(grid)), 0)
    hazard = np.clip(flood + rng.normal(0, 0.08, len(grid)), 0, 1)     # the hazard layer sees the flood imperfectly
    cells = []
    for i, c in enumerate(grid):
        cells.append({"id": c.id, "bbox": list(c.bbox), "area_km2": round(c.area_km2(), 3), "hazard": round(float(hazard[i]), 4),
                      "population": round(float(pop[i]), 1), "reported": int(reported[i]), "reported_recent": int(reported[i]),
                      "reported_earlier": int(earlier[i]),
                      **({"area": ("North" if c.center[0] > 26.45 else "South") + (" bank-W" if c.center[1] < 91.05 else " bank-E")} if areas else {})})
    return World(cells, truth, low_network, flood)


def field_check(true_value: float, rng: np.random.Generator) -> float:
    """SIMULATED visit: small counting noise, unbiased (no noise where there is nothing to count)."""
    if true_value <= 0:
        return 0.0
    return float(max(0.0, true_value + round(rng.normal(0, 0.5))))


def simulate_run(seed: int, waves=(30, 25, 25, 20), conf: float = 0.95, areas: bool = False, w: World | None = None) -> dict:
    w = w or world(seed, areas=areas)
    rng = np.random.default_rng(seed + 10_000)
    spec = {"cells": w.cells, "seed": seed + 1, "conf": conf, "waves": [], "results": {}, "looks": 1}
    index = {c["id"]: i for i, c in enumerate(w.cells)}
    history = []
    out = None
    for k, size in enumerate(waves):
        out = compute({**spec, "new_wave": size})
        spec["waves"].append({"alloc": out["new_wave"]["alloc"]})
        for cid in out["new_wave"]["cells"]:
            spec["results"][cid] = {"households": field_check(w.truth[index[cid]], rng)}
        spec["looks"] = k + 1
        out = compute(spec)
        if out["overall"]:
            o = out["overall"]
            history.append({"wave": k + 1, "checks": out["checks_done"], "estimate": o["estimate"], "lo": o["lo"], "hi": o["hi"]})
    o = out["overall"]
    return {"seed": seed, "true_total": w.true_total, "reported_total": w.reported_total, "estimate": o["estimate"], "lo": o["lo"], "hi": o["hi"],
            "covered": o["lo"] <= w.true_total <= o["hi"], "method": o["method"], "checks": out["checks_done"], "cells": len(w.cells),
            "history": history, "silent_zones": len(out["silent_zones"])}


def coverage(runs: int = 500, start_seed: int = 0, **kw) -> dict:
    rs = [simulate_run(start_seed + s, **kw) for s in range(runs)]
    cov = float(np.mean([r["covered"] for r in rs]))
    se = math.sqrt(cov * (1 - cov) / runs)
    return {"runs": runs, "coverage": cov, "coverage_se": se, "mean_true": float(np.mean([r["true_total"] for r in rs])),
            "mean_reported": float(np.mean([r["reported_total"] for r in rs])), "mean_halfwidth": float(np.mean([(r["hi"] - r["lo"]) / 2 for r in rs])),
            "results": rs, "note": "SIMULATED ground truth. The range covers sampling error only."}
