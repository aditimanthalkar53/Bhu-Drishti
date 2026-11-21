"""Hazard layer ("virtual constellation") for disaster coordination.

We do not analyse imagery here. Each adapter reads one independent, already-processed product through the existing
source clients in ``aeqe.sources`` (retries, redaction, status ladder and provenance come from there) and returns
``HazardCell`` values on a common grid. ``combine`` turns the layers into one documented ``hazard_score`` per cell.
"""

from .grid import Cell, cell_id, make_grid
from .adapters import ADAPTERS, HazardAdapter, HazardCell, LayerResult
from .score import SCORE_DOC, WEIGHTS, combine, hazard_grid

__all__ = ["ADAPTERS", "Cell", "HazardAdapter", "HazardCell", "LayerResult", "SCORE_DOC", "WEIGHTS", "cell_id", "combine",
           "hazard_grid", "make_grid"]
