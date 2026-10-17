"""Copernicus Data Space Ecosystem — Sentinel Hub Catalog, Process and Statistical APIs.

Complementary to Planetary Computer, never mandatory:

* **Catalog** (STAC) — cross-checks Sentinel-1 availability and often lists a
  new GRD acquisition before the RTC product appears on Planetary Computer, so
  it drives the "newest pass" freshness indicator.
* **Statistical API** — server-side area statistics (e.g. share of pixels
  with VV below a water threshold, per acquisition day) without downloading
  imagery. Used as an independent region-level cross-check of the radar proxy.
* **Process API** — server-side rendering of a small raster (e.g. a VV water
  mask for one tile), used as a fallback oracle input when Planetary Computer
  has no RTC scene for the window.

Auth: OAuth2 client credentials (``CDSE_CLIENT_ID`` / ``CDSE_CLIENT_SECRET``).
Tokens last ~30 min; one is cached and reused by every request and refreshed
60 s before expiry (or once on a 401).

Quotas: the free tier has a monthly processing-unit (PU) allowance and a
per-minute rate limit. Requests are validated against the documented 2500 px
size limit and an *estimated* PU ledger (``CDSE_PU_BUDGET``, default 3000 per
calendar month for this deployment) so the app refuses work instead of
silently draining the account. The estimate follows the documented formula
(pixels / 512², ×bands/3, min 0.005 per request); it is not the billed amount.
"""

from __future__ import annotations

import os
import threading
import time
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Optional

import numpy as np

from .base import Capability, Provenance, Source, SourceError, Status, http_request

TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
SH = "https://sh.dataspace.copernicus.eu"
MAX_PX = 2500

S1_WATER_STATS = """//VERSION=3
function setup() {
  return { input: [{ bands: ["VV", "dataMask"] }],
           output: [{ id: "water", bands: 1, sampleType: "FLOAT32" }, { id: "dataMask", bands: 1 }] };
}
function evaluatePixel(s) {
  var db = 10 * Math.log(Math.max(s.VV, 1e-6)) / Math.LN10;
  return { water: [db < THRESHOLD ? 1 : 0], dataMask: [s.dataMask] };
}"""

S1_VV_TIFF = """//VERSION=3
function setup() { return { input: [{ bands: ["VV", "dataMask"] }], output: { bands: 2, sampleType: "FLOAT32" }, mosaicking: "ORBIT" }; }
function evaluatePixel(samples) {
  // minimum VV over passes in the window = "water in any pass"
  var m = 1e9, ok = 0;
  for (var i = 0; i < samples.length; i++) { if (samples[i].dataMask) { m = Math.min(m, samples[i].VV); ok = 1; } }
  return [ok ? m : 0, ok];
}"""

S1_PROC = {"backCoeff": "GAMMA0_TERRAIN", "orthorectify": True, "demInstance": "COPERNICUS_30"}


def estimate_pu(width: int, height: int, bands: int = 1, intervals: int = 1, float32: bool = False) -> float:
    pu = (width * height) / (512 * 512) * max(bands / 3, 1 / 3) * (2 if float32 else 1)
    return max(pu, 0.005) * max(intervals, 1)


def _iso(d: date, end: bool = False) -> str:
    return f"{d.isoformat()}T{'23:59:59' if end else '00:00:00'}Z"


class CopernicusSource(Source):
    id = "copernicus"
    name = "Copernicus Data Space Ecosystem (Sentinel Hub APIs)"
    homepage = "https://dataspace.copernicus.eu/"
    requires = ("CDSE_CLIENT_ID", "CDSE_CLIENT_SECRET")
    concurrency = 3
    capabilities = [
        Capability("sentinel-1-grd (catalog)", "catalog", "Sentinel-1 GRD acquisitions (STAC Catalog API)", "2014–present",
                   10, "often hours after acquisition", "discovery only; listing ≠ processed RTC product"),
        Capability("statistical-api", "statistics", "Server-side per-area statistics (e.g. VV water share per pass)",
                   "per request", 10, "seconds", "costs processing units; resolution/size limits apply"),
        Capability("process-api", "imagery", "Server-side rendering of small rasters (terrain-corrected γ0 VV)",
                   "per request", 10, "seconds", f"max {MAX_PX}×{MAX_PX} px per request; costs processing units"),
    ]

    def __init__(self):
        super().__init__()
        self._token: Optional[str] = None
        self._exp = 0.0
        self._tlock = threading.Lock()
        self._pu_lock = threading.Lock()
        self._pu: dict[str, float] = {}

    # -- auth
    def token(self, force: bool = False) -> str:
        if not self.configured()[0]:
            raise SourceError(self.id, "not_configured", self.configured()[1])
        with self._tlock:
            if force or not self._token or time.time() > self._exp - 60:
                r = http_request(self.id, "POST", TOKEN_URL, retries=2, timeout=30, data={
                    "grant_type": "client_credentials", "client_id": os.environ["CDSE_CLIENT_ID"],
                    "client_secret": os.environ["CDSE_CLIENT_SECRET"]})
                j = r.json()
                self._token, self._exp = j["access_token"], time.time() + float(j.get("expires_in", 600))
            return self._token

    def _headers(self) -> dict:
        return {"authorization": f"Bearer {self.token()}"}

    def _post(self, path: str, body: dict, accept: str = "application/json"):
        with self._sem:
            return http_request(self.id, "POST", SH + path, json=body, timeout=120,
                                headers={**self._headers(), "accept": accept},
                                on_auth_error=lambda: {"authorization": f"Bearer {self.token(force=True)}"})

    # -- quota ledger (estimated)
    @property
    def pu_budget(self) -> float:
        return float(os.getenv("CDSE_PU_BUDGET", "3000"))

    def _charge(self, pu: float) -> None:
        month = datetime.now(timezone.utc).strftime("%Y-%m")
        with self._pu_lock:
            used = self._pu.get(month, 0.0)
            if used + pu > self.pu_budget:
                raise SourceError(self.id, "quota", f"estimated processing units for {month} would exceed the "
                                                    f"configured budget ({used:.1f} + {pu:.2f} > {self.pu_budget:g}); raise CDSE_PU_BUDGET")
            self._pu[month] = used + pu

    def pu_used(self) -> dict:
        return dict(self._pu)

    # -- catalog
    def catalog_search(self, collection: str, bbox, start: date, end: date, limit: int = 100) -> list[dict]:
        out, next_token = [], None
        while True:
            body = {"collections": [collection], "bbox": [float(v) for v in bbox],
                    "datetime": f"{_iso(start)}/{_iso(end, True)}", "limit": min(limit, 100)}
            if next_token is not None:
                body["next"] = next_token
            j = self._post("/api/v1/catalog/1.0.0/search", body, accept="application/geo+json").json()
            out += j.get("features", [])
            next_token = j.get("context", {}).get("next")
            if next_token is None or len(out) >= limit:
                return out[:limit]

    def s1_acquisitions(self, bbox, start: date, end: date) -> list[dict]:
        feats = self.catalog_search("sentinel-1-grd", bbox, start, end)
        return [{"id": f["id"], "datetime": f["properties"].get("datetime"),
                 "orbit_state": f["properties"].get("sat:orbit_state"), "platform": f["properties"].get("platform")}
                for f in feats]

    def provenance(self, acq: list[dict], product: str = "sentinel-1-grd") -> list[dict]:
        return [Provenance("copernicus", product, a["id"], a["datetime"], a["datetime"], asset="VV",
                           resolution_m=10, url=f"{SH}/api/v1/catalog/1.0.0/collections/{product}/items/{a['id']}").to_json()
                for a in acq]

    # -- statistical API
    def s1_water_share(self, bbox, start: date, end: date, threshold_db: float = -18.0, res_deg: float = 0.0009) -> list[dict]:
        """Share of valid pixels with γ0 VV < threshold, per 1-day interval with data. Server-side."""
        w = int(round((bbox[2] - bbox[0]) / res_deg))
        h = int(round((bbox[3] - bbox[1]) / res_deg))
        if w > MAX_PX or h > MAX_PX:
            res_deg = max((bbox[2] - bbox[0]), (bbox[3] - bbox[1])) / MAX_PX
            w, h = int((bbox[2] - bbox[0]) / res_deg), int((bbox[3] - bbox[1]) / res_deg)
        days = (end - start).days + 1
        self._charge(estimate_pu(w, h, 1, intervals=days, float32=True))
        body = {
            "input": {"bounds": {"bbox": [float(v) for v in bbox], "properties": {"crs": "http://www.opengis.net/def/crs/EPSG/0/4326"}},
                      "data": [{"type": "sentinel-1-grd", "dataFilter": {"timeRange": {"from": _iso(start), "to": _iso(end, True)}},
                                "processing": S1_PROC}]},
            "aggregation": {"timeRange": {"from": _iso(start), "to": _iso(end, True)}, "aggregationInterval": {"of": "P1D"},
                            "evalscript": S1_WATER_STATS.replace("THRESHOLD", f"{threshold_db:.2f}"), "resx": res_deg, "resy": res_deg},
        }
        data = self._post("/api/v1/statistics", body).json().get("data", [])
        out = []
        for d in data:
            if "error" in d:
                continue
            st = d["outputs"]["water"]["bands"]["B0"]["stats"]
            valid = st.get("sampleCount", 0) - st.get("noDataCount", 0)
            if valid <= 0:
                continue
            out.append({"from": d["interval"]["from"], "to": d["interval"]["to"], "water_share": round(float(st["mean"]), 4),
                        "valid_pixels": int(valid), "resolution_deg": res_deg})
        return out

    # -- process API
    def s1_min_vv(self, bbox, start: date, end: date, res_deg: float = 0.0002) -> np.ndarray:
        """γ0 VV (linear), minimum over passes in the window, as a 2-D array (NaN where no data)."""
        w = max(1, int(round((bbox[2] - bbox[0]) / res_deg)))
        h = max(1, int(round((bbox[3] - bbox[1]) / res_deg)))
        if w > MAX_PX or h > MAX_PX:
            raise SourceError(self.id, "bad_request", f"{w}×{h} px exceeds the {MAX_PX} px Process API limit")
        self._charge(estimate_pu(w, h, 2, float32=True))
        body = {
            "input": {"bounds": {"bbox": [float(v) for v in bbox], "properties": {"crs": "http://www.opengis.net/def/crs/EPSG/0/4326"}},
                      "data": [{"type": "sentinel-1-grd", "dataFilter": {"timeRange": {"from": _iso(start), "to": _iso(end, True)}},
                                "processing": S1_PROC}]},
            "output": {"width": w, "height": h, "responses": [{"identifier": "default", "format": {"type": "image/tiff"}}]},
            "evalscript": S1_VV_TIFF,
        }
        r = self._post("/api/v1/process", body, accept="image/tiff")
        import io

        import rasterio

        with rasterio.open(io.BytesIO(r.content)) as src:
            arr = src.read().astype(float)
        vv, mask = arr[0], arr[1]
        vv[mask == 0] = np.nan
        return vv

    # -- smoke test
    def smoke_test(self) -> list[dict]:
        self._step("OAuth client-credentials token", lambda: {"token_cached_for_s": round(self._exp - time.time()) if self.token() else 0},
                   on_ok=Status.AUTHENTICATED)
        bbox = (90.95, 26.30, 91.05, 26.40)
        acq = self._step("Catalog search sentinel-1-grd (Barpeta, Jul 2024)",
                         lambda: self.s1_acquisitions(bbox, date(2024, 7, 1), date(2024, 7, 15)), on_ok=Status.DISCOVERY_VERIFIED)
        if acq:
            self._step("Statistical API: VV water share per pass",
                       lambda: self.s1_water_share(bbox, date(2024, 7, 1), date(2024, 7, 15), res_deg=0.002),
                       on_ok=Status.RETRIEVAL_VERIFIED)
        return self._steps

    def latest_s1(self, bbox, days: int = 30) -> Optional[dict]:
        end = date.today()
        acq = self.s1_acquisitions(bbox, end - timedelta(days=days), end)
        return max(acq, key=lambda a: a["datetime"] or "") if acq else None


@lru_cache(maxsize=1)
def copernicus() -> CopernicusSource:
    return CopernicusSource()
