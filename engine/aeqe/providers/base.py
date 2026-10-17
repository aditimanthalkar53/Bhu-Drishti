"""Data-provider and oracle interfaces.

A *provider* knows about regions, how to discretise an area of interest into a
tile universe, which scenes exist for a time window, and which specialist
models (oracles) can label a tile. The engine never talks to STAC or a model
directly — only through these interfaces — so the simulated world used for the
offline demo and the Planetary Computer adapter are interchangeable.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional

import numpy as np

from ..ir import QueryIR, Target


@dataclass
class Region:
    id: str
    name: str
    bbox: tuple[float, float, float, float]  # minx, miny, maxx, maxy (EPSG:4326)
    geometry: dict  # GeoJSON geometry
    simulated: bool
    description: str = ""

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "bbox": list(self.bbox),
            "geometry": self.geometry,
            "simulated": self.simulated,
            "description": self.description,
        }


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    blocking: bool = True

    def to_json(self) -> dict:
        return {"name": self.name, "ok": self.ok, "detail": self.detail, "blocking": self.blocking}


@dataclass
class TileUniverse:
    """The population the estimator reasons about.

    Arrays are aligned: element ``i`` of every array describes ``tile_ids[i]``.

    * ``base_km2`` — known denominator per tile (e.g. cropland area from a
      land-cover map). For tasks with no denominator it is the tile area.
    * ``features`` — cheap per-tile covariates (embedding PCs, coarse event
      proxy, prototype similarity...). Used by the proxy model.
    * ``score0`` — the initial heuristic relevance score used to build strata.
    """

    region_id: str
    tile_ids: list[str]
    bboxes: np.ndarray            # (N, 4)
    area_km2: np.ndarray          # (N,)
    base_km2: np.ndarray          # (N,)
    features: np.ndarray          # (N, p)
    feature_names: list[str]
    score0: np.ndarray            # (N,)
    proxy_description: str
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def n(self) -> int:
        return len(self.tile_ids)

    def geojson(self, idx: int, properties: Optional[dict] = None) -> dict:
        minx, miny, maxx, maxy = (float(v) for v in self.bboxes[idx])
        return {
            "type": "Feature",
            "id": self.tile_ids[idx],
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]],
            },
            "properties": {"tile_id": self.tile_ids[idx], **(properties or {})},
        }


@dataclass
class OracleOutput:
    value: float                    # per-tile quantity (km², count, 0/1...)
    detail: dict[str, Any] = field(default_factory=dict)


class Oracle(ABC):
    """An expensive specialist model that labels one tile."""

    name: str
    model_version: str
    sensor: str
    unit: str
    description: str

    @abstractmethod
    def run(self, universe: TileUniverse, idx: int, ir: QueryIR) -> OracleOutput: ...

    def params_key(self, ir: QueryIR) -> str:
        """Parameters that change the oracle's output (part of the cache key)."""
        return ""

    def to_json(self) -> dict:
        return {
            "name": self.name,
            "model_version": self.model_version,
            "sensor": self.sensor,
            "unit": self.unit,
            "description": self.description,
        }


class Provider(ABC):
    name: str

    @abstractmethod
    def regions(self) -> list[Region]: ...

    def region(self, region_id: str) -> Optional[Region]:
        return next((r for r in self.regions() if r.id == region_id), None)

    @abstractmethod
    def check_inputs(self, ir: QueryIR) -> list[Check]:
        """Data-availability and feasibility checks (scenes, cloud cover...)."""

    @abstractmethod
    def choose_sensor(self, ir: QueryIR) -> tuple[str, str]:
        """Return (sensor, reason) for this query."""

    @abstractmethod
    def universe(self, ir: QueryIR) -> TileUniverse: ...

    @abstractmethod
    def oracle(self, ir: QueryIR, sensor: str) -> Oracle: ...

    @abstractmethod
    def scene_key(self, ir: QueryIR, sensor: str) -> str:
        """Identifier of the imagery an oracle result depends on (cache key part).

        When a new acquisition lands for the window, this key changes and
        previously cached results for the old scenes are simply not reused.
        """

    def ground_truth(self, ir: QueryIR) -> Optional[np.ndarray]:
        """Per-tile *reality* (only the simulator knows this). Optional."""
        return None

    def supports(self, target: Target) -> bool:
        return True
