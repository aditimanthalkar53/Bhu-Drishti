"""Maun: estimate the true need in a disaster area, including the need nobody reported, with an honest 95% range.

Built on the AEQE design without changing it: cells are strata by a design score (``build_strata``), field checks are
chosen at random within strata by sequential Neyman allocation (``SampleState``), and the total is estimated with the
cross-fitted difference estimator (or the stratified estimator while there are fewer than 30 checks), with
alpha spending over repeated looks (``spent_confidence``). How need relates to hazard, people and reports is learned
from the checks, not assumed. See ``run.py``.
"""

from .model import PEOPLE_PER_HOUSEHOLD, design_score, features, households
from .oracle import FieldCheckOracle
from .run import MaunSpecError, benjamini_hochberg, compute, reporting_rate

__all__ = ["FieldCheckOracle", "MaunSpecError", "PEOPLE_PER_HOUSEHOLD", "benjamini_hochberg", "compute", "design_score", "features",
           "households", "reporting_rate"]
