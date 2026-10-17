"""Build the India district catalogue shipped with the engine.

Source: geoBoundaries gbOpen IND ADM1 + ADM2 (simplified), ODbL 1.0
https://www.geoboundaries.org/  — attribution is kept in the output file.

    python scripts/build_india_regions.py adm1.geojson adm2.geojson aeqe/data/india_districts.json

Each district gets its state from the ADM1 polygon containing a point on its
surface. Geometry is simplified again (~500 m) to keep the file small; that is
plenty for tiling at 0.01° and for drawing the outline on the map.
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.strtree import STRtree

SIMPLIFY_DEG = 0.005


def slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main(adm1_path: str, adm2_path: str, out_path: str) -> None:
    adm1 = json.loads(Path(adm1_path).read_text(encoding="utf-8"))["features"]
    adm2 = json.loads(Path(adm2_path).read_text(encoding="utf-8"))["features"]
    states = [(f["properties"]["shapeName"], shape(f["geometry"]).buffer(0)) for f in adm1]
    tree = STRtree([g for _, g in states])
    out, seen = [], set()
    for f in adm2:
        g = shape(f["geometry"]).buffer(0)
        if g.is_empty:
            continue
        p = g.representative_point()
        state = next((states[i][0] for i in tree.query(p) if states[i][1].contains(p)), "")
        name = f["properties"]["shapeName"]
        rid = f"in-{slug(state)}-{slug(name)}" if state else f"in-{slug(name)}"
        while rid in seen:
            rid += "-2"
        seen.add(rid)
        gs = g.simplify(SIMPLIFY_DEG, preserve_topology=True)
        geom = json.loads(json.dumps(mapping(gs)), parse_float=lambda x: round(float(x), 4))
        out.append({"id": rid, "name": name, "state": state, "bbox": [round(v, 4) for v in g.bounds],
                    "area_km2_approx": round(g.area * 111.32 ** 2 * abs(__import__("math").cos(__import__("math").radians(p.y))), 0),
                    "geometry": geom})
    out.sort(key=lambda r: (r["state"], r["name"]))
    doc = {"source": "geoBoundaries gbOpen IND ADM1/ADM2 (simplified), boundary year 2021",
           "license": "Open Data Commons Open Database License 1.0 (ODbL); © geoBoundaries contributors",
           "url": "https://www.geoboundaries.org/", "districts": out}
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    print(f"{len(out)} districts, {sum(1 for r in out if not r['state'])} without state -> {out_path}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
