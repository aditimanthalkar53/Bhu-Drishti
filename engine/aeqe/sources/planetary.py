"""Microsoft Planetary Computer — STAC discovery + cloud-optimised GeoTIFF reads.

Primary source for routine imagery, land cover and terrain:

* ``sentinel-1-rtc``  Sentinel-1 radiometrically terrain-corrected backscatter (VV/VH, 10 m)
* ``sentinel-2-l2a``  Sentinel-2 surface reflectance (10–20 m)
* ``esa-worldcover``  ESA WorldCover 10 m land cover (2020 v100, 2021 v200)
* ``cop-dem-glo-30``  Copernicus DEM GLO-30 (30 m)

Public catalogue, no API key. Assets live in Azure Blob Storage and need a
short-lived SAS token; ``planetary_computer.sign`` adds it. Tokens expire
(about an hour), so reads that fail with 403 re-sign the items once and retry.
Reads go through ``odc.stac.load`` which uses HTTP range requests on COGs and
only fetches the windows (and overview levels) covering the requested bbox.
"""

from __future__ import annotations

import threading
import time
from datetime import date
from functools import lru_cache
from typing import Optional

from .base import Capability, Provenance, Source, SourceError, Status, redact

STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"


class PlanetarySource(Source):
    id = "planetary_computer"
    name = "Microsoft Planetary Computer"
    homepage = "https://planetarycomputer.microsoft.com/"
    requires = ()
    concurrency = 8
    capabilities = [
        Capability("sentinel-1-rtc", "imagery", "Sentinel-1 RTC VV/VH backscatter, terrain corrected", "2014–present, 6–12 day revisit",
                   10, "typically hours to a few days after acquisition", "C-band SAR; sees through cloud; flood signal is low VV"),
        Capability("sentinel-2-l2a", "imagery", "Sentinel-2 L2A surface reflectance", "2015–present, ~5 day revisit", 10,
                   "hours to days", "optical: blocked by cloud, so monsoon scenes are often unusable"),
        Capability("esa-worldcover", "landcover", "ESA WorldCover land cover (cropland=40, built-up=50, water=80)", "2020, 2021", 10,
                   "static", "annual snapshot; not updated for the query year"),
        Capability("cop-dem-glo-30", "elevation", "Copernicus DEM GLO-30", "static (2011–2015 TanDEM-X)", 30, "static",
                   "surface model (includes buildings/trees); not a hydrological flood-risk model"),
    ]

    def __init__(self):
        super().__init__()
        self._client = None
        self._lock = threading.Lock()

    # -- clients
    def client(self):
        with self._lock:
            if self._client is None:
                try:
                    import planetary_computer
                    import pystac_client
                except ImportError as e:  # pragma: no cover - depends on optional deps
                    raise SourceError(self.id, "not_configured", f"install requirements-real.txt ({e.name} missing)") from e
                self._client = pystac_client.Client.open(STAC_URL, modifier=planetary_computer.sign_inplace)
            return self._client

    def configured(self) -> tuple[bool, str]:
        try:
            import odc.stac  # noqa: F401
            import planetary_computer  # noqa: F401
            import pystac_client  # noqa: F401
        except ImportError as e:
            return False, f"live-data libraries not importable: {e} (install engine/requirements-real.txt and system libraries)"
        return True, "public catalogue, no key needed"

    # -- discovery
    def search(self, collection: str, bbox, start: Optional[date] = None, end: Optional[date] = None,
               query: Optional[dict] = None, limit: int = 100) -> list:
        kw: dict = dict(collections=[collection], bbox=[float(v) for v in bbox], max_items=limit)
        if start and end:
            kw["datetime"] = f"{start.isoformat()}/{end.isoformat()}"
        if query:
            kw["query"] = query
        last: Optional[Exception] = None
        for attempt in range(3):
            try:
                with self._sem:
                    return list(self.client().search(**kw).items())
            except SourceError:
                raise
            except Exception as e:  # noqa: BLE001 — pystac wraps HTTP errors in several types
                last = e
                msg = str(e)
                if "429" in msg or "503" in msg or "502" in msg or "timed out" in msg.lower() or "Connection" in msg:
                    time.sleep(1.5 * (2 ** attempt))
                    continue
                break
        err = SourceError(self.id, "network" if last and "Connection" in str(last) else "unavailable",
                          redact(f"STAC search {collection} failed: {type(last).__name__}: {last}"))
        self.record_error(err)
        raise err

    # -- retrieval
    def load(self, items: list, bands: list[str], bbox, resolution_deg: float, groupby: str = "solar_day"):
        """Read bands for ``bbox`` on an EPSG:4326 grid. Re-signs once on expired SAS tokens."""
        if not items:
            raise SourceError(self.id, "not_found", "no STAC items to load")
        import odc.stac
        import planetary_computer

        for attempt in range(3):
            try:
                with self._sem:
                    ds = odc.stac.load(items, bands=bands, bbox=[float(v) for v in bbox], crs="EPSG:4326",
                                       resolution=resolution_deg, groupby=groupby, chunks=None, fail_on_error=True)
                return ds
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                if ("403" in msg or "AuthenticationFailed" in msg or "Signature" in msg) and attempt == 0:
                    items = [planetary_computer.sign(i) for i in items]   # fresh SAS token
                    continue
                if any(s in msg for s in ("429", "503", "502", "500", "timed out", "Timeout", "Connection")) and attempt < 2:
                    time.sleep(2.0 * (2 ** attempt))
                    continue
                err = SourceError(self.id, "unavailable", redact(f"COG read failed ({', '.join(bands)}): {type(e).__name__}: {msg[:300]}"))
                self.record_error(err)
                raise err from e
        raise SourceError(self.id, "unavailable", "COG read failed after retries")

    # -- products
    def worldcover_items(self, bbox) -> list:
        # v200 (2021) is the newer map; fall back to v100 (2020)
        items = self.search("esa-worldcover", bbox, date(2021, 1, 1), date(2021, 12, 31), limit=50)
        return items or self.search("esa-worldcover", bbox, date(2020, 1, 1), date(2020, 12, 31), limit=50)

    def worldcover(self, bbox, res: float, items: Optional[list] = None):
        items = items or self.worldcover_items(bbox)
        ds = self.load(items, ["map"], bbox, res)
        arr = ds["map"]
        return (arr.max("time") if "time" in arr.dims else arr).values

    def dem(self, bbox, res: float, items: Optional[list] = None):
        items = items or self.search("cop-dem-glo-30", bbox, limit=50)
        ds = self.load(items, ["data"], bbox, res)  # DEM tiles share one datetime → mosaicked
        arr = ds["data"]
        return (arr.max("time") if "time" in arr.dims else arr).values.astype(float)

    @staticmethod
    def provenance(items: list, product: str, asset: str, resolution_m: float) -> list[dict]:
        out = []
        for i in items:
            p = i.properties
            out.append(Provenance(
                source="planetary_computer", product=product, item_id=i.id,
                acquired_start=str(p.get("start_datetime") or p.get("datetime")),
                acquired_end=str(p.get("end_datetime") or p.get("datetime")),
                published=str(p.get("created") or "") or None, asset=asset, resolution_m=resolution_m,
                url=f"{STAC_URL}/collections/{i.collection_id}/items/{i.id}",
                extra={k: p[k] for k in ("platform", "sat:orbit_state", "sat:relative_orbit", "eo:cloud_cover",
                                         "s1:instrument_configuration", "sar:polarizations") if k in p},
            ).to_json())
        return out

    # -- smoke test
    def smoke_test(self) -> list[dict]:
        bbox = (90.95, 26.30, 91.00, 26.35)
        items = self._step("STAC search sentinel-1-rtc (Barpeta, Jul 2024)",
                           lambda: self.search("sentinel-1-rtc", bbox, date(2024, 7, 1), date(2024, 7, 15), limit=5),
                           on_ok=Status.DISCOVERY_VERIFIED)
        if not items:
            self.mark(Status.DISCOVERY_VERIFIED, "catalogue reachable but no scene in the test window")
            return self._steps
        import numpy as np

        def read():
            ds = self.load(items[:1], ["vv"], bbox, 0.002)
            v = ds["vv"].values
            return {"item": items[0].id, "shape": list(v.shape), "finite_fraction": round(float(np.isfinite(v).mean()), 3)}

        self._step("COG read Sentinel-1 VV window (signed SAS)", read, on_ok=Status.RETRIEVAL_VERIFIED)
        self._step("COG read ESA WorldCover window",
                   lambda: {"shape": list(self.worldcover(bbox, 0.002).shape)}, on_ok=Status.RETRIEVAL_VERIFIED)
        self._step("COG read Copernicus DEM window",
                   lambda: {"shape": list(self.dem(bbox, 0.002).shape)}, on_ok=Status.RETRIEVAL_VERIFIED)
        return self._steps


@lru_cache(maxsize=1)
def planetary() -> PlanetarySource:
    return PlanetarySource()
