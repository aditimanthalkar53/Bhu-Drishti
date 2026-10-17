"""Open-Meteo — rainfall forecast and GloFAS river-discharge forecast (context only).

* Forecast API (``api.open-meteo.com``) — daily precipitation sum, next 7–16 days.
* Flood API (``flood-api.open-meteo.com``) — daily river discharge from the
  Copernicus GloFAS model for the nearest 5 km river cell, plus the ensemble
  spread where available.

Free for non-commercial use, no key. These are *model forecasts*, labelled as
such everywhere they appear; they never feed an AEQE estimate. GloFAS picks
the nearest model river cell to the point, which may not be the river the user
has in mind.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Optional

from .base import Capability, Provenance, Source, Status, http_request
from .ttlcache import TTLCache


class OpenMeteoSource(Source):
    id = "open_meteo"
    name = "Open-Meteo (forecast + GloFAS river discharge)"
    homepage = "https://open-meteo.com/"
    requires = ()
    capabilities = [
        Capability("forecast precipitation_sum", "forecast", "Daily rainfall forecast (blend of national weather models)",
                   "next 16 days", 11000, "updated hourly", "forecast, not observation"),
        Capability("GloFAS river_discharge", "forecast", "Daily river discharge forecast and reanalysis (Copernicus GloFAS)",
                   "1984–present + 30-day forecast", 5000, "daily", "nearest model river cell; ~5 km grid; not CWC gauge data"),
    ]

    def __init__(self, cache: Optional[TTLCache] = None):
        super().__init__()
        self.cache = cache or TTLCache(":memory:")

    def _get(self, url: str, params: dict) -> dict:
        ck = TTLCache.key("om", url, params)
        hit = self.cache.get(ck)
        if hit is not None:
            return hit
        with self._sem:
            j = http_request(self.id, "GET", url, params=params, timeout=30).json()
        self.cache.put(ck, j, 3 * 3600)
        return j

    def outlook(self, lat: float, lon: float, days: int = 7) -> dict:
        f = self._get("https://api.open-meteo.com/v1/forecast",
                      {"latitude": round(lat, 3), "longitude": round(lon, 3), "daily": "precipitation_sum",
                       "forecast_days": days, "timezone": "Asia/Kolkata"})
        q = self._get("https://flood-api.open-meteo.com/v1/flood",
                      {"latitude": round(lat, 3), "longitude": round(lon, 3),
                       "daily": "river_discharge,river_discharge_max", "past_days": 7, "forecast_days": days})
        rain = [{"date": d, "mm": v} for d, v in zip(f["daily"]["time"], f["daily"]["precipitation_sum"])]
        dis = [{"date": d, "m3s": v, "max_m3s": m} for d, v, m in
               zip(q["daily"]["time"], q["daily"]["river_discharge"], q["daily"].get("river_discharge_max", [None] * len(q["daily"]["time"])))]
        return {"point": {"lat": lat, "lon": lon}, "rain_forecast": rain,
                "rain_forecast_total_mm": round(sum(v["mm"] or 0 for v in rain), 1),
                "river_discharge": dis, "glofas_cell": {"lat": q.get("latitude"), "lon": q.get("longitude")},
                "provenance": [Provenance("open_meteo", "forecast precipitation_sum", asset="daily").to_json(),
                               Provenance("open_meteo", "GloFAS river_discharge", asset="daily").to_json()],
                "label": "MODEL FORECAST — not an observation"}

    def smoke_test(self) -> list[dict]:
        self._step("Forecast + GloFAS discharge (Barpeta)", lambda: {k: v for k, v in self.outlook(26.33, 91.0, 3).items()
                                                                    if k in ("rain_forecast_total_mm", "glofas_cell")},
                   on_ok=Status.RETRIEVAL_VERIFIED)
        return self._steps


@lru_cache(maxsize=1)
def open_meteo() -> OpenMeteoSource:
    from .registry import source_cache
    return OpenMeteoSource(source_cache())
