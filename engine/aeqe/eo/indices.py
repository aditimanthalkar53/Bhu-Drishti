"""Spectral indices, masks and small raster utilities (pure numpy/scipy)."""

from __future__ import annotations

import numpy as np
from scipy import ndimage

# Sentinel-2 Scene Classification (SCL) classes treated as usable surface.
# Excluded: 0 no data, 1 saturated/defective, 2 dark/topographic shadow,
# 3 cloud shadow, 8/9 cloud (medium/high probability), 10 thin cirrus, 11 snow.
SCL_CLEAR = (4, 5, 6, 7)

S2_QUANT = 10000.0
S2_BOA_OFFSET = 1000.0      # added to DNs since processing baseline 04.00 (Jan 2022)


def s2_reflectance(dn: np.ndarray, offset_applied: bool | None) -> np.ndarray:
    """Sentinel-2 L2A digital numbers → surface reflectance (0..1).

    ``offset_applied`` is Earth Search's ``earthsearch:boa_offset_applied``:
    when true the +1000 baseline-04.00 offset has already been removed.
    """
    dn = dn.astype("float32")
    if offset_applied is False:
        dn = dn - S2_BOA_OFFSET
    return np.clip(dn / S2_QUANT, 0.0, 1.5)


def s2_offset_present(dn: np.ndarray, offset_applied: bool | None) -> tuple[bool | None, bool]:
    """Check the offset flag against the data. Returns (flag to use, flag was wrong).

    With the +1000 offset still in the data no valid pixel sits far below 1000.
    Earth Search marks some scenes ``boa_offset_applied: false`` although their
    digital numbers already have it removed; subtracting it again drives dark
    bands (red over forest, water) to zero and NDVI to 1. When the darkest
    valid pixels are well under the offset, the data wins over the flag.
    """
    if offset_applied is not False:
        return offset_applied, False
    valid = dn[np.isfinite(dn) & (dn > 0)]
    if valid.size < 50:
        return offset_applied, False
    if float(np.percentile(valid, 0.5)) < S2_BOA_OFFSET - 150:
        return True, True
    return offset_applied, False


def scl_clear(scl: np.ndarray) -> np.ndarray:
    """True where the SCL class is usable (NaN / other classes → False)."""
    return np.isin(np.nan_to_num(scl, nan=0).astype("int16"), SCL_CLEAR)


def normalized_difference(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """(a − b) / (a + b); NaN where undefined."""
    a, b = a.astype("float32"), b.astype("float32")
    total = a + b
    with np.errstate(divide="ignore", invalid="ignore"):
        out = (a - b) / total
    out[~np.isfinite(out) | (total <= 0)] = np.nan
    return out


def ndvi(red: np.ndarray, nir: np.ndarray) -> np.ndarray:
    return normalized_difference(nir, red)


def ndwi(green: np.ndarray, nir: np.ndarray) -> np.ndarray:
    """McFeeters (1996) water index."""
    return normalized_difference(green, nir)


def mndwi(green: np.ndarray, swir: np.ndarray) -> np.ndarray:
    """Xu (2006) modified water index — more robust over built-up land."""
    return normalized_difference(green, swir)


def to_db(linear: np.ndarray) -> np.ndarray:
    """Backscatter power → decibels; non-positive / NaN → NaN."""
    out = np.full(linear.shape, np.nan, dtype="float32")
    ok = np.isfinite(linear) & (linear > 0)
    out[ok] = 10.0 * np.log10(linear[ok])
    return out


def boxcar(linear: np.ndarray, size: int = 5) -> np.ndarray:
    """NaN-aware mean filter in linear power — basic SAR speckle reduction."""
    valid = np.isfinite(linear)
    filled = np.where(valid, linear, 0.0).astype("float64")
    total = ndimage.uniform_filter(filled, size=size, mode="nearest")
    weight = ndimage.uniform_filter(valid.astype("float64"), size=size, mode="nearest")
    out = np.full(linear.shape, np.nan, dtype="float32")
    ok = valid & (weight > 0)
    out[ok] = (total[ok] / weight[ok]).astype("float32")
    return out


def otsu_threshold(values: np.ndarray, lo: float, hi: float, bins: int = 256) -> tuple[float, float]:
    """Otsu's threshold on ``values`` within [lo, hi].

    Returns ``(threshold, separability)`` where separability is the
    between-class variance over total variance (0..1) — near 0 for a
    unimodal histogram, which means the threshold should not be trusted.
    """
    v = values[np.isfinite(values) & (values >= lo) & (values <= hi)]
    if v.size < 50:
        return float("nan"), 0.0
    hist, edges = np.histogram(v, bins=bins, range=(lo, hi))
    p = hist.astype("float64") / hist.sum()
    centers = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(p)
    w1 = 1.0 - w0
    m = np.cumsum(p * centers)
    mt = m[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        between = (mt * w0 - m) ** 2 / (w0 * w1)
    between[~np.isfinite(between)] = 0.0
    k = int(np.argmax(between))
    total_var = float(np.sum(p * (centers - mt) ** 2))
    sep = float(between[k] / total_var) if total_var > 0 else 0.0
    return float(edges[k + 1]), sep


def robust_center_scale(values: np.ndarray) -> tuple[float, float]:
    """Median and MAD-based sigma (1.4826·MAD); (nan, nan) when empty."""
    v = values[np.isfinite(values)]
    if v.size == 0:
        return float("nan"), float("nan")
    med = float(np.median(v))
    mad = float(np.median(np.abs(v - med)))
    return med, 1.4826 * mad


def clean_mask(mask: np.ndarray, min_pixels: int, opening: bool = True) -> np.ndarray:
    """Morphological opening, then drop connected patches below ``min_pixels``."""
    out = mask.astype(bool)
    if opening:
        out = ndimage.binary_opening(out, structure=np.ones((3, 3), dtype=bool))
    if min_pixels > 1 and out.any():
        labels, n = ndimage.label(out)
        if n:
            sizes = ndimage.sum(out, labels, index=np.arange(1, n + 1))
            keep = np.zeros(n + 1, dtype=bool)
            keep[1:] = sizes >= min_pixels
            out = keep[labels]
    return out
