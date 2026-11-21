"""A regular lon/lat grid over a bounding box. Cell ids are stable for a given grid origin and size."""

from __future__ import annotations

import math
from dataclasses import dataclass

MAX_CELLS = 2500


@dataclass(frozen=True)
class Cell:
    id: str
    row: int
    col: int
    bbox: tuple[float, float, float, float]   # west, south, east, north

    @property
    def center(self) -> tuple[float, float]:
        """(lat, lon) of the cell centre."""
        w, s, e, n = self.bbox
        return (s + n) / 2, (w + e) / 2

    def area_km2(self) -> float:
        w, s, e, n = self.bbox
        lat = math.radians((s + n) / 2)
        return abs(e - w) * 111.32 * math.cos(lat) * abs(n - s) * 110.57


def cell_id(row: int, col: int) -> str:
    return f"c{row:03d}_{col:03d}"


def make_grid(bbox, cell_deg: float = 0.05) -> list[Cell]:
    w, s, e, n = (float(v) for v in bbox)
    if not (w < e and s < n):
        raise ValueError("bbox must be west,south,east,north with west<east and south<north")
    if cell_deg <= 0:
        raise ValueError("cell size must be positive")
    cols = max(1, math.ceil((e - w) / cell_deg - 1e-9))
    rows = max(1, math.ceil((n - s) / cell_deg - 1e-9))
    if rows * cols > MAX_CELLS:
        raise ValueError(f"{rows * cols} cells is too many (max {MAX_CELLS}); use a larger cell size or a smaller area")
    out = []
    for r in range(rows):
        for c in range(cols):
            x0, y0 = w + c * cell_deg, s + r * cell_deg
            out.append(Cell(cell_id(r, c), r, c, (round(x0, 6), round(y0, 6), round(min(x0 + cell_deg, e), 6), round(min(y0 + cell_deg, n), 6))))
    return out


def locate(cells: list[Cell], lat: float, lon: float):
    for c in cells:
        w, s, e, n = c.bbox
        if w <= lon < e and s <= lat < n:
            return c
    return None
