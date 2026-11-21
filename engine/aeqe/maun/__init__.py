"""Maun: estimate the true need in a disaster area, including the need nobody reported, with an honest 95% range.

Built on the AEQE design without changing it: cells are strata by predicted need (``build_strata``), field checks are
chosen at random within strata by sequential Neyman allocation (``SampleState``), and the total is estimated with the
cross-fitted difference estimator (or the stratified estimator while there are fewer than 30 checks), with
alpha spending over repeated looks (``spent_confidence``). See ``run.py``.
"""

from .model import BASE_NEED_RATE, PEOPLE_PER_HOUSEHOLD, features, predicted_need
from .oracle import FieldCheckOracle
from .run import compute, MaunSpecError

__all__ = ["BASE_NEED_RATE", "FieldCheckOracle", "MaunSpecError", "PEOPLE_PER_HOUSEHOLD", "compute", "features", "predicted_need"]
