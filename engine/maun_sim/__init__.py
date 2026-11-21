"""SIMULATED test bed for Maun. Everything here is synthetic: the "true" need is generated, never observed.

``world`` builds a Barpeta-like area (a meandering river, flood extent around it, towns, low-network villages) with a
hidden true need per cell and reports that under-count need, much more so where networks are poor. ``simulate_run``
drives a Maun run wave by wave with noisy field checks. ``coverage`` repeats that many times and measures how often the
95% range contains the true total. The range covers sampling error only.
"""

from .sim import World, coverage, simulate_run, world

__all__ = ["World", "coverage", "simulate_run", "world"]
