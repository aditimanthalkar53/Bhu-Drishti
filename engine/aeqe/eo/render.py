"""PNG overlays for the map: true-colour scenes, SAR backscatter and change fields."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image


def _stretch(band: np.ndarray, lo: float, hi: float) -> np.ndarray:
    out = (np.nan_to_num(band, nan=lo) - lo) / max(1e-9, hi - lo)
    return (np.clip(out, 0.0, 1.0) * 255).astype("uint8")


def true_colour(red: np.ndarray, green: np.ndarray, blue: np.ndarray) -> Image.Image:
    """Reflectance (0..1) → RGBA; fixed stretch so two dates are visually comparable."""
    valid = np.isfinite(red) & np.isfinite(green) & np.isfinite(blue)
    gamma = 1 / 1.8
    chans = [(_stretch(b, 0.0, 0.30).astype("float32") / 255) ** gamma for b in (red, green, blue)]
    rgb = np.dstack([(c * 255).astype("uint8") for c in chans])
    alpha = np.where(valid, 255, 0).astype("uint8")
    return Image.fromarray(np.dstack([rgb, alpha]))


def grey_db(db: np.ndarray, lo: float = -25.0, hi: float = 0.0) -> Image.Image:
    """SAR backscatter in dB → greyscale RGBA with the same stretch for every date."""
    g = _stretch(db, lo, hi)
    alpha = np.where(np.isfinite(db), 255, 0).astype("uint8")
    return Image.fromarray(np.dstack([g, g, g, alpha]))


def diverging(change: np.ndarray, limit: float, fade: float = 0.5) -> Image.Image:
    """Signed change → brown (decrease) / teal (increase). Changes under ``fade`` × limit fade to transparent,
    so the base map shows through where nothing meaningful changed instead of a field of faint noise."""
    t = np.clip(np.nan_to_num(change, nan=0.0) / limit, -1.0, 1.0)
    neg, pos = np.clip(-t, 0, 1)[..., None], np.clip(t, 0, 1)[..., None]
    white = np.array([245, 245, 240], dtype="float32")
    brown = np.array([140, 81, 10], dtype="float32")
    teal = np.array([1, 102, 94], dtype="float32")
    rgb = white + neg * (brown - white) + pos * (teal - white)
    # nothing below half of ``fade``, full colour from ``fade``: ordinary noise stays invisible
    strength = np.clip((np.abs(t) - fade / 2) / max(fade / 2, 1e-6), 0.0, 1.0)
    alpha = np.where(np.isfinite(change), 235 * strength, 0).astype("uint8")
    return Image.fromarray(np.dstack([rgb.astype("uint8"), alpha]))


def smooth(field: np.ndarray, size: int) -> np.ndarray:
    """NaN-aware mean filter for display, so speckle does not read as thousands of one-pixel changes."""
    if size <= 1:
        return field
    from scipy import ndimage

    ok = np.isfinite(field)
    total = ndimage.uniform_filter(np.where(ok, field, 0.0).astype("float64"), size=size, mode="nearest")
    weight = ndimage.uniform_filter(ok.astype("float64"), size=size, mode="nearest")
    out = np.full(field.shape, np.nan, dtype="float32")
    good = ok & (weight > 0)
    out[good] = (total[good] / weight[good]).astype("float32")
    return out


def save(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)
