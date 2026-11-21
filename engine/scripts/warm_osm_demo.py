"""Looks up well-known Indian structures in OpenStreetMap and keeps the answers in the engine's cache.

Run it once before a demo, from the folder the engine is started in (so it shares the engine's data folder):

    python engine/scripts/warm_osm_demo.py

Afterwards "Find in OpenStreetMap" answers instantly at these places (the public servers are slow and sometimes down).
It prints where each place is, so you know where to click on the Digital twins map.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aeqe.eo.twin import find_osm_assets  # noqa: E402

# (label, latitude, longitude): where to click. Fixed, because searching all of India by name times out on the public servers.
PLACES = [
    ("Saraighat Bridge, Guwahati", 26.1754, 91.6723),
    ("Howrah Bridge, Kolkata", 22.5851, 88.3468),
    ("Vidyasagar Setu, Kolkata", 22.5572, 88.3282),
    ("Pamban Bridge, Rameswaram", 9.2823, 79.2014),
    ("Hirakud Dam, Odisha", 21.5315, 83.8725),
    ("Bhakra Dam, Himachal Pradesh", 31.4107, 76.4337),
    ("Tehri Dam, Uttarakhand", 30.3778, 78.4804),
    ("Sardar Sarovar Dam, Gujarat", 21.8302, 73.7474),
    ("Mahatma Gandhi Road, Agra", 27.1767, 78.0081),
    ("Betul town, Madhya Pradesh", 21.9057, 77.9003),
]


def main() -> None:
    data = Path(os.getenv("AEQE_DATA_DIR", "./data")) / "osm"
    print(f"cache folder: {data.resolve()}")
    for label, lat, lon in PLACES:
        try:
            found = find_osm_assets(lat, lon, 500.0, cache_dir=data)
            top = ", ".join(f"{a['name'] or 'unnamed ' + a['assetType']} ({a['assetType']})" for a in found[:3])
            print(f"- {label}: click near {lat:.4f}, {lon:.4f}  ->  {len(found)} assets: {top}")
        except Exception as exc:  # noqa: BLE001 — the public servers fail often; carry on with the next place
            print(f"- {label}: failed ({type(exc).__name__}: {str(exc)[:80]})")
        time.sleep(3)


if __name__ == "__main__":
    main()
