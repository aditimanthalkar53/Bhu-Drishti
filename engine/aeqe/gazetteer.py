"""Human names for points: "Ganak Kuchi Gaon", or "4 km south-west of Budrutop", instead of grid codes.

Source: the GeoNames list of populated places in India (download.geonames.org/export/dump/IN.zip, CC BY 4.0, about
550,000 villages, towns and cities). It is downloaded once (15 MB) into the engine's data folder and reduced to a small
table of name, latitude, longitude; after that naming works offline. Abandoned, historical and destroyed places are left
out, so nobody is sent towards a village that no longer exists. If the file cannot be obtained, naming is simply
unavailable and callers keep their own labels.
"""

from __future__ import annotations

import csv
import io
import math
import threading
import zipfile
from pathlib import Path
from typing import Callable, Optional

import httpx

SOURCE_URL = "https://download.geonames.org/export/dump/IN.zip"
CREDIT = "Place names: GeoNames (geonames.org), CC BY 4.0"
SKIP_CODES = {"PPLQ", "PPLH", "PPLW"}        # abandoned, historical, destroyed
NEAR_KM = 1.5                                 # a place this close is "the" place; further away the label gives distance and direction
MAX_KM = 25.0                                 # beyond this, no name is better than a misleading one
BUCKET = 0.1                                  # degrees per lookup bucket
_WINDS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    return 111.2 * math.hypot(lat2 - lat1, (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2)))


def _direction(from_lat: float, from_lon: float, to_lat: float, to_lon: float) -> str:
    """Compass direction of ``to`` as seen from ``from``."""
    ang = math.degrees(math.atan2((to_lon - from_lon) * math.cos(math.radians(from_lat)), to_lat - from_lat)) % 360
    return _WINDS[int((ang + 22.5) // 45) % 8]


class Gazetteer:
    def __init__(self, rows: list[tuple[str, float, float]]):
        self.rows = rows
        self.buckets: dict[tuple[int, int], list[int]] = {}
        for i, (_, lat, lon) in enumerate(rows):
            self.buckets.setdefault((math.floor(lat / BUCKET), math.floor(lon / BUCKET)), []).append(i)

    def nearest(self, lat: float, lon: float) -> Optional[tuple[str, float, float, float]]:
        """(name, lat, lon, km) of the nearest place within MAX_KM, searching rings of buckets outwards."""
        bi, bj = math.floor(lat / BUCKET), math.floor(lon / BUCKET)
        best: Optional[tuple[str, float, float, float]] = None
        max_ring = math.ceil(MAX_KM / (111.2 * BUCKET)) + 1
        for ring in range(max_ring + 1):
            for di in range(-ring, ring + 1):
                for dj in range(-ring, ring + 1):
                    if max(abs(di), abs(dj)) != ring:
                        continue
                    for i in self.buckets.get((bi + di, bj + dj), ()):
                        name, plat, plon = self.rows[i]
                        d = _km(lat, lon, plat, plon)
                        if best is None or d < best[3]:
                            best = (name, plat, plon, d)
            # anything in a further ring is at least `ring` buckets away
            if best is not None and best[3] <= ring * BUCKET * 111.2 * math.cos(math.radians(lat)):
                break
        return best if best is not None and best[3] <= MAX_KM else None

    def label(self, lat: float, lon: float) -> Optional[dict]:
        hit = self.nearest(lat, lon)
        if hit is None:
            return None
        name, plat, plon, d = hit
        if d <= NEAR_KM:
            text = name
            direction = None
        else:
            direction = _direction(plat, plon, lat, lon)
            text = f"{d:.0f} km {direction} of {name}"
        return {"label": text, "place": name, "km": round(d, 1), "direction": direction}


def parse_geonames(text_lines) -> list[tuple[str, float, float]]:
    """Rows of the GeoNames table (tab separated): keep populated places (feature class P) that still exist."""
    out = []
    for r in csv.reader(text_lines, delimiter="\t", quoting=csv.QUOTE_NONE):
        if len(r) < 8 or r[6] != "P" or r[7] in SKIP_CODES:
            continue
        try:
            out.append((r[1], float(r[4]), float(r[5])))
        except ValueError:
            continue
    return out


_cache: dict[str, Gazetteer] = {}
_lock = threading.Lock()


def load(data_dir: Path, get: Callable = httpx.get) -> Gazetteer:
    """The gazetteer, from the small table in the data folder, downloading and building it the first time. Raises when
    it cannot be obtained (no network on first use)."""
    key = str(data_dir)
    with _lock:
        if key in _cache:
            return _cache[key]
        table = data_dir / "geonames" / "IN_places.tsv"
        if not table.exists():
            resp = get(SOURCE_URL, timeout=300.0, follow_redirects=True)
            resp.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(resp.content)) as z, z.open("IN.txt") as f:
                rows = parse_geonames(io.TextIOWrapper(f, encoding="utf-8"))
            table.parent.mkdir(parents=True, exist_ok=True)
            tmp = table.with_suffix(".tmp")
            tmp.write_text("".join(f"{n}\t{a:.5f}\t{b:.5f}\n" for n, a, b in rows), encoding="utf-8")
            tmp.replace(table)
        rows = []
        with table.open(encoding="utf-8") as f:
            for line in f:
                n, a, b = line.rstrip("\n").split("\t")
                rows.append((n, float(a), float(b)))
        g = Gazetteer(rows)
        _cache[key] = g
        return g
