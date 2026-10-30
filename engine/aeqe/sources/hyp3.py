"""NASA ASF: Sentinel-1 SLC search and HyP3 on-demand InSAR processing.

InSAR needs the phase of two complex (SLC) radar images, which Planetary Computer's RTC product does not keep, and
processing it takes more compute than this engine should spend. ASF's HyP3 service does it for free:

* ``search_slc`` — ASF's search API finds the acquisitions. No login.
* ``submit`` / ``job`` — HyP3 runs GAMMA on a pair and publishes displacement, coherence and DEM GeoTIFFs for 14 days.
  It needs an Earthdata Login (the same ``EARTHDATA_TOKEN`` as IMERG). Each account gets free monthly credits; a pair
  costs 10–15 and takes roughly 20–90 minutes.

Identical pairs reuse the existing job, so re-running an analysis does not spend credits again.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from typing import Any, Optional

from shapely.geometry import shape

from .base import Capability, Source, SourceError, Status, http_request

SEARCH_URL = "https://api.daac.asf.alaska.edu/services/search/param"
API = "https://hyp3-api.asf.alaska.edu"
MIN_COVER = 0.6            # share of the area both scenes must see
RUNNING = ("PENDING", "RUNNING")


@dataclass(frozen=True)
class SlcScene:
    name: str
    acquired: datetime
    path: int
    frame: int
    direction: str
    platform: str
    polarization: str
    footprint: Any          # shapely polygon

    def to_json(self) -> dict:
        return {"scene_id": self.name, "acquired": self.acquired.isoformat(), "relative_orbit": self.path, "frame": self.frame,
                "orbit_state": self.direction.lower(), "platform": self.platform, "polarization": self.polarization}


def parse_scenes(features: list[dict]) -> list[SlcScene]:
    out = []
    for f in features:
        p = f.get("properties") or {}
        try:
            out.append(SlcScene(p["sceneName"], datetime.fromisoformat(p["startTime"].replace("Z", "+00:00")).astimezone(UTC),
                                int(p["pathNumber"]), int(p["frameNumber"]), str(p.get("flightDirection", "")), str(p.get("platform", "")),
                                str(p.get("polarization", "")), shape(f["geometry"])))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def choose_pair(scenes: list[SlcScene], area, before: date, after: date) -> Optional[dict]:
    """The best (reference, secondary) pair: same track, both seeing the area, nearest the requested dates (pure).

    Scenes on another track see the ground from another geometry, so their phase cannot be compared."""
    best = None
    total = area.area or 1e-12
    for ref in scenes:
        for sec in scenes:
            if ref.acquired >= sec.acquired or ref.path != sec.path or ref.direction != sec.direction or ref.polarization != sec.polarization:
                continue
            cover = ref.footprint.intersection(sec.footprint).intersection(area).area / total
            if cover < MIN_COVER:
                continue
            miss = abs((ref.acquired.date() - before).days) + abs((sec.acquired.date() - after).days)
            # coverage first (in steps, so tiny differences do not outweigh the dates), then closeness to the dates asked for
            score = (round(cover, 1), -miss, -(sec.acquired - ref.acquired).days)
            if best is None or score > best[0]:
                best = (score, ref, sec, cover)
    if best is None:
        return None
    _, ref, sec, cover = best
    return {"reference": ref, "secondary": sec, "coverage": round(cover, 3), "baseline_days": (sec.acquired - ref.acquired).days}


def job_name(reference: str, secondary: str, looks: str) -> str:
    """Stable per pair and resolution: the name is how an earlier result is found again. HyP3 allows 100 characters."""
    stamp = lambda s: re.search(r"_(\d{8}T\d{6})_", s).group(1)  # noqa: E731
    return f"bd-{stamp(reference)}-{stamp(secondary)}-{reference[-4:]}{secondary[-4:]}-{looks}"


def product_paths(file_url: str, filename: str) -> dict[str, str]:
    """GDAL paths of the layers inside the published zip, read by range requests without downloading all of it."""
    base = re.sub(r"\.zip$", "", filename)
    return {k: f"/vsizip//vsicurl/{file_url}/{base}/{base}_{suffix}.tif"
            for k, suffix in {"los": "los_disp", "vertical": "vert_disp", "coherence": "corr", "dem": "dem"}.items()}


class Hyp3Source(Source):
    id = "hyp3"
    name = "NASA ASF HyP3 (on-demand InSAR)"
    homepage = "https://hyp3-docs.asf.alaska.edu/"
    capabilities = [
        Capability("INSAR_GAMMA", "deformation", "Line-of-sight displacement and coherence from a Sentinel-1 SLC pair", "2014–present, 12-day pairs",
                   40, "about 20–90 minutes per pair", "relative, single pair: atmosphere and decorrelation can mimic or hide movement; results kept 14 days"),
    ]

    def configured(self) -> tuple[bool, str]:
        from .earthdata import earthdata

        return earthdata().configured()

    def _auth(self) -> dict:
        from .earthdata import earthdata

        return {"Authorization": f"Bearer {earthdata().token()}"}

    def search_slc(self, area, start: date, end: date) -> list[SlcScene]:
        r = http_request(self.id, "GET", SEARCH_URL, timeout=60, retries=2, params={
            "platform": "Sentinel-1", "processingLevel": "SLC", "beamMode": "IW", "intersectsWith": area.envelope.wkt,
            "start": f"{start}T00:00:00Z", "end": f"{end}T23:59:59Z", "output": "geojson"})
        return parse_scenes(r.json().get("features", []))

    def user(self) -> dict:
        return http_request(self.id, "GET", f"{API}/user", headers=self._auth(), timeout=40, retries=2).json()

    def find(self, name: str) -> Optional[dict]:
        """An earlier job for this pair that is still running or whose files have not expired."""
        jobs = http_request(self.id, "GET", f"{API}/jobs", headers=self._auth(), params={"name": name}, timeout=40, retries=2).json().get("jobs", [])
        now = datetime.now(UTC)
        for j in sorted(jobs, key=lambda x: x.get("request_time", ""), reverse=True):
            if j.get("status_code") in RUNNING:
                return j
            if j.get("status_code") == "SUCCEEDED" and j.get("expiration_time"):
                if datetime.fromisoformat(j["expiration_time"].replace("Z", "+00:00")) - now > timedelta(hours=2):
                    return j
        return None

    def submit(self, reference: str, secondary: str, looks: str) -> dict:
        name = job_name(reference, secondary, looks)
        found = self.find(name)
        if found:
            return found
        body = {"jobs": [{"job_type": "INSAR_GAMMA", "name": name, "job_parameters": {
            "granules": [reference, secondary], "looks": looks, "include_displacement_maps": True, "include_dem": True}}]}
        return http_request(self.id, "POST", f"{API}/jobs", json=body, headers=self._auth(), timeout=60, retries=1).json()["jobs"][0]

    def job(self, job_id: str) -> dict:
        return http_request(self.id, "GET", f"{API}/jobs/{job_id}", headers=self._auth(), timeout=40, retries=3).json()

    def smoke_test(self) -> list[dict]:
        def account() -> dict:
            u = self.user()
            if u.get("application_status") != "APPROVED":
                raise SourceError(self.id, "forbidden", f"HyP3 access is {u.get('application_status')}: apply at {self.homepage}")
            return {"remaining_credits": u.get("remaining_credits")}

        self._step("HyP3 account and credits", account, on_ok=Status.AUTHENTICATED)
        return self._steps


@lru_cache(maxsize=1)
def hyp3() -> Hyp3Source:
    return Hyp3Source()
