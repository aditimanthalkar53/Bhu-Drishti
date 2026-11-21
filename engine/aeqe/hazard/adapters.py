"""Hazard adapters: one per independent product, all with the same interface.

``fetch(cells, bbox, start, end) -> list[HazardCell]``. Every value carries its own ``observed_at`` and ``latency_s``
(how long after the observation the data was available to us, when known) so the map can show real freshness per
source instead of claiming continuous coverage. Area-level products (one value for the whole box) say so.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Optional

from .grid import Cell, locate


@dataclass
class HazardCell:
    cell_id: str
    source: str
    observed_at: Optional[str]
    latency_s: Optional[float]
    value: Optional[float]
    unit: str

    def to_json(self) -> dict:
        return {"cell_id": self.cell_id, "source": self.source, "observed_at": self.observed_at, "latency_s": self.latency_s,
                "value": self.value, "unit": self.unit}


@dataclass
class LayerResult:
    source: str
    name: str
    state: str                      # ok | no_data | not_configured | error | timeout
    cells: list[HazardCell] = field(default_factory=list)
    observed_at: Optional[str] = None
    latency_s: Optional[float] = None
    note: str = ""
    area_level: bool = False
    kind: str = "observation"       # observation | forecast

    def to_json(self) -> dict:
        age = None
        if self.observed_at:
            try:
                t = datetime.fromisoformat(self.observed_at.replace("Z", "+00:00"))
                if t.tzinfo is None:
                    t = t.replace(tzinfo=timezone.utc)
                age = max(0.0, (datetime.now(timezone.utc) - t).total_seconds())
            except ValueError:
                age = None
        return {"id": self.source, "name": self.name, "state": self.state, "observed_at": self.observed_at, "age_s": age,
                "latency_s": self.latency_s, "note": self.note, "area_level": self.area_level, "kind": self.kind}


def _now() -> datetime:
    return datetime.now(timezone.utc)


class HazardAdapter:
    id: str = ""
    name: str = ""
    unit: str = ""
    area_level: bool = False
    kind: str = "observation"

    def configured(self) -> tuple[bool, str]:
        return True, "no key needed"

    def fetch(self, cells: list[Cell], bbox, start: date, end: date) -> list[HazardCell]:
        raise NotImplementedError

    def broadcast(self, cells: list[Cell], value: Optional[float], observed_at: Optional[str], latency_s: Optional[float]) -> list[HazardCell]:
        return [HazardCell(c.id, self.id, observed_at, latency_s, value, self.unit) for c in cells]


class FirmsAdapter(HazardAdapter):
    id, name, unit = "firms", "NASA FIRMS active fires (VIIRS / MODIS)", "detections"

    def configured(self):
        from ..sources.firms import firms
        return firms().configured()

    def fetch(self, cells, bbox, start, end):
        from ..sources.firms import firms
        dets, _prov = firms().detections(bbox, start, end)
        counts: dict[str, int] = {c.id: 0 for c in cells}
        newest: Optional[datetime] = None
        for d in dets:
            c = locate(cells, d["lat"], d["lon"])
            if c is not None:
                counts[c.id] += 1
            try:
                t = datetime.fromisoformat(f"{d['acq_date']}T{d['acq_time_utc']}:00+00:00")
                newest = t if newest is None or t > newest else newest
            except (KeyError, TypeError, ValueError):
                pass
        obs = newest.isoformat() if newest else None
        lat = (_now() - newest).total_seconds() if newest else None
        return [HazardCell(cid, self.id, obs, lat, float(n), self.unit) for cid, n in counts.items()]


class ImergAdapter(HazardAdapter):
    id, name, unit, area_level = "imerg", "NASA GPM IMERG rainfall (area mean)", "mm", True

    def configured(self):
        from ..sources.earthdata import earthdata
        return earthdata().configured()

    def fetch(self, cells, bbox, start, end):
        from ..sources.earthdata import earthdata
        r = earthdata().imerg_rainfall(bbox, start, end)
        last = max((s["date"] for s in r.get("series", []) if s.get("mm") is not None), default=None)
        obs = f"{last}T23:59:59+00:00" if last else None
        lat = (_now() - datetime.fromisoformat(obs)).total_seconds() if obs else None
        return self.broadcast(cells, r.get("total_mm"), obs, lat)


class ModisFloodAdapter(HazardAdapter):
    id, name, unit, area_level = "modis_flood", "MODIS NRT Global Flood Product (area share)", "share of observed land", True

    def configured(self):
        from ..sources.earthdata import earthdata
        return earthdata().configured()

    def fetch(self, cells, bbox, start, end):
        from ..sources.earthdata import earthdata
        r = earthdata().mcdwd_flood(bbox, start, end)
        days = [d for d in r.get("per_day", []) if d.get("flood_share_of_observed") is not None] if r.get("available") else []
        if not days:
            return []
        d = days[-1]
        obs = f"{d['date']}T23:59:59+00:00"
        return self.broadcast(cells, d["flood_share_of_observed"], obs, (_now() - datetime.fromisoformat(obs)).total_seconds())


def _sample_points(cells: list[Cell], k: int = 3) -> list[tuple[float, float]]:
    """A k x k set of points spread over the cells' extent (forecast APIs are per point)."""
    lats = [c.center[0] for c in cells]
    lons = [c.center[1] for c in cells]
    s, n, w, e = min(lats), max(lats), min(lons), max(lons)
    ks = 1 if len(cells) < 4 else k
    return [(s + (n - s) * (i + 0.5) / ks, w + (e - w) * (j + 0.5) / ks) for i in range(ks) for j in range(ks)]


def _nearest(points: list[tuple[float, float]], lat: float, lon: float) -> int:
    return min(range(len(points)), key=lambda i: (points[i][0] - lat) ** 2 + ((points[i][1] - lon) * math.cos(math.radians(lat))) ** 2)


class _OpenMeteoAdapter(HazardAdapter):
    kind = "forecast"

    def _outlooks(self, cells):
        from ..sources.openmeteo import open_meteo
        pts = _sample_points(cells)
        return pts, [open_meteo().outlook(lat, lon, 3) for lat, lon in pts]


class GlofasAdapter(_OpenMeteoAdapter):
    id, name, unit = "glofas", "GloFAS river discharge forecast (Open-Meteo)", "peak / last-7-day mean"

    def fetch(self, cells, bbox, start, end):
        pts, outs = self._outlooks(cells)
        today = _now().date().isoformat()
        ratios = []
        for o in outs:
            series = o.get("river_discharge") or []
            past = [d["m3s"] for d in series if d["date"] < today and d["m3s"] is not None]
            future = [d["m3s"] for d in series if d["date"] >= today and d["m3s"] is not None]
            base = sum(past) / len(past) if past else None
            ratios.append(round(max(future) / base, 3) if base and future else None)
        obs = f"{today}T00:00:00+00:00"
        return [HazardCell(c.id, self.id, obs, None, ratios[_nearest(pts, *c.center)], self.unit) for c in cells]


class RainForecastAdapter(_OpenMeteoAdapter):
    id, name, unit = "rain_forecast", "Rainfall forecast, next 3 days (Open-Meteo)", "mm"

    def fetch(self, cells, bbox, start, end):
        pts, outs = self._outlooks(cells)
        vals = [o.get("rain_forecast_total_mm") for o in outs]
        obs = _now().replace(minute=0, second=0, microsecond=0).isoformat()
        return [HazardCell(c.id, self.id, obs, None, vals[_nearest(pts, *c.center)], self.unit) for c in cells]


ADAPTERS: list[HazardAdapter] = [FirmsAdapter(), ImergAdapter(), ModisFloodAdapter(), GlofasAdapter(), RainForecastAdapter()]
