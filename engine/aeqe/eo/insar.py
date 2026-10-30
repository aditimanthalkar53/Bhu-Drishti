"""Ground deformation from one Sentinel-1 interferogram (processed by NASA ASF HyP3).

What a result does and does not say:

* Displacement is along the radar's line of sight, not vertical. The vertical figure assumes no horizontal movement.
* It is relative: the reference is the median of coherent ground just outside the area, so only differences mean anything.
* One pair cannot separate movement from atmosphere. A signal that follows elevation is flagged, not removed.
* Where the ground changed too much between the images (vegetation, snow, fast movement), coherence is lost and nothing
  can be said. "Not detected" only covers the coherent pixels.
* Movement is a reason to inspect, never proof that a structure is damaged.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
from rasterio.enums import Resampling

from . import indices as ix
from .detectors import ModelMetadata, min_patch_pixels
from .grid import Grid, make_grid, read_band

COHERENCE_MIN = 0.3
MIN_SIGNAL_MM = 15.0         # below this one C-band pair cannot be told from atmosphere
NOISE_SIGMAS = 2.5
MIN_RING_PIXELS = 200
MIN_COHERENT_SHARE = 0.4
DEM_CORRELATION_MAX = 0.5
LONG_BASELINE_DAYS = 48
MARGIN_DEG = 0.1             # about 10 km of surrounding ground for the reference
SMALL_AREA_DEG = 0.3

METADATA = ModelMetadata(
    id="s1-insar-hyp3", name="Sentinel-1 InSAR line-of-sight displacement (ASF HyP3)", version="1.0.0",
    kind="baseline", modality="C-band SAR phase, Sentinel-1 SLC pair, GAMMA processing by NASA ASF",
    inputs=("two SLC acquisitions on the same track", "coherence", "Copernicus DEM"),
    output="possible ground-movement mask + relative line-of-sight displacement field (mm)",
    method=("Unwrapped interferometric phase converted to line-of-sight displacement by HyP3. Pixels below 0.3 coherence "
            "are dropped, the median of coherent ground around the area is taken as zero, and movement is a patch beyond "
            "both 15 mm and 2.5× the noise measured on that surrounding ground."),
    parameters={"coherence_min": COHERENCE_MIN, "min_signal_mm": MIN_SIGNAL_MM, "noise_sigmas": NOISE_SIGMAS,
                "reference_margin_deg": MARGIN_DEG, "threshold_range": [0.75, 1.5]},
    limitations=(
        "A movement signal is a reason for a field inspection. It does not show that a road, bridge or building is damaged.",
        "Line of sight, not vertical: the vertical figure assumes the ground moved only up or down.",
        "A single pair cannot separate ground movement from atmospheric delay, which can reach centimetres in mountains.",
        "Relative to the surrounding ground: if that ground also moved, the figure is wrong by that amount.",
        "Vegetation, snow, water and very fast movement lose coherence and give no measurement at all.",
    ),
)


@dataclass
class Analysis:
    mask: np.ndarray
    relative_mm: np.ndarray
    valid: np.ndarray
    area_px: int
    area_low_px: int
    area_high_px: int
    confidence: str
    reasons: list[str]
    flags: list[str]
    metrics: dict[str, Any] = field(default_factory=dict)


def analyse(los_m: np.ndarray, coherence: np.ndarray, aoi: np.ndarray, res_m: float, vertical_m: np.ndarray | None = None,
            dem: np.ndarray | None = None) -> Analysis:
    """Turn one displacement raster into patches, with the checks that decide how far to trust them (pure)."""
    usable = np.isfinite(los_m) & (los_m != 0) & np.isfinite(coherence) & (coherence >= COHERENCE_MIN)
    valid = usable & aoi
    ring = usable & ~aoi
    flags: list[str] = []
    degraded: list[str] = []

    if ring.sum() >= MIN_RING_PIXELS:
        zero, sigma = ix.robust_center_scale(los_m[ring] * 1000.0)
        reference = "the surrounding ground"
    else:
        zero, sigma = ix.robust_center_scale(los_m[valid] * 1000.0) if valid.any() else (0.0, 0.0)
        reference = "the area itself"
        degraded.append("Too little coherent ground around the area: the area's own median was used as zero, which hides "
                        "movement of the whole area.")
    relative = np.where(valid, los_m * 1000.0 - zero, np.nan).astype("float32")
    threshold = max(MIN_SIGNAL_MM, NOISE_SIGMAS * float(sigma))
    patch = min_patch_pixels(res_m)

    def decide(limit: float) -> np.ndarray:
        with np.errstate(invalid="ignore"):
            return ix.clean_mask(np.abs(relative) >= limit, patch, opening=False)

    moving = decide(threshold)
    low, high = decide(threshold * 1.5), decide(threshold * 0.75)

    share = float(valid[aoi].mean()) if aoi.any() else 0.0
    if share < MIN_COHERENT_SHARE:
        degraded.append(f"Only {share:.0%} of the area kept enough coherence to measure. Nothing can be said about the rest.")
    if dem is not None and valid.sum() >= MIN_RING_PIXELS:
        both = (usable & np.isfinite(dem))
        if both.sum() >= MIN_RING_PIXELS and np.ptp(dem[both]) > 50:
            r = float(np.corrcoef(los_m[both], dem[both])[0, 1])
            if abs(r) >= DEM_CORRELATION_MAX:
                degraded.append(f"The signal follows elevation (correlation {r:+.2f}), the usual mark of atmospheric delay, not movement.")
    flags.extend(degraded)

    any_moving = bool(moving.any())
    values = relative[moving] if any_moving else np.array([], dtype="float32")
    typical = float(np.median(np.abs(values))) if any_moving else 0.0
    coh_in = float(np.mean(coherence[moving])) if any_moving else 0.0
    if not any_moving:
        confidence = "not_detected"
        reasons = [f"No patch moved more than {threshold:.0f} mm relative to {reference}, within the {share:.0%} of the area that could be measured."]
    else:
        reasons = [f"Typical movement inside the patches is {typical:.0f} mm, against a detection limit of {threshold:.0f} mm "
                   f"(noise {sigma:.0f} mm on {reference}); mean coherence there is {coh_in:.2f}."]
        if degraded:
            confidence = "uncertain"
        elif typical >= 2 * threshold and coh_in >= 0.5:
            confidence = "high"
        elif typical >= 1.5 * threshold or coh_in >= 0.4:
            confidence = "probable"
        else:
            confidence = "detected"

    def stat(fn, arr):
        return round(float(fn(arr)), 1) if arr.size else None

    vertical = None
    if vertical_m is not None and any_moving:
        v = vertical_m[moving] * 1000.0
        v = v[np.isfinite(v)]
        vertical = stat(np.median, v - np.nanmedian(vertical_m[ring] * 1000.0)) if ring.sum() >= MIN_RING_PIXELS else stat(np.median, v)
    metrics = {
        "threshold_mm": round(threshold, 1), "noise_mm": round(float(sigma), 1), "reference": reference,
        "coherent_share": round(share, 3), "patch_mean_coherence": round(coh_in, 3) if any_moving else None,
        "max_toward_mm": stat(np.max, values[values > 0]) if any_moving else None,
        "max_away_mm": stat(np.min, values[values < 0]) if any_moving else None,
        "median_abs_mm": round(typical, 1) if any_moving else None, "vertical_if_purely_vertical_mm": vertical,
    }
    return Analysis(moving, relative, valid, int(moving.sum()), int(low.sum()), int(high.sum()), confidence, reasons, flags, metrics)


def looks_for(bbox: dict[str, float]) -> str:
    """40 m for a small area, 80 m (and fewer credits) when a finer grid would be averaged away anyway."""
    small = bbox["north"] - bbox["south"] <= SMALL_AREA_DEG and bbox["east"] - bbox["west"] <= SMALL_AREA_DEG
    return "10x2" if small else "20x4"


def with_margin(bbox: dict[str, float], margin: float = MARGIN_DEG) -> dict[str, float]:
    return {"west": bbox["west"] - margin, "south": bbox["south"] - margin, "east": bbox["east"] + margin, "north": bbox["north"] + margin}


def analysis_grid(bbox: dict[str, float], looks: str) -> Grid:
    return make_grid(with_margin(bbox), min_res_m=40.0 if looks == "10x2" else 80.0)


def read_layers(paths: dict[str, str], grid: Grid) -> dict[str, np.ndarray | None]:
    """Displacement and coherence are required; the vertical map and DEM only add a figure and a check."""
    from concurrent.futures import ThreadPoolExecutor

    from . import EOUnavailable

    def one(key: str):
        try:
            return read_band(paths[key], grid, Resampling.nearest if key == "coherence" else Resampling.bilinear, nodata=0)
        except EOUnavailable:
            if key in ("los", "coherence"):
                raise
            return None

    with ThreadPoolExecutor(max_workers=4) as pool:
        return dict(zip(paths, pool.map(one, paths)))
