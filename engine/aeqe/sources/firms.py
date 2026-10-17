"""NASA FIRMS — active-fire / thermal-anomaly detections (VIIRS 375 m, MODIS 1 km).

API: ``/api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north}/{DAY_RANGE}/{DATE}``
with a DAY_RANGE limit (the docs say 1–10; the live API answered "Expects
[1..5]" in Oct 2026), so longer windows are split into chunks and the chunk
size adapts to the limit the API reports. ``/api/data_availability`` tells which date range each product
covers: near-real-time (NRT) products cover roughly the last two months,
standard-processing (SP) products the older archive. The adapter asks for both
where they overlap the window and removes duplicates.

A detection is a satellite pixel that was hot at overpass time. It is evidence
of a thermal anomaly — not proof of crop-residue burning, and never evidence
of who lit it. Confidence is normalised to low / nominal / high (VIIRS reports
l/n/h; MODIS 0–100, mapped with FIRMS' own 30/80 cut-offs) and the raw value is
kept.

The MAP_KEY is a secret and sits in the URL path, so every message from this
module is passed through ``redact``.
"""

from __future__ import annotations

import csv
import io
import os
import re
import time
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Optional

from .base import Capability, Provenance, Source, SourceError, Status, http_request, redact
from .ttlcache import TTLCache

BASE = "https://firms.modaps.eosdis.nasa.gov"
PRODUCTS = {
    "VIIRS_SNPP_NRT": ("VIIRS S-NPP", 375), "VIIRS_NOAA20_NRT": ("VIIRS NOAA-20", 375), "VIIRS_NOAA21_NRT": ("VIIRS NOAA-21", 375),
    "MODIS_NRT": ("MODIS Terra/Aqua", 1000),
    "VIIRS_SNPP_SP": ("VIIRS S-NPP", 375), "VIIRS_NOAA20_SP": ("VIIRS NOAA-20", 375), "MODIS_SP": ("MODIS Terra/Aqua", 1000),
}
DEFAULT_PRODUCTS = ("VIIRS_SNPP", "VIIRS_NOAA20", "VIIRS_NOAA21", "MODIS")


def norm_confidence(raw: str, product: str) -> str:
    r = (raw or "").strip().lower()
    if product.startswith("MODIS"):
        try:
            v = float(r)
        except ValueError:
            return "unknown"
        return "low" if v < 30 else "high" if v >= 80 else "nominal"
    return {"l": "low", "n": "nominal", "h": "high", "low": "low", "nominal": "nominal", "high": "high"}.get(r, "unknown")


def parse_csv(text: str, product: str) -> list[dict]:
    text = text.strip()
    if not text or text.lower().startswith(("invalid", "error")) or "," not in text.splitlines()[0]:
        if text and "invalid" in text.lower():
            raise SourceError("firms", "bad_request", redact(text[:200]))
        return []
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        try:
            lat, lon = float(row["latitude"]), float(row["longitude"])
        except (KeyError, ValueError):
            continue
        t = (row.get("acq_time") or "0000").zfill(4)
        out.append({
            "lat": lat, "lon": lon, "acq_date": row.get("acq_date"), "acq_time_utc": f"{t[:2]}:{t[2:]}",
            "satellite": row.get("satellite"), "instrument": row.get("instrument"), "product": product,
            "confidence": norm_confidence(row.get("confidence", ""), product), "confidence_raw": row.get("confidence"),
            "frp_mw": float(row["frp"]) if row.get("frp") not in (None, "") else None,
            "daynight": row.get("daynight"), "version": row.get("version"),
        })
    return out


class FirmsSource(Source):
    id = "firms"
    name = "NASA FIRMS (active fires)"
    homepage = "https://firms.modaps.eosdis.nasa.gov/api/"
    requires = ("NASA_FIRMS_MAP_KEY",)
    concurrency = 3
    capabilities = [
        Capability("VIIRS_*_NRT / MODIS_NRT", "fire", "Active-fire detections, near real time", "last ~2 months",
                   375, "≈3 h after overpass", "thermal anomaly ≠ cause; clouds hide fires; small/short fires missed"),
        Capability("VIIRS_*_SP / MODIS_SP", "fire", "Active-fire detections, standard processing (archive)",
                   "2000 (MODIS) / 2012 (VIIRS) – ~3 months ago", 375, "≈2–3 months", "same caveats"),
    ]

    def __init__(self, cache: Optional[TTLCache] = None):
        super().__init__()
        self.cache = cache or TTLCache(":memory:")
        self.max_days = 5          # the area API currently accepts 1..5 days (was 1..10); adapts if it changes
        self._avail: Optional[dict] = None
        self._avail_t = 0.0

    @property
    def key(self) -> str:
        k = os.getenv("NASA_FIRMS_MAP_KEY")
        if not k:
            raise SourceError(self.id, "not_configured", "NASA_FIRMS_MAP_KEY missing")
        return k

    def _get(self, path: str) -> str:
        with self._sem:
            r = http_request(self.id, "GET", BASE + path, timeout=90, retries=3)
        txt = r.text
        if "invalid map_key" in txt.lower() or "invalid key" in txt.lower():
            raise SourceError(self.id, "auth", "FIRMS rejected the MAP_KEY")
        if "exceeding" in txt.lower() and "transaction" in txt.lower():
            raise SourceError(self.id, "rate_limited", "FIRMS transaction limit reached (5000 per 10 min) — wait and retry")
        return txt

    def key_status(self) -> dict:
        import json
        return json.loads(self._get(f"/api/mapkey_status/?MAP_KEY={self.key}"))

    def availability(self) -> dict:
        """{product: (min_date, max_date)} from FIRMS' data_availability endpoint (cached 1 h)."""
        if self._avail is not None and time.time() - self._avail_t < 3600:
            return self._avail
        txt = self._get(f"/api/data_availability/csv/{self.key}/ALL")
        av = {}
        for row in csv.DictReader(io.StringIO(txt.strip())):
            try:
                av[row["data_id"]] = (date.fromisoformat(row["min_date"]), date.fromisoformat(row["max_date"]))
            except (KeyError, ValueError):
                continue
        self._avail, self._avail_t = av, time.time()
        return av

    def detections(self, bbox, start: date, end: date, products=DEFAULT_PRODUCTS) -> tuple[list[dict], list[dict]]:
        """All detections in ``bbox`` for [start, end]. Returns (detections, provenance)."""
        av = self.availability()
        w, s, e, n = (round(float(v), 4) for v in bbox)
        seen, out, prov = set(), [], []
        for base in products:
            for prod in (f"{base}_NRT", f"{base}_SP"):
                if prod not in av:
                    continue
                lo, hi = max(start, av[prod][0]), min(end, av[prod][1])
                d = lo
                while d <= hi:
                    days = min(self.max_days, (hi - d).days + 1)
                    try:
                        rows = self._chunk(prod, (w, s, e, n), d, days)
                    except SourceError as err:
                        m = re.search(r"Expects \[1\.\.(\d+)\]", err.message)
                        if err.kind != "bad_request" or not m or int(m.group(1)) >= days:
                            raise
                        self.max_days = int(m.group(1))   # the API's current limit
                        continue
                    for r in rows:
                        k = (round(r["lat"], 4), round(r["lon"], 4), r["acq_date"], r["acq_time_utc"], r["satellite"])
                        if k not in seen:
                            seen.add(k)
                            out.append(r)
                    prov.append(Provenance("firms", prod, None, d.isoformat(), (d + timedelta(days=days - 1)).isoformat(),
                                           asset="area csv", resolution_m=PRODUCTS.get(prod, ("", None))[1],
                                           url=f"{BASE}/api/area/csv/<map_key>/{prod}/{w},{s},{e},{n}/{days}/{d.isoformat()}",
                                           extra={"rows": len(rows)}).to_json())
                    d += timedelta(days=days)
        out.sort(key=lambda r: (r["acq_date"] or "", r["acq_time_utc"]))
        return out, prov

    def _chunk(self, prod: str, bbox, d: date, days: int) -> list[dict]:
        ck = TTLCache.key("firms", prod, bbox, d.isoformat(), days)
        hit = self.cache.get(ck)
        if hit is not None:
            return hit
        txt = self._get(f"/api/area/csv/{self.key}/{prod}/{','.join(map(str, bbox))}/{days}/{d.isoformat()}")
        rows = parse_csv(txt, prod)
        age_days = (datetime.now(timezone.utc).date() - (d + timedelta(days=days - 1))).days
        ttl = 1800 if age_days <= 2 else 6 * 3600 if prod.endswith("_NRT") else 7 * 86400
        self.cache.put(ck, rows, ttl)
        return rows

    def smoke_test(self) -> list[dict]:
        st = self._step("MAP_KEY status", self.key_status, on_ok=Status.AUTHENTICATED)
        if isinstance(st, dict) and st.get("current_transactions") is None and "transaction_limit" not in st:
            raise SourceError(self.id, "auth", "unexpected key status response")
        self._step("data_availability (which dates each product covers)",
                   lambda: {k: [str(a), str(b)] for k, (a, b) in self.availability().items() if k.startswith(("VIIRS_SNPP", "MODIS"))},
                   on_ok=Status.DISCOVERY_VERIFIED)
        av = self.availability()
        hi = av.get("VIIRS_SNPP_NRT", (None, date.today()))[1]
        # Punjab + Haryana, last 3 days of available NRT data
        self._step("area CSV VIIRS S-NPP NRT (Punjab, 3 days)",
                   lambda: {"rows": len(self._chunk("VIIRS_SNPP_NRT", (73.8, 29.5, 77.0, 32.5), hi - timedelta(days=2), 3)), "to": str(hi)},
                   on_ok=Status.RETRIEVAL_VERIFIED)
        return self._steps


@lru_cache(maxsize=1)
def firms() -> FirmsSource:
    from .registry import source_cache
    return FirmsSource(source_cache())
