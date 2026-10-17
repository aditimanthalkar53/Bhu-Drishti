"""Typed intermediate representation (IR) for a compiled query.

The LLM (or the rule-based fallback) only ever produces a `QueryIR`. Everything
downstream — validation, planning, sampling, estimation — is deterministic code.
"""

from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class Task(str, Enum):
    AREA_FRACTION = "area_fraction"  # share of a known base area affected (e.g. flooded cropland %)
    TOTAL = "total"                  # total quantity over the AOI (e.g. km² of new built-up area)
    COUNT = "count"                  # number of objects (e.g. brick kilns)
    FIND_ALL = "find_all"            # locate every tile containing a target, with a recall target
    INSPECT = "inspect"              # exact per-tile answers on a small area (VQA / grounding)


class Target(str, Enum):
    FLOODED_CROPLAND = "flooded_cropland"
    NEW_BUILTUP = "new_builtup"
    BRICK_KILN = "brick_kiln"
    ACTIVE_FIRE = "active_fire"            # satellite thermal-anomaly detections (NASA FIRMS)
    BURNED_CROPLAND = "burned_cropland"    # burn-scar area on cropland (Sentinel-2 dNBR)


class Point(BaseModel):
    lon: float
    lat: float


class QueryIR(BaseModel):
    """A fully specified query. Units:

    * ``precision`` — for AREA_FRACTION, absolute half-width in percentage points
      (3.0 → ±3 pp). For TOTAL/COUNT, relative half-width in percent of the
      estimate (10.0 → ±10 %). For FIND_ALL, the recall target in percent.
    * ``confidence`` — two-sided confidence level, e.g. 0.95.
    * ``budget_seconds`` / ``budget_tiles`` — hard compute limits; whichever
      is reached first stops the run with the best interval so far.
    """

    task: Task
    target: Target
    region_id: str
    start: date
    end: date
    baseline_start: Optional[date] = None  # for change tasks: "before" window
    baseline_end: Optional[date] = None
    sensor: Literal["auto", "sentinel-1", "sentinel-2", "fusion"] = "auto"
    precision: float = Field(3.0, gt=0)
    confidence: float = Field(0.95, gt=0.5, lt=1.0)
    budget_seconds: float = Field(120.0, gt=0)
    budget_tiles: int = Field(1000, gt=0)
    seed: int = 7
    point: Optional[Point] = None          # for INSPECT
    radius_km: float = Field(2.0, gt=0, le=10)
    question: str = ""                     # the original natural-language text

    @field_validator("confidence")
    @classmethod
    def _conf(cls, v: float) -> float:
        return round(v, 4)

    @model_validator(mode="after")
    def _consistency(self) -> "QueryIR":
        if self.end < self.start:
            raise ValueError("end date is before start date")
        if self.task == Task.FIND_ALL and not (50 <= self.precision <= 99.5):
            raise ValueError("for find_all, precision is a recall target in percent (50–99.5)")
        if self.task == Task.INSPECT and self.point is None:
            raise ValueError("inspect queries need a point")
        return self


TASK_TARGETS: dict[Task, set[Target]] = {
    Task.AREA_FRACTION: {Target.FLOODED_CROPLAND, Target.BURNED_CROPLAND},
    Task.TOTAL: {Target.NEW_BUILTUP, Target.FLOODED_CROPLAND, Target.BURNED_CROPLAND},
    Task.COUNT: {Target.BRICK_KILN, Target.ACTIVE_FIRE},
    Task.FIND_ALL: {Target.BRICK_KILN, Target.NEW_BUILTUP, Target.FLOODED_CROPLAND, Target.ACTIVE_FIRE},
    Task.INSPECT: {Target.FLOODED_CROPLAND, Target.NEW_BUILTUP, Target.BRICK_KILN},
}

# Targets whose per-tile value is cheap and complete (a catalogue of detections),
# so the engine counts every tile exactly instead of sampling.
CENSUS_TARGETS = {Target.ACTIVE_FIRE}

# Targets measured on a cropland denominator (area_fraction = share of cropland)
CROPLAND_TARGETS = {Target.FLOODED_CROPLAND, Target.BURNED_CROPLAND}
