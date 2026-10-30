"""Keyless open datasets used by change detection (``aeqe.eo``).

* Element84 Earth Search — Sentinel-2 L2A COGs on AWS Open Data
* Hansen/UMD Global Forest Change — annual forest loss, public GeoTIFF tiles
* Meta HRSL + WorldPop — population rasters and statistics
* OpenStreetMap Overpass — critical facilities and protected areas

These adapters report status for the Data catalog; the reads themselves live in ``aeqe.eo``. None needs a key.
"""

from __future__ import annotations

from datetime import date, timedelta
from functools import lru_cache

import httpx

from .base import Capability, Source, Status, http_request

BARPETA = [90.95, 26.30, 91.00, 26.35]


class EarthSearchSource(Source):
    id = "earth_search"
    name = "Element84 Earth Search (Sentinel-2 on AWS)"
    homepage = "https://element84.com/earth-search/"
    capabilities = [
        Capability("sentinel-2-l2a", "imagery", "Sentinel-2 surface reflectance with per-scene BOA offset flag", "2015–present, ~5 day revisit",
                   10, "typically within a day", "optical: cloud hides the ground; change detection only"),
    ]

    def smoke_test(self) -> list[dict]:
        def search():
            end = date.today()
            body = {"collections": ["sentinel-2-l2a"], "bbox": BARPETA, "limit": 1,
                    "datetime": f"{end - timedelta(days=30)}T00:00:00Z/{end}T00:00:00Z"}
            return {"matched": len(http_request(self.id, "POST", "https://earth-search.aws.element84.com/v1/search", json=body, timeout=30).json().get("features", []))}

        self._step("STAC search sentinel-2-l2a (Barpeta, last 30 days)", search, on_ok=Status.DISCOVERY_VERIFIED)
        return self._steps


class HansenSource(Source):
    id = "hansen_gfc"
    name = "Hansen/UMD Global Forest Change"
    homepage = "https://glad.earthengine.app/view/global-forest-change"
    capabilities = [
        Capability("lossyear, treecover2000", "landcover", "Annual forest loss year and year-2000 canopy cover", "2001–2025, annual",
                   30, "yearly release", "annual, not an event date; context for forest-loss detections only"),
    ]

    def smoke_test(self) -> list[dict]:
        from ..eo.forest import hansen_tile_urls

        url = hansen_tile_urls("lossyear", {"south": 26.0, "north": 26.5, "west": 91.0, "east": 91.5})[0]
        self._step("Tile reachable (lossyear 30N 090E)", lambda: {"status": http_request(self.id, "HEAD", url, timeout=30, retries=1).status_code},
                   on_ok=Status.RETRIEVAL_VERIFIED)
        return self._steps


class PopulationSource(Source):
    id = "population"
    name = "Population (Meta HRSL + WorldPop)"
    homepage = "https://www.worldpop.org/"
    capabilities = [
        Capability("hrsl_general", "population", "People per ~30 m cell, summed inside a detected extent", "2018–2020 inputs",
                   30, "static", "modelled; not validated against a census here"),
        Capability("wpgppop", "population", "WorldPop statistics over the analysis rectangle (second opinion)", "2020",
                   100, "static", "modelled; the disagreement with HRSL is reported as a range"),
    ]

    def smoke_test(self) -> list[dict]:
        from ..eo.population import HRSL_VRT

        self._step("HRSL mosaic reachable", lambda: {"status": http_request(self.id, "HEAD", HRSL_VRT, timeout=30, retries=1).status_code},
                   on_ok=Status.RETRIEVAL_VERIFIED)
        return self._steps


class OverpassSource(Source):
    id = "overpass"
    name = "OpenStreetMap (Overpass API)"
    homepage = "https://overpass-api.de/"
    capabilities = [
        Capability("facilities, protected areas", "vector", "Hospitals, schools, substations…; parks and reserves", "current",
                   None, "minutes", "volunteer mapping: not a complete or authoritative inventory; public server rate-limits"),
    ]

    def smoke_test(self) -> list[dict]:
        def status():
            r = httpx.get("https://overpass-api.de/api/status", timeout=20, headers={"User-Agent": "BhuDrishti/0.2 (environmental monitoring)"})
            r.raise_for_status()
            return {"status": r.status_code}

        self._step("Server status", status, on_ok=Status.DISCOVERY_VERIFIED)
        return self._steps


@lru_cache(maxsize=1)
def earth_search() -> EarthSearchSource:
    return EarthSearchSource()


@lru_cache(maxsize=1)
def hansen_gfc() -> HansenSource:
    return HansenSource()


@lru_cache(maxsize=1)
def population_data() -> PopulationSource:
    return PopulationSource()


@lru_cache(maxsize=1)
def overpass() -> OverpassSource:
    return OverpassSource()
