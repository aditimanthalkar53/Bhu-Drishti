"""Export per-tile AlphaEarth (Google Satellite Embedding V1) vectors for a region.

Produces a Parquet file with columns lon, lat, emb_0 … emb_63 (tile centres on
the engine's 0.01° grid) that the real-data provider reads via AEQE_EMBEDDINGS.

Requires a Google Earth Engine account:
    pip install earthengine-api pandas pyarrow
    earthengine authenticate
    python scripts/export_alphaearth.py --bbox 90.8 26.2 91.4 26.65 --year 2024 --out data/emb_barpeta_2024.parquet

Dataset: GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL — 64-band, 10 m, unit-length
embeddings (bands A00–A63), CC BY 4.0. Tile vectors are the mean over each
~1 km tile, re-normalised.
"""

from __future__ import annotations

import argparse
import math

import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", nargs=4, type=float, required=True, metavar=("MINX", "MINY", "MAXX", "MAXY"))
    ap.add_argument("--year", type=int, default=2024)
    ap.add_argument("--tile", type=float, default=0.01)
    ap.add_argument("--project", default=None, help="Earth Engine cloud project id")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    import ee
    import pandas as pd

    ee.Initialize(project=a.project)
    minx, miny, maxx, maxy = a.bbox
    region = ee.Geometry.Rectangle([minx, miny, maxx, maxy])
    img = (ee.ImageCollection("GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL")
           .filterDate(f"{a.year}-01-01", f"{a.year + 1}-01-01").filterBounds(region).mosaic())

    nx = math.ceil((maxx - minx) / a.tile)
    ny = math.ceil((maxy - miny) / a.tile)
    feats = []
    for r in range(ny):
        for c in range(nx):
            x0, y0 = minx + c * a.tile, maxy - (r + 1) * a.tile
            feats.append(ee.Feature(ee.Geometry.Rectangle([x0, y0, x0 + a.tile, y0 + a.tile]),
                                    {"lon": x0 + a.tile / 2, "lat": y0 + a.tile / 2}))
    rows = []
    for i in range(0, len(feats), 500):  # Earth Engine request size limits
        fc = img.reduceRegions(ee.FeatureCollection(feats[i:i + 500]), ee.Reducer.mean(), scale=10)
        for f in fc.getInfo()["features"]:
            p = f["properties"]
            v = np.array([p.get(f"A{k:02d}", np.nan) for k in range(64)], dtype=float)
            if np.all(np.isfinite(v)):
                v = v / (np.linalg.norm(v) + 1e-12)
                rows.append({"lon": p["lon"], "lat": p["lat"], **{f"emb_{k}": v[k] for k in range(64)}})
        print(f"{min(i + 500, len(feats))}/{len(feats)} tiles", flush=True)
    pd.DataFrame(rows).to_parquet(a.out, index=False)
    print(f"wrote {len(rows)} tile embeddings → {a.out}")


if __name__ == "__main__":
    main()
