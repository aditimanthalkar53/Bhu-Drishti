"""NASA Earthdata — GPM IMERG rainfall and the MODIS NRT Global Flood Product.

Discovery uses the public CMR search API (no login). Downloads need an
Earthdata Login identity. Two supported ways, both backend-only:

* ``EARTHDATA_TOKEN`` — a user token generated at https://urs.earthdata.nasa.gov
  (Profile → Generate Token; valid 60 days), sent as ``Authorization: Bearer``.
* ``EARTHDATA_USERNAME`` + ``EARTHDATA_PASSWORD`` — exchanged for a token via the
  documented ``/api/users/find_or_create_token`` endpoint.

An Earthdata account is not a general JSON API key: each data centre must be
authorised once in the profile ("Applications → Approved"): NASA GESDISC DATA
ARCHIVE for IMERG and LANCE/LAADS for MODIS NRT.

**GPM IMERG V07, daily 0.1°** — Early (``GPM_3IMERGDE``, ~4 h latency), Late
(``GPM_3IMERGDL``, ~14 h) and Final (``GPM_3IMERGDF``, ~3.5 months, gauge
calibrated). The adapter picks the most finalised run that fully covers the
window and reads only the bbox via OPeNDAP (DAP4 constraint); if OPeNDAP fails
it downloads the granule and slices it locally. Units: mm/day. Rainfall is
supporting context for a flood question, never evidence that flooding happened.

**MODIS MCDWD_L3_NRT** (10°×10° tiles, ~250 m) — values (NASA flood service
legend): 0 insufficient data (cloud, gaps), 1 no water, 2 water matching the
reference (normal) water, 3 water beyond reference → possible flood. Cloud
makes monsoon coverage patchy, so the insufficient-data share is always
reported. NRT granules are only retained for a short rolling period.
"""

from __future__ import annotations

import io
import math
import os
import re
import tempfile
import threading
import time
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Optional

import numpy as np

from .base import Capability, Provenance, Source, SourceError, Status, http_request, redact
from .ttlcache import TTLCache

CMR = "https://cmr.earthdata.nasa.gov/search"
URS = "https://urs.earthdata.nasa.gov"
IMERG_RUNS = [("final", "GPM_3IMERGDF"), ("late", "GPM_3IMERGDL"), ("early", "GPM_3IMERGDE")]
IMERG_FILL = -9999.9
MCDWD = "MCDWD_L3_NRT"
MCDWD_LEGEND = {0: "insufficient data", 1: "no water", 2: "reference (normal) water", 3: "water beyond reference (possible flood)"}


def imerg_indices(bbox) -> tuple[int, int, int, int]:
    """IMERG 0.1° grid indices (lon from −179.95, lat from −89.95) covering bbox: (i0, i1, j0, j1) inclusive."""
    w, s, e, n = bbox
    i0 = max(0, int(math.floor((w + 180) / 0.1)))
    i1 = min(3599, int(math.floor((e + 180) / 0.1 - 1e-9)))
    j0 = max(0, int(math.floor((s + 90) / 0.1)))
    j1 = min(1799, int(math.floor((n + 90) / 0.1 - 1e-9)))
    return i0, max(i0, i1), j0, max(j0, j1)


def area_mean(precip: np.ndarray) -> Optional[float]:
    """Mean of valid (non-fill, non-negative) values; None if no valid cell."""
    v = precip[np.isfinite(precip) & (precip >= 0)]
    return float(v.mean()) if v.size else None


def mcdwd_tile_bounds(h: int, v: int) -> tuple[float, float, float, float]:
    return (-180 + 10 * h, 90 - 10 * (v + 1), -180 + 10 * (h + 1), 90 - 10 * v)


def mcdwd_summary(arr: np.ndarray, tile_bounds, bbox) -> dict:
    """Class shares of an MCDWD tile array inside bbox (rows north→south)."""
    w0, s0, e0, n0 = tile_bounds
    ny, nx = arr.shape
    c0 = max(0, int((bbox[0] - w0) / (e0 - w0) * nx)); c1 = min(nx, int(math.ceil((bbox[2] - w0) / (e0 - w0) * nx)))
    r0 = max(0, int((n0 - bbox[3]) / (n0 - s0) * ny)); r1 = min(ny, int(math.ceil((n0 - bbox[1]) / (n0 - s0) * ny)))
    sub = arr[r0:r1, c0:c1]
    tot = sub.size
    if tot == 0:
        return {"pixels": 0}
    counts = {MCDWD_LEGEND[k]: int((sub == k).sum()) for k in MCDWD_LEGEND}
    valid = tot - counts[MCDWD_LEGEND[0]] - int((~np.isin(sub, [0, 1, 2, 3])).sum())
    return {"pixels": int(tot), "counts": counts,
            "insufficient_data_share": round(counts[MCDWD_LEGEND[0]] / tot, 4),
            "flood_share_of_observed": round(counts[MCDWD_LEGEND[3]] / valid, 4) if valid else None}


class EarthdataSource(Source):
    id = "earthdata"
    name = "NASA Earthdata (GPM IMERG, MODIS NRT flood)"
    homepage = "https://www.earthdata.nasa.gov/"
    requires = ()  # token OR username/password — checked in configured()
    concurrency = 2
    capabilities = [
        Capability("GPM_3IMERGDE/DL/DF", "rainfall", "GPM IMERG V07 daily precipitation (Early / Late / Final runs)",
                   "2000–present", 11000, "Early ≈4 h, Late ≈14 h, Final ≈3.5 months",
                   "0.1° (~11 km) cells; satellite estimate, not gauge truth (Final is gauge-calibrated)"),
        Capability(MCDWD, "flood_aux", "MODIS/Aqua+Terra Global Flood Product L3 NRT (1/2/3-day composites)",
                   "rolling recent window only", 250, "≈3 h after the last overpass",
                   "optical: cloud means 'insufficient data'; supplementary to Sentinel-1"),
    ]

    def __init__(self, cache: Optional[TTLCache] = None):
        super().__init__()
        self.cache = cache or TTLCache(":memory:")
        self._token: Optional[str] = None
        self._tlock = threading.Lock()

    def configured(self) -> tuple[bool, str]:
        if os.getenv("EARTHDATA_TOKEN"):
            return True, "EARTHDATA_TOKEN present"
        if os.getenv("EARTHDATA_USERNAME") and os.getenv("EARTHDATA_PASSWORD"):
            return True, "EARTHDATA_USERNAME/PASSWORD present"
        return False, "missing EARTHDATA_TOKEN (or EARTHDATA_USERNAME + EARTHDATA_PASSWORD); CMR discovery still works"

    # -- auth
    def token(self) -> str:
        with self._tlock:
            if self._token:
                return self._token
            if os.getenv("EARTHDATA_TOKEN"):
                self._token = os.environ["EARTHDATA_TOKEN"].strip()
                return self._token
            if not self.configured()[0]:
                raise SourceError(self.id, "not_configured", self.configured()[1])
            r = http_request(self.id, "POST", f"{URS}/api/users/find_or_create_token", timeout=30, retries=1,
                             auth=(os.environ["EARTHDATA_USERNAME"], os.environ["EARTHDATA_PASSWORD"]))
            self._token = r.json()["access_token"]
            return self._token

    def _auth_get(self, url: str, timeout: float = 180):
        """GET with bearer token, following the URS/S3 redirect chain."""
        import httpx

        with self._sem:
            with httpx.Client(follow_redirects=True, timeout=timeout,
                              headers={"authorization": f"Bearer {self.token()}"}) as c:
                r = http_request(self.id, "GET", url, client=c, timeout=timeout, retries=2)
        ctype = r.headers.get("content-type", "")
        if "text/html" in ctype and (b"Earthdata Login" in r.content[:5000] or b"urs.earthdata" in r.content[:5000]):
            raise SourceError(self.id, "auth", "redirected to the Earthdata Login page — token invalid or the data "
                                               "centre application is not approved in your Earthdata profile")
        return r

    # -- discovery (public)
    def cmr_granules(self, short_name: str, start: date, end: date, bbox=None, limit: int = 200, newest_first: bool = False) -> list[dict]:
        ck = TTLCache.key("cmr", short_name, str(start), str(end), bbox, limit, newest_first)
        hit = self.cache.get(ck)
        if hit is not None:
            return hit
        params = {"short_name": short_name, "temporal": f"{start.isoformat()}T00:00:00Z,{end.isoformat()}T23:59:59Z",
                  "page_size": min(limit, 2000)}
        if bbox is not None:
            params["bounding_box"] = ",".join(f"{float(v):.4f}" for v in bbox)
        if newest_first:
            params["sort_key"] = "-start_date"
        r = http_request(self.id, "GET", f"{CMR}/granules.json", params=params, timeout=60)
        out = []
        for e in r.json().get("feed", {}).get("entry", []):
            links = e.get("links", [])
            data = next((l["href"] for l in links if l.get("rel", "").endswith("/data#") and l["href"].startswith("https")), None)
            od = next((l["href"] for l in links if "opendap" in l["href"] and l.get("rel", "").endswith("/service#")), None)
            out.append({"id": e.get("producer_granule_id") or e.get("title"), "title": e.get("title"),
                        "start": e.get("time_start"), "end": e.get("time_end"), "updated": e.get("updated"),
                        "data_url": data, "opendap_url": od})
        recent = (date.today() - end).days < 7
        self.cache.put(ck, out, 1800 if recent else 7 * 86400)
        return out

    # -- IMERG
    def imerg_pick_run(self, start: date, end: date) -> tuple[str, str, list[dict]]:
        days = (end - start).days + 1
        best = None
        for run, sn in IMERG_RUNS:
            g = self.cmr_granules(sn, start, end)
            if len(g) >= days:
                return run, sn, g
            if g and (best is None or len(g) > len(best[2])):
                best = (run, sn, g)
        if best is None:
            raise SourceError(self.id, "not_found", f"no IMERG daily granule for {start}…{end}")
        return best

    def imerg_rainfall(self, bbox, start: date, end: date) -> dict:
        """Area-mean daily rainfall (mm/day) per day plus the window total, for bbox."""
        run, sn, granules = self.imerg_pick_run(start, end)
        i0, i1, j0, j1 = imerg_indices(bbox)
        series, prov, errors = [], [], []
        for g in granules:
            ck = TTLCache.key("imerg", g["id"], i0, i1, j0, j1)
            v = self.cache.get(ck)
            if v is None:
                try:
                    v = self._imerg_value(g, i0, i1, j0, j1)
                except SourceError as e:
                    if e.kind in ("auth", "forbidden", "not_configured"):
                        raise
                    errors.append(e.message)
                    continue
                self.cache.put(ck, v, 30 * 86400 if run == "final" else 86400)
            day = (g["start"] or "")[:10]
            series.append({"date": day, "mm": None if v is None else round(v, 2)})
            prov.append(Provenance("earthdata", sn, g["id"], g["start"], g["end"], published=g["updated"],
                                   asset="precipitation", resolution_m=11000, url=g["opendap_url"] or g["data_url"]).to_json())
        vals = [s["mm"] for s in series if s["mm"] is not None]
        return {"run": run, "product": sn, "days_requested": (end - start).days + 1, "days_with_data": len(vals),
                "total_mm": round(sum(vals), 1) if vals else None, "max_day_mm": round(max(vals), 1) if vals else None,
                "series": sorted(series, key=lambda s: s["date"]), "provenance": prov, "errors": errors[:3],
                "grid_cells": (i1 - i0 + 1) * (j1 - j0 + 1)}

    def _imerg_value(self, g: dict, i0: int, i1: int, j0: int, j1: int) -> Optional[float]:
        import h5py

        content = None
        if g.get("opendap_url"):
            ce = f"/precipitation[0:1:0][{i0}:1:{i1}][{j0}:1:{j1}]"
            try:
                content = self._auth_get(f"{g['opendap_url']}.dap.nc4?dap4.ce={ce}").content
                sliced = True
            except SourceError as e:
                if e.kind == "auth":
                    raise
                content = None
        if content is None:
            if not g.get("data_url"):
                raise SourceError(self.id, "not_found", f"granule {g['id']} has no download link")
            content = self._auth_get(g["data_url"], timeout=300).content
            sliced = False
        with tempfile.NamedTemporaryFile(suffix=".nc4", delete=False) as f:
            f.write(content)
            path = f.name
        try:
            with h5py.File(path, "r") as h:
                ds = h["precipitation"] if "precipitation" in h else h["Grid/precipitation"]
                arr = ds[...] if sliced else ds[0:1, i0:i1 + 1, j0:j1 + 1]
                fill = ds.attrs.get("_FillValue", IMERG_FILL)
        except OSError as e:
            raise SourceError(self.id, "parse", f"could not read IMERG granule {g['id']}: {e}") from e
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
        arr = np.asarray(arr, dtype=float)
        arr[arr == float(np.asarray(fill).ravel()[0])] = np.nan
        return area_mean(arr)

    # -- MODIS NRT flood
    def mcdwd_granules(self, bbox, start: date, end: date) -> list[dict]:
        return self.cmr_granules(MCDWD, start, end, bbox=bbox, limit=200)

    def mcdwd_flood(self, bbox, start: date, end: date, layer: str = "2-Day") -> dict:
        gs = self.mcdwd_granules(bbox, start, end)
        if not gs:
            return {"available": False, "reason": f"no {MCDWD} granule for this window — NRT files are only kept for a "
                                                  "short rolling period, so past events are not covered"}
        days: dict[str, list[dict]] = {}
        prov = []
        for g in gs:
            m = re.search(r"\.h(\d{2})v(\d{2})\.", g["data_url"] or g["title"] or "")
            if not m or not g["data_url"]:
                continue
            h, v = int(m.group(1)), int(m.group(2))
            arr = self._mcdwd_array(g, layer)
            s = mcdwd_summary(arr, mcdwd_tile_bounds(h, v), bbox)
            days.setdefault((g["start"] or "")[:10], []).append(s)
            prov.append(Provenance("earthdata", MCDWD, g["id"], g["start"], g["end"], published=g["updated"],
                                   asset=f"Flood {layer} 250m", resolution_m=250, url=g["data_url"]).to_json())
        per_day = []
        for d, ss in sorted(days.items()):
            tot = sum(s.get("pixels", 0) for s in ss)
            if not tot:
                continue
            flood = sum(s["counts"][MCDWD_LEGEND[3]] for s in ss if "counts" in s)
            insuff = sum(s["counts"][MCDWD_LEGEND[0]] for s in ss if "counts" in s)
            obs = tot - insuff
            per_day.append({"date": d, "flood_share_of_observed": round(flood / obs, 4) if obs else None,
                            "insufficient_data_share": round(insuff / tot, 4)})
        return {"available": True, "layer": layer, "legend": MCDWD_LEGEND, "per_day": per_day, "provenance": prov}

    def _mcdwd_array(self, g: dict, layer: str) -> np.ndarray:
        r = self._auth_get(g["data_url"], timeout=300)
        with tempfile.NamedTemporaryFile(suffix=".hdf", delete=False) as f:
            f.write(r.content)
            path = f.name
        try:
            try:
                from pyhdf.SD import SD, SDC
            except ImportError as e:
                raise SourceError(self.id, "not_configured", "pyhdf not installed (needed to read HDF4 MCDWD tiles)") from e
            sd = SD(path, SDC.READ)
            names = list(sd.datasets().keys())
            name = next((n for n in names if layer.lower() in n.lower() and "cs" not in n.lower().split()), None) or \
                next((n for n in names if "flood" in n.lower()), None)
            if name is None:
                raise SourceError(self.id, "parse", f"no flood layer in {g['id']} (layers: {names[:6]})")
            arr = np.asarray(sd.select(name)[:])
            sd.end()
            return arr
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    # -- smoke test
    def run_smoke_test(self) -> dict:
        # discovery is public, so run the checks even without credentials
        self._steps = []
        self._status = Status.CONFIGURED if self.configured()[0] else Status.NOT_CONFIGURED
        try:
            self.smoke_test()
        except Exception as e:  # noqa: BLE001
            self.record_error(e)
        from .base import utcnow
        self._checked_at = utcnow()
        return self.status()

    def smoke_test(self) -> list[dict]:
        bbox = (90.8, 26.2, 91.4, 26.65)
        self._step("CMR discovery GPM_3IMERGDE (public)",
                   lambda: {"granules": len(self.cmr_granules("GPM_3IMERGDE", date(2024, 7, 1), date(2024, 7, 3)))},
                   on_ok=None)
        today = datetime.now(timezone.utc).date()
        self._step("CMR discovery MCDWD_L3_NRT (last 5 days)",
                   lambda: {"granules": len(self.mcdwd_granules(bbox, today - timedelta(days=5), today))}, on_ok=None)
        if not self.configured()[0]:
            self.mark(Status.NOT_CONFIGURED, "discovery works without login; downloads need EARTHDATA_TOKEN")
            return self._steps
        self._step("Earthdata Login token", lambda: bool(self.token()), on_ok=Status.AUTHENTICATED)
        self.mark(Status.DISCOVERY_VERIFIED, "CMR discovery")
        self._step("IMERG Early bbox subset (Barpeta, 1–3 Jul 2024)",
                   lambda: {k: v for k, v in self.imerg_rainfall(bbox, date(2024, 7, 1), date(2024, 7, 3)).items() if k in ("run", "total_mm", "days_with_data")},
                   on_ok=Status.RETRIEVAL_VERIFIED)
        return self._steps


@lru_cache(maxsize=1)
def earthdata() -> EarthdataSource:
    from .registry import source_cache
    return EarthdataSource(source_cache())
