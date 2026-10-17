"""Capability registry for all external data sources.

Callers ask *what they need* ("rainfall for this bbox", "fire detections",
"newest Sentinel-1 pass") and the registry picks the source whose declared
capabilities and current status fit, instead of a hard-coded provider order.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from .base import Source, Status
from .ttlcache import TTLCache


@lru_cache(maxsize=1)
def source_cache() -> TTLCache:
    data = Path(os.getenv("AEQE_DATA_DIR", "./data"))
    return TTLCache(data / "sources.sqlite")


def all_sources() -> list[Source]:
    from .copernicus import copernicus
    from .earthdata import earthdata
    from .earthengine import earth_engine
    from .firms import firms
    from .openmeteo import open_meteo
    from .planetary import planetary

    return [planetary(), copernicus(), earth_engine(), firms(), earthdata(), open_meteo()]


def get(source_id: str) -> Source:
    for s in all_sources():
        if s.id == source_id:
            return s
    raise KeyError(source_id)


def for_kind(kind: str) -> list[Source]:
    """Sources declaring a capability of ``kind``, best status first, unusable ones dropped."""
    from .base import RANK

    cands = [s for s in all_sources() if any(c.kind == kind for c in s.capabilities) and s.usable]
    return sorted(cands, key=lambda s: -RANK.get(s._status, 0))


def status_report() -> list[dict]:
    return [s.status() for s in all_sources()]


def smoke_test_all() -> list[dict]:
    return [s.run_smoke_test() for s in all_sources()]


STATUS_HELP = {
    Status.NOT_CONFIGURED.value: "Not configured",
    Status.CONFIGURED.value: "Configured, not yet authenticated",
    Status.AUTHENTICATED.value: "Authenticated, data access unverified",
    Status.DISCOVERY_VERIFIED.value: "Catalogue / discovery verified",
    Status.RETRIEVAL_VERIFIED.value: "Live asset retrieval verified",
    Status.E2E_VERIFIED.value: "End-to-end workflow verified",
    Status.BLOCKED.value: "Blocked",
}
