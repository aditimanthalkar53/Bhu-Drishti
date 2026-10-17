"""Routes each query to the simulated demo world or the live provider by region.

The two demo districts stay available offline (and are labelled "simulated"
everywhere); every Indian district and custom area of interest is served by
``LiveProvider`` with real data.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from ..ir import QueryIR, Target
from .base import Check, Oracle, Provider, Region, TileUniverse


class CompositeProvider(Provider):
    name = "composite"

    def __init__(self, simulated: Provider, live: Optional[Provider]):
        self.sim, self.live = simulated, live
        self._sim_ids = {r.id for r in simulated.regions()}

    def _p(self, region_id: str) -> Provider:
        if region_id in self._sim_ids or self.live is None:
            return self.sim
        return self.live

    def provider_name(self, ir: QueryIR) -> str:
        return self._p(ir.region_id).name

    def regions(self) -> list[Region]:
        return self.sim.regions() + (self.live.regions() if self.live else [])

    def region(self, region_id: str) -> Optional[Region]:
        return self._p(region_id).region(region_id)

    def check_inputs(self, ir: QueryIR) -> list[Check]:
        return self._p(ir.region_id).check_inputs(ir)

    def choose_sensor(self, ir: QueryIR) -> tuple[str, str]:
        return self._p(ir.region_id).choose_sensor(ir)

    def universe(self, ir: QueryIR) -> TileUniverse:
        return self._p(ir.region_id).universe(ir)

    def oracle(self, ir: QueryIR, sensor: str) -> Oracle:
        return self._p(ir.region_id).oracle(ir, sensor)

    def scene_key(self, ir: QueryIR, sensor: str) -> str:
        return self._p(ir.region_id).scene_key(ir, sensor)

    def ground_truth(self, ir: QueryIR) -> Optional[np.ndarray]:
        return self._p(ir.region_id).ground_truth(ir)

    def supports(self, target: Target) -> bool:
        return self.sim.supports(target) or bool(self.live and self.live.supports(target))

    def oracle_latency(self, ir: QueryIR) -> float:
        return self._p(ir.region_id).oracle_latency(ir)

    def is_live(self, ir: QueryIR) -> bool:
        return self._p(ir.region_id) is self.live

    def census_values(self, ir, u):
        return self._p(ir.region_id).census_values(ir, u)

    def supporting_evidence(self, ir, u):
        return self._p(ir.region_id).supporting_evidence(ir, u)

    def inputs_provenance(self, ir):
        return self._p(ir.region_id).inputs_provenance(ir)

    def caveats(self, ir):
        return self._p(ir.region_id).caveats(ir)

    def on_job_done(self, ir, oracle_calls):
        return self._p(ir.region_id).on_job_done(ir, oracle_calls)
