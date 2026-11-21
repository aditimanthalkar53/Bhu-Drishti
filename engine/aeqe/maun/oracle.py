"""The field-check oracle: a volunteer or assessment team visits a cell and records the actual need.

Unlike AEQE's satellite oracles it is asynchronous: results arrive in waves, days apart, entered by people. The engine
therefore never calls it in a loop; ``run.compute`` replays the recorded results. ``run`` only looks a result up, so the
class still satisfies the ``Oracle`` interface (for traces and for any code that lists oracles).
"""

from __future__ import annotations

from ..ir import QueryIR
from ..providers.base import Oracle, OracleOutput, TileUniverse


class PendingCheck(Exception):
    """The cell was selected but its field check has not been entered yet."""


class FieldCheckOracle(Oracle):
    name = "field_check"
    model_version = "human-1"
    sensor = "volunteer / assessment team visit"
    unit = "households in need"
    description = ("Households needing rescue, food or water, shelter or medical help, counted on the ground by a volunteer "
                   "or assessment team. Small counting errors are possible; selection is random within strata.")

    def __init__(self, results: dict[str, dict]):
        self.results = results

    def run(self, universe: TileUniverse, idx: int, ir: QueryIR) -> OracleOutput:
        cid = universe.tile_ids[idx]
        r = self.results.get(cid)
        if r is None:
            raise PendingCheck(cid)
        if r.get("unreachable"):
            return OracleOutput(float("nan"), {"unreachable": True})
        return OracleOutput(float(r["households"]), {k: v for k, v in r.items() if k != "households"})
