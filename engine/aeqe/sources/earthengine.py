"""Google Earth Engine — AlphaEarth annual satellite embeddings as AEQE proxy features.

Dataset: ``GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL`` — one 64-band image (A00…A63)
per year at 10 m, each pixel a unit-length embedding summarising a year of
multi-sensor observations.

How AEQE uses it: per-tile mean embeddings, reduced to a few principal
components, become extra *cheap covariates* for the ridge proxy that powers
the stratification and the difference estimator. They improve the proxy's
correlation with the expensive model output and therefore the sample size
needed; they never enter the estimate as labels.

Scientific restriction: embeddings are NOT evidence of flooding, fire or
construction. They are annual, so they cannot see a two-week flood. The
estimator stays unbiased whatever their quality — a useless embedding only
costs efficiency, it cannot distort the answer — which is the property that
justifies using them at all.

Auth: service-account JSON (``GOOGLE_APPLICATION_CREDENTIALS``) and the Cloud
project (``GOOGLE_CLOUD_PROJECT_ID``). The project must be registered for Earth
Engine, the Earth Engine API enabled, and the service account must hold
``roles/serviceusage.serviceUsageConsumer`` plus an Earth Engine role (e.g.
``roles/earthengine.viewer``). Noncommercial use is free after registration.
"""

from __future__ import annotations

import json
import os
import threading
from functools import lru_cache
from pathlib import Path
from typing import Optional

import numpy as np

from .base import Capability, Source, SourceError, Status, redact

COLLECTION = "GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL"
BANDS = [f"A{i:02d}" for i in range(64)]
MAX_FEATURES_PER_CALL = 2000


def _key_path() -> Optional[Path]:
    p = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if not p:
        return None
    path = Path(p)
    if not path.is_absolute():
        # relative to repo root (docker-compose mounts engine/credentials at /run/secrets)
        for base in (Path.cwd(), Path(__file__).resolve().parents[3]):
            if (base / path).exists():
                return base / path
    return path


class EarthEngineSource(Source):
    id = "earth_engine"
    name = "Google Earth Engine — AlphaEarth embeddings"
    homepage = "https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_SATELLITE_EMBEDDING_V1_ANNUAL"
    requires = ("GOOGLE_CLOUD_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS")
    concurrency = 2
    capabilities = [
        Capability(COLLECTION, "embedding", "AlphaEarth 64-D annual embeddings (unit vectors)", "2017–latest full year", 10,
                   "annual", "proxy features only — not labels; annual, so blind to short events"),
    ]

    def __init__(self):
        super().__init__()
        self._ready = False
        self._lock = threading.Lock()

    def configured(self) -> tuple[bool, str]:
        ok, detail = super().configured()
        if not ok:
            return ok, detail
        kp = _key_path()
        if kp is None or not kp.exists():
            return False, "GOOGLE_APPLICATION_CREDENTIALS does not point to an existing file"
        try:
            import ee  # noqa: F401
        except ImportError:
            return False, "python package earthengine-api not installed"
        return True, "service-account key file present"

    def init(self):
        with self._lock:
            if self._ready:
                import ee
                return ee
            ok, detail = self.configured()
            if not ok:
                raise SourceError(self.id, "not_configured", detail)
            import ee

            kp = _key_path()
            try:
                sa = json.loads(kp.read_text())["client_email"]
                creds = ee.ServiceAccountCredentials(sa, str(kp))
                ee.Initialize(creds, project=os.environ["GOOGLE_CLOUD_PROJECT_ID"])
            except Exception as e:  # noqa: BLE001
                raise self._wrap(e, "initialise") from e
            self._ready = True
            return ee

    def _wrap(self, e: Exception, what: str) -> SourceError:
        msg = redact(f"{type(e).__name__}: {e}")
        low = msg.lower()
        if "permission" in low or "not registered" in low or "serviceusage" in low or "403" in low:
            kind = "forbidden"
        elif "quota" in low or "too many" in low or "429" in low:
            kind = "rate_limited"
        elif "not found" in low:
            kind = "not_found"
        else:
            kind = "unavailable"
        err = SourceError(self.id, kind, f"{what}: {msg[:400]}")
        self.record_error(err)
        if kind == "forbidden":
            self.mark(Status.BLOCKED, err.message)
        return err

    def latest_year(self) -> int:
        ee = self.init()
        try:
            t = ee.ImageCollection(COLLECTION).aggregate_max("system:time_start").getInfo()
        except Exception as e:  # noqa: BLE001
            raise self._wrap(e, "read collection metadata") from e
        from datetime import datetime, timezone
        return datetime.fromtimestamp(t / 1000, tz=timezone.utc).year

    def tile_embeddings(self, bboxes: np.ndarray, year: int, scale_m: int = 100) -> np.ndarray:
        """Mean embedding (N, 64) per tile bbox for ``year``. Rows with no data are NaN."""
        ee = self.init()
        img = ee.ImageCollection(COLLECTION).filterDate(f"{year}-01-01", f"{year + 1}-01-01").mosaic().select(BANDS)
        out = np.full((len(bboxes), 64), np.nan)
        for s in range(0, len(bboxes), MAX_FEATURES_PER_CALL):
            chunk = bboxes[s:s + MAX_FEATURES_PER_CALL]
            fc = ee.FeatureCollection([ee.Feature(ee.Geometry.Rectangle([float(v) for v in b]), {"i": int(s + j)})
                                       for j, b in enumerate(chunk)])
            try:
                with self._sem:
                    res = img.reduceRegions(collection=fc, reducer=ee.Reducer.mean(), scale=scale_m, tileScale=4).getInfo()
            except Exception as e:  # noqa: BLE001
                raise self._wrap(e, "reduceRegions") from e
            for f in res["features"]:
                p = f["properties"]
                if all(b in p and p[b] is not None for b in BANDS):
                    out[p["i"]] = [p[b] for b in BANDS]
        return out

    def smoke_test(self) -> list[dict]:
        self._step("Service-account authentication + Earth Engine initialise", lambda: (self.init(), "ok")[1],
                   on_ok=Status.AUTHENTICATED)
        y = self._step("AlphaEarth collection metadata (latest year)", self.latest_year, on_ok=Status.DISCOVERY_VERIFIED)
        bb = np.array([[90.95, 26.30, 90.96, 26.31], [90.96, 26.30, 90.97, 26.31]])
        self._step(f"reduceRegions mean embedding for 2 tiles ({y})",
                   lambda: {"finite_rows": int(np.isfinite(self.tile_embeddings(bb, y)).all(1).sum())},
                   on_ok=Status.RETRIEVAL_VERIFIED)
        return self._steps


def embedding_pcs(E: np.ndarray, k: int = 6) -> Optional[np.ndarray]:
    """Top-k principal components of per-tile embeddings; NaN rows get the mean (0)."""
    ok = np.isfinite(E).all(1)
    if ok.sum() < max(10, k + 2):
        return None
    mu = E[ok].mean(0)
    Z = np.where(ok[:, None], E, mu) - mu
    _, _, vt = np.linalg.svd(Z[ok], full_matrices=False)
    return Z @ vt[:k].T


@lru_cache(maxsize=1)
def earth_engine() -> EarthEngineSource:
    return EarthEngineSource()
