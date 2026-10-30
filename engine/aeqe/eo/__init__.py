"""Change detection on real satellite scenes: discovery → aligned rasters → detection → vectors → exposure → risk.

AEQE answers "how much, across a whole district, within what interval" by sampling tiles. This package answers a
different question: "what changed between these two dates, and exactly where", by reading the area as one raster.
Ported from the Prithvi Drishti EO pipeline and adapted to Bhu-Drishti's districts and data sources.

  access.py      STAC search + asset signing (network)
  grid.py        analysis grid and aligned, windowed raster reads (network)
  indices.py     spectral indices and masks (pure numpy)
  detectors.py   detector interface, registry and the transparent baselines (pure)
  vector.py      mask → polygons, areas, point-in-extent (pure)
  population.py  population providers (network) + zonal sums (pure)
  assets.py      critical facilities from OpenStreetMap (network)
  forest.py      ForestGuard evidence: Hansen, FIRMS, protected areas, hotspots, fusion
  risk.py        hazard / exposure / vulnerability → risk (pure)
  render.py      PNG overlays for the map (pure)
  pipeline.py    orchestration for one analysis
  service.py     job queue and on-disk store

Raster IO is synchronous (GDAL), so analyses run in worker threads. Nothing here fabricates a value: a step that
cannot run raises ``EOUnavailable`` with a user-facing reason, or records the gap in the result.
"""


class EOUnavailable(Exception):
    """A required input or provider could not be obtained. The message is user-facing."""
