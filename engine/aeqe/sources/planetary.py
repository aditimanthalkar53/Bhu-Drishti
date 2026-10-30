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
import os
from functools import lru_cache
from typing import Optional

from .base import Capability, Provenance, Source, SourceError, Status, redact

STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"


def _install_log_redaction() -> None:
    """odc/rasterio log failed asset URLs including their SAS signatures; strip them before any handler sees them."""
    import logging

    base = logging.getLogRecordFactory()
    if getattr(base, "_bhudrishti_redacting", False):
        return

    def factory(*a, **kw):
        rec = base(*a, **kw)
        if rec.name.startswith(("odc", "rasterio", "pystac", "urllib3")):
            try:
                rec.msg = redact(rec.getMessage())
                rec.args = None
            except Exception:  # noqa: BLE001
                pass
        return rec

    factory._bhudrishti_redacting = True  # type: ignore[attr-defined]
    logging.setLogRecordFactory(factory)


_install_log_redaction()


class PlanetarySource(Source):
    id = "planetary_computer"
    name = "Microsoft Planetary Computer"
    homepage = "https://planetarycomputer.microsoft.com/"
    requires = ()
    concurrency = int(os.getenv("AEQE_PC_CONCURRENCY", "16"))
    capabilities = [
        Capability("jrc-gsw", "landcover", "JRC Global Surface Water occurrence (permanent-water mask for radar flood detection)", "1984–2021 summary",
                   30, "static", "long-term occurrence, not the current water extent"),
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
        self._down_until = 0.0
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
                # pystac-client's default has no read timeout: a catalogue that accepts the connection but never answers
                # would block every query for minutes. Fail after ~25 s per request instead.
                from pystac_client.stac_api_io import StacApiIO
                io = StacApiIO(timeout=(float(os.getenv("AEQE_STAC_CONNECT_S", "8")), float(os.getenv("AEQE_STAC_READ_S", "25"))),
                               max_retries=1)
                self._client = pystac_client.Client.open(STAC_URL, modifier=planetary_computer.sign_inplace, stac_io=io)
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
        if time.time() < self._down_until:   # it just timed out: do not make every tile and query wait again
            raise SourceError(self.id, "unavailable", "Microsoft Planetary Computer is not responding right now; "
                              "it was tried moments ago. Try again in a minute (cached districts still work).")
        for attempt in range(3):
            try:
                with self._sem:
                    return list(self.client().search(**kw).items())
            except SourceError:
                raise
            except Exception as e:  # noqa: BLE001 — pystac wraps HTTP errors in several types
                last = e
                msg = str(e)
                if "timed out" in msg.lower() or "timeout" in msg.lower():
                    self._down_until = time.time() + float(os.getenv("AEQE_STAC_COOLDOWN_S", "60"))
                    break   # already waited for the timeout once; a second wait would only double the delay
                if "429" in msg or "503" in msg or "502" in msg or "Connection" in msg:
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

        last: Optional[Exception] = None
        items = fresh_signed(items)   # cached items carry the SAS token from search time; it expires, and GDAL then retries 403s for minutes
        for attempt in range(4):
            # last attempt: skip assets that keep failing (they become nodata = unobserved), instead of losing the tile
            strict = attempt < 3
            try:
                with self._sem:
                    ds = odc.stac.load(items, bands=bands, bbox=[float(v) for v in bbox], crs="EPSG:4326",
                                       resolution=resolution_deg, groupby=groupby, chunks=None, fail_on_error=strict)
                return ds
            except Exception as e:  # noqa: BLE001
                last = e
                msg = str(e)
                if ("403" in msg or "AuthenticationFailed" in msg or "Signature" in msg) and attempt == 0:
                    items = fresh_signed(items)   # sign() alone leaves an expired token in place, so strip it first
                    continue
                time.sleep(1.5 * (2 ** attempt))   # transient: throttling, truncated responses, 'Chunk and warp failed'
        err = SourceError(self.id, "unavailable", redact(f"COG read failed ({', '.join(bands)}): {type(last).__name__}: {str(last)[:300]}"))
        self.record_error(err)
        raise err

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



def fresh_signed(items: list) -> list:
    """Copies of ``items`` whose blob-storage hrefs carry a newly issued SAS token.

    ``planetary_computer.sign`` returns an href unchanged when it already has a token, even an expired one, so the
    old query string is removed first. The library caches tokens per container, so this costs no extra request
    while the token is still valid."""
    import planetary_computer
    from urllib.parse import urlsplit, urlunsplit

    out = []
    for it in items:
        c = it.clone()
        for a in c.assets.values():
            parts = urlsplit(a.href)
            if parts.netloc.endswith("blob.core.windows.net") and {"st", "se", "sp"} & set(q.split("=")[0] for q in parts.query.split("&")):
                a.href = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
        out.append(planetary_computer.sign(c))
    return out

@lru_cache(maxsize=1)
def planetary() -> PlanetarySource:
    return PlanetarySource()
