"""Satellite data discovery (STAC) and asset access.

Providers (all keyless):

* Element84 Earth Search — Sentinel-2 L2A cloud-optimised GeoTIFFs on AWS, with the BOA offset flag per scene.
* Microsoft Planetary Computer — Sentinel-1 RTC (terrain-corrected gamma0), JRC Global Surface Water, Copernicus
  DEM 30 m, ESA WorldCover. Assets need a short-lived anonymous SAS signature.

Synchronous on purpose (called from worker threads next to GDAL reads).
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

from ..sources.base import SourceError, http_request
from . import EOUnavailable

EARTH_SEARCH = "https://earth-search.aws.element84.com/v1/search"
PC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
PC_SIGN = "https://planetarycomputer.microsoft.com/api/sas/v1/sign"
TIMEOUT_S = 40.0
_SIGN_TTL_S = 20 * 60

_signed: dict[str, tuple[float, str]] = {}
_signed_lock = threading.Lock()


@dataclass(frozen=True)
class Scene:
    """One acquisition, with the asset hrefs a detector needs."""

    id: str
    collection: str
    provider: str
    platform: str
    acquired: datetime
    assets: dict[str, str]
    cloud_cover: float | None = None
    orbit_state: str | None = None
    relative_orbit: int | None = None
    boa_offset_applied: bool | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def metadata(self) -> dict[str, Any]:
        """Provenance block stored with every result."""
        return {
            "scene_id": self.id, "collection": self.collection, "provider": self.provider,
            "platform": self.platform, "acquired": self.acquired.isoformat(),
            "cloud_cover_pct": self.cloud_cover, "orbit_state": self.orbit_state,
            "relative_orbit": self.relative_orbit,
        }


def _post(source: str, url: str, body: dict[str, Any], what: str) -> dict[str, Any]:
    try:
        return http_request(source, "POST", url, json=body, timeout=TIMEOUT_S, retries=2).json()
    except SourceError as exc:
        if exc.kind == "timeout":
            raise EOUnavailable(f"{what} search timed out. Try again shortly.") from exc
        raise EOUnavailable(f"{what} search failed ({exc.kind}).") from exc


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def window(target: date, days: int) -> str:
    """STAC datetime interval of ±``days`` around ``target``, never in the future."""
    start = datetime.combine(target - timedelta(days=days), datetime.min.time(), UTC)
    end = min(datetime.combine(target + timedelta(days=days), datetime.max.time(), UTC), datetime.now(UTC))
    if end <= start:
        raise EOUnavailable("The requested date is in the future — no imagery exists yet.")
    return f"{start:%Y-%m-%dT%H:%M:%SZ}/{end:%Y-%m-%dT%H:%M:%SZ}"


def _bbox_list(bbox: dict[str, float]) -> list[float]:
    return [bbox["west"], bbox["south"], bbox["east"], bbox["north"]]


def search_sentinel2(bbox: dict[str, float], target: date, days: int = 25, max_cloud: float = 70.0) -> list[Scene]:
    """Sentinel-2 L2A scenes near ``target``, nearest in time first."""
    body = {
        "collections": ["sentinel-2-l2a"],
        "bbox": _bbox_list(bbox),
        "datetime": window(target, days),
        "limit": 100,
        "query": {"eo:cloud_cover": {"lt": max_cloud}},
    }
    scenes = []
    for f in _post("earth_search", EARTH_SEARCH, body, "Sentinel-2").get("features", []):
        p, a = f["properties"], f["assets"]
        needed = ("red", "green", "blue", "nir", "swir16", "scl")
        if not all(k in a for k in needed):
            continue
        scenes.append(Scene(
            id=f["id"], collection="sentinel-2-l2a", provider="Element84 Earth Search (AWS)",
            platform=str(p.get("platform", "sentinel-2")), acquired=_parse_time(p["datetime"]),
            assets={k: a[k]["href"] for k in needed},
            cloud_cover=p.get("eo:cloud_cover"),
            boa_offset_applied=p.get("earthsearch:boa_offset_applied"),
            extra={"mgrs": f"{p.get('mgrs:utm_zone', '')}{p.get('mgrs:latitude_band', '')}{p.get('mgrs:grid_square', '')}",
                   "processing_baseline": p.get("s2:processing_baseline")},
        ))
    return _nearest_first(scenes, target)


def search_sentinel1(bbox: dict[str, float], target: date, days: int = 12) -> list[Scene]:
    """Sentinel-1 RTC scenes (VV+VH) near ``target``, nearest in time first."""
    body = {
        "collections": ["sentinel-1-rtc"],
        "bbox": _bbox_list(bbox),
        "datetime": window(target, days),
        "limit": 100,
    }
    scenes = []
    for f in _post("planetary_computer", PC_STAC, body, "Sentinel-1").get("features", []):
        p, a = f["properties"], f["assets"]
        if "vv" not in a or "vh" not in a:
            continue
        scenes.append(Scene(
            id=f["id"], collection="sentinel-1-rtc", provider="Microsoft Planetary Computer",
            platform=str(p.get("platform", "sentinel-1")), acquired=_parse_time(p["datetime"]),
            assets={"vv": a["vv"]["href"], "vh": a["vh"]["href"]},
            orbit_state=p.get("sat:orbit_state"), relative_orbit=p.get("sat:relative_orbit"),
        ))
    return _nearest_first(scenes, target)


def _nearest_first(scenes: list[Scene], target: date) -> list[Scene]:
    mid = datetime.combine(target, datetime.min.time(), UTC) + timedelta(hours=12)
    return sorted(scenes, key=lambda s: abs((s.acquired - mid).total_seconds()))


def group_passes(scenes: list[Scene]) -> list[list[Scene]]:
    """Group Sentinel-1 slices of the same pass (same day + relative orbit).

    A pass is delivered as consecutive ~25 s slices; an area on a slice boundary needs both. The order of the input
    (nearest-first) is preserved between groups.
    """
    groups: dict[tuple[str, int | None], list[Scene]] = {}
    for s in scenes:
        groups.setdefault((s.acquired.strftime("%Y-%m-%d"), s.relative_orbit), []).append(s)
    return list(groups.values())


def ancillary_hrefs(collection: str, asset: str, bbox: dict[str, float]) -> list[str]:
    """Hrefs of a static Planetary Computer layer (DEM, surface water, land cover)."""
    body = {"collections": [collection], "bbox": _bbox_list(bbox), "limit": 32}
    feats = _post("planetary_computer", PC_STAC, body, collection).get("features", [])
    if collection == "esa-worldcover":   # keep the newest product only
        newest = max((f["properties"].get("start_datetime", "") for f in feats), default="")
        feats = [f for f in feats if f["properties"].get("start_datetime", "") == newest]
    return [f["assets"][asset]["href"] for f in feats if asset in f["assets"]]


def sign(href: str) -> str:
    """Return an openable URL: Planetary Computer blobs get a cached SAS signature."""
    if "blob.core.windows.net" not in href:
        return href
    with _signed_lock:
        hit = _signed.get(href)
    if hit and time.time() - hit[0] < _SIGN_TTL_S:
        return hit[1]
    try:
        signed = http_request("planetary_computer", "GET", PC_SIGN, params={"href": href}, timeout=TIMEOUT_S, retries=2).json()["href"]
    except (SourceError, KeyError, ValueError) as exc:
        raise EOUnavailable(f"Could not obtain data access from Planetary Computer ({type(exc).__name__}).") from exc
    with _signed_lock:
        _signed[href] = (time.time(), signed)
    return signed
