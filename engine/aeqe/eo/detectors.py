"""
Detection engines.

Every detector implements one interface (``Detector``) and is listed in
``REGISTRY`` with versioned metadata, so a learned model (U-Net, a
remote-sensing foundation model) can be added beside — and compared against —
these transparent baselines without touching the pipeline.

The three baselines are deliberately interpretable and conservative:

  s2-ndvi-change    vegetation change from two Sentinel-2 dates
  s2-forest-loss    the same change, restricted to mapped tree cover (ForestGuard)
  s2-water-change   surface-water change from two Sentinel-2 dates
  s1-flood-change   probable inundation from two Sentinel-1 RTC dates

Common principles:
  * a detection needs BOTH an absolute change and a change that is unusual
    for this scene pair (robust z-score), after removing the scene-wide
    median shift — so seasonal / illumination / atmospheric differences
    between acquisitions are not reported as events;
  * an area is always returned with a low–high range obtained by re-running
    the decision with stricter and looser thresholds (threshold sensitivity);
  * confidence is a class with stated reasons, never an invented percentage;
  * known failure modes that could not be controlled are returned as
    ``quality_flags``.

None of these baselines has been evaluated against labelled data here —
``ModelMetadata.evaluation`` says so explicitly.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Protocol

import numpy as np

from . import indices as ix

MIN_PATCH_M2 = 5000.0        # 0.5 ha — smaller patches are treated as noise
MIN_VALID_FRACTION = 0.35    # below this the result is refused, not guessed
MAX_OPENING_RES_M = 30.0
SPECKLE_WINDOW_M = 50.0

ConfidenceClass = str        # "high" | "probable" | "detected" | "uncertain" | "not_detected"


@dataclass(frozen=True)
class ModelMetadata:
    id: str
    name: str
    version: str
    kind: str                        # "baseline" | "learned"
    modality: str
    inputs: tuple[str, ...]
    output: str
    method: str
    parameters: dict[str, Any]
    limitations: tuple[str, ...]
    evaluation: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["evaluation"] = self.evaluation or {
            "status": "not_evaluated",
            "note": "No labelled benchmark has been run for this model in this deployment.",
        }
        return d


@dataclass
class Detection:
    """Result of one detector run on one aligned grid."""

    model: ModelMetadata
    mask: np.ndarray                         # primary change (bool)
    change: np.ndarray                       # continuous change field, for display
    valid: np.ndarray                        # pixels that could be assessed (bool)
    area_px: int
    area_low_px: int
    area_high_px: int
    confidence: ConfidenceClass
    confidence_reasons: list[str]
    metrics: dict[str, Any] = field(default_factory=dict)
    quality_flags: list[str] = field(default_factory=list)
    secondary: dict[str, np.ndarray] = field(default_factory=dict)
    aoi: np.ndarray | None = None            # pixels inside the area of interest (None = the whole grid)

    @property
    def valid_fraction(self) -> float:
        return valid_share(self.valid, self.aoi)


class Detector(Protocol):
    metadata: ModelMetadata

    def detect(self, inputs: dict[str, Any], res_m: float) -> Detection: ...


def valid_share(valid: np.ndarray, aoi: np.ndarray | None) -> float:
    """Share of the area of interest that could be assessed (a district fills only part of its rectangle)."""
    if not valid.size:
        return 0.0
    if aoi is None or not aoi.any():
        return float(valid.mean())
    return float(valid[aoi].mean())


def min_patch_pixels(res_m: float) -> int:
    return max(4, round(MIN_PATCH_M2 / (res_m ** 2)))


def use_opening(res_m: float) -> bool:
    """A 3×3 opening removes noise at 10–30 m; at district scale it would erase every feature under ~200 m wide."""
    return res_m <= MAX_OPENING_RES_M


def speckle_window(res_m: float) -> int:
    """Odd boxcar size covering about ``SPECKLE_WINDOW_M``. Coarse grids read overviews, which are already multilooked."""
    size = round(SPECKLE_WINDOW_M / res_m)
    return max(1, size if size % 2 else size + 1)


def _classify(detected: bool, strong: bool, moderate: bool, degraded: list[str],
              reasons: list[str]) -> ConfidenceClass:
    if not detected:
        return "not_detected"
    if degraded:
        reasons.extend(degraded)
        return "uncertain"
    if strong:
        return "high"
    return "probable" if moderate else "detected"


# ── Sentinel-2 vegetation change ─────────────────────────────────────


class NdviChangeDetector:
    metadata = ModelMetadata(
        id="s2-ndvi-change", name="NDVI differencing (Sentinel-2)", version="1.0.0",
        kind="baseline", modality="optical multispectral (Sentinel-2 L2A)",
        inputs=("red", "nir", "scl — before and after"),
        output="potential vegetation loss mask + NDVI change field",
        method=("NDVI(after) − NDVI(before) on cloud/shadow-free pixels; the scene-wide median "
                "difference is removed; loss = previously vegetated pixels whose corrected drop "
                "exceeds an absolute threshold AND a robust z-score; opening + minimum patch size."),
        parameters={"vegetated_ndvi_min": 0.45, "drop_abs": 0.20, "drop_z": 2.5,
                    "drop_abs_range": [0.15, 0.30], "min_patch_m2": MIN_PATCH_M2},
        limitations=(
            "Reports potential vegetation loss, not deforestation: harvest, fire, drought, "
            "flooding and clearing all look alike in NDVI.",
            "Compare the same season in two years; cross-season pairs measure phenology.",
            "A region-wide real decline is partly absorbed by the scene-median correction.",
            "Residual thin cloud, haze and cloud-shadow edges can cause false detections.",
        ),
    )

    def detect(self, inputs: dict[str, Any], res_m: float) -> Detection:
        return self._run(inputs, res_m)

    def _run(self, inputs: dict[str, Any], res_m: float,
             restrict: np.ndarray | None = None) -> Detection:
        """Detect loss; ``restrict`` limits candidates to a context mask (e.g. tree cover)."""
        p = self.metadata.parameters
        before = ix.ndvi(inputs["red_before"], inputs["nir_before"])
        after = ix.ndvi(inputs["red_after"], inputs["nir_after"])
        valid = inputs["clear_before"] & inputs["clear_after"] & np.isfinite(before) & np.isfinite(after)
        diff = np.where(valid, after - before, np.nan).astype("float32")
        offset, sigma = ix.robust_center_scale(diff)
        if not np.isfinite(offset):
            offset, sigma = 0.0, float("nan")
        corrected = diff - offset
        z = corrected / sigma if sigma and sigma > 1e-6 else np.full(diff.shape, np.nan, "float32")
        vegetated = valid & (before >= p["vegetated_ndvi_min"])
        if restrict is not None:
            vegetated &= restrict
        patch = min_patch_pixels(res_m)

        def decide(drop: float, zmin: float) -> np.ndarray:
            return ix.clean_mask(vegetated & (corrected <= -drop) & (z <= -zmin), patch, use_opening(res_m))

        loss = decide(p["drop_abs"], p["drop_z"])
        low = decide(p["drop_abs_range"][1], p["drop_z"] + 1.0)
        high = decide(p["drop_abs_range"][0], p["drop_z"] - 0.5)
        gain = ix.clean_mask(valid & (after >= p["vegetated_ndvi_min"])
                             & (corrected >= p["drop_abs"]) & (z >= p["drop_z"]), patch, use_opening(res_m))

        flags: list[str] = []
        degraded: list[str] = []
        if abs(offset) > 0.10:
            degraded.append(f"Large scene-wide NDVI shift ({offset:+.2f}) between the two dates — "
                            "likely seasonal or atmospheric; local changes are harder to separate.")
        share = valid_share(valid, inputs.get("aoi"))
        if share < 0.6:
            degraded.append(f"Only {share:.0%} of the area was cloud-free on both dates.")
        flags.extend(degraded)

        mean_drop = float(np.nanmean(-corrected[loss])) if loss.any() else 0.0
        mean_z = float(np.nanmean(-z[loss])) if loss.any() else 0.0
        reasons = ([f"Mean NDVI drop inside detected patches: {mean_drop:.2f} "
                    f"({mean_z:.1f}σ beyond this scene pair's normal variation)."] if loss.any() else
                   ["No previously vegetated patch dropped beyond both thresholds."])
        confidence = _classify(bool(loss.any()), mean_drop >= 0.35 and mean_z >= 4.0,
                               mean_drop >= 0.25, degraded, reasons)

        veg = vegetated
        metrics = {
            "ndvi_before_mean": _mean(before[veg]), "ndvi_after_mean": _mean(after[veg]),
            "scene_median_shift": round(float(offset), 3),
            "vegetated_fraction_before": round(float(veg.sum() / max(1, valid.sum())), 3),
            "gain_area_px": int(gain.sum()),
        }
        return Detection(self.metadata, loss, corrected.astype("float32"), valid,
                         int(loss.sum()), int(low.sum()), int(high.sum()), confidence, reasons,
                         metrics, flags, {"gain": gain}, inputs.get("aoi"))


# ── Sentinel-2 forest loss (ForestGuard) ─────────────────────────────


class ForestLossDetector(NdviChangeDetector):
    """NDVI loss that falls on mapped tree cover — ForestGuard's forest-context rule."""

    metadata = ModelMetadata(
        id="s2-forest-loss", name="ForestGuard — NDVI loss on tree cover (Sentinel-2)",
        version="1.0.0", kind="baseline",
        modality="optical multispectral (Sentinel-2 L2A) + land cover",
        inputs=("red", "nir", "scl — before and after", "tree cover (ESA WorldCover)"),
        output="potential forest loss mask + NDVI change field",
        method=("NDVI differencing as in s2-ndvi-change, with candidates limited to pixels mapped "
                "as tree cover or mangrove (ESA WorldCover). Loss on other vegetation is kept "
                "separately and not counted as forest."),
        parameters={**NdviChangeDetector.metadata.parameters, "tree_classes": [10, 95],
                    "tree_cover_source": "ESA WorldCover 10 m (2021)"},
        limitations=(
            "Reports potential forest loss, not confirmed deforestation: logging, fire, drought, "
            "storm damage and leaf-off all lower NDVI.",
            "The tree-cover map is from 2021: forest that grew since is missed, and plantations "
            "or orchards count as trees.",
            "Compare the same season in two years; cross-season pairs measure phenology.",
            "Residual thin cloud, haze and cloud-shadow edges can cause false detections.",
        ),
    )

    def detect(self, inputs: dict[str, Any], res_m: float) -> Detection:
        trees = np.asarray(inputs["tree_cover"], dtype=bool)
        everything = self._run(inputs, res_m)
        forest = self._run(inputs, res_m, restrict=trees)
        tree_share = float((trees & forest.valid).sum() / max(1, forest.valid.sum()))
        forest.metrics.update({
            "tree_cover_fraction": round(tree_share, 3),
            "all_vegetation_loss_px": everything.area_px,
            "tree_cover_px": int((trees & forest.valid).sum()),
        })
        forest.secondary["other_vegetation_loss"] = everything.mask & ~forest.mask
        if forest.area_px:
            forest.confidence_reasons.append(
                "Every detected patch lies on land mapped as tree cover in 2021.")
        if tree_share < 0.02:
            forest.quality_flags.append(
                f"Only {tree_share:.1%} of the area is mapped as tree cover — little forest to assess.")
        return forest


# ── Sentinel-2 surface-water change ──────────────────────────────────


class WaterChangeDetector:
    metadata = ModelMetadata(
        id="s2-water-change", name="MNDWI surface-water change (Sentinel-2)", version="1.0.0",
        kind="baseline", modality="optical multispectral (Sentinel-2 L2A)",
        inputs=("green", "nir", "swir16", "scl — before and after", "slope (optional)"),
        output="new surface water mask (+ water lost) and MNDWI change field",
        method=("Water = MNDWI > threshold with dark NIR, on cloud/shadow-free pixels, off steep "
                "slopes; new water = water after and not before; opening + minimum patch size."),
        parameters={"mndwi_water": 0.0, "mndwi_range": [-0.05, 0.10], "nir_max": 0.18,
                    "slope_max_deg": 12.0, "min_patch_m2": MIN_PATCH_M2},
        limitations=(
            "Optical: cloud during a flood hides it. Absence of detection under cloud is not "
            "absence of water.",
            "Flooded vegetation and very turbid or shallow water are under-detected.",
            "Terrain and cloud shadow resemble water; the slope mask reduces but does not "
            "remove this.",
            "New water is not necessarily flooding: reservoirs, irrigation and paddy fields "
            "also appear.",
        ),
    )

    def detect(self, inputs: dict[str, Any], res_m: float) -> Detection:
        p = self.metadata.parameters
        m_before = ix.mndwi(inputs["green_before"], inputs["swir_before"])
        m_after = ix.mndwi(inputs["green_after"], inputs["swir_after"])
        valid = (inputs["clear_before"] & inputs["clear_after"]
                 & np.isfinite(m_before) & np.isfinite(m_after))
        flags: list[str] = []
        degraded: list[str] = []
        slope = inputs.get("slope")
        flat = np.ones(valid.shape, dtype=bool)
        if slope is not None:
            flat = np.isfinite(slope) & (slope <= p["slope_max_deg"])
        else:
            degraded.append("No elevation data: terrain shadow could not be masked.")
        share = valid_share(valid, inputs.get("aoi"))
        if share < 0.6:
            degraded.append(f"Only {share:.0%} of the area was cloud-free on both dates.")
        flags.extend(degraded)
        patch = min_patch_pixels(res_m)

        def water(m: np.ndarray, nir: np.ndarray, t: float) -> np.ndarray:
            return valid & flat & (m > t) & (nir < p["nir_max"])

        def new_water(t: float) -> np.ndarray:
            # "before" uses the loosest threshold so marginal existing water is not called new.
            was = water(m_before, inputs["nir_before"], p["mndwi_range"][0])
            return ix.clean_mask(water(m_after, inputs["nir_after"], t) & ~was, patch, use_opening(res_m))

        gained = new_water(p["mndwi_water"])
        low = new_water(p["mndwi_range"][1])
        high = new_water(p["mndwi_range"][0])
        w_before = water(m_before, inputs["nir_before"], p["mndwi_water"])
        w_after = water(m_after, inputs["nir_after"], p["mndwi_water"])
        lost = ix.clean_mask(w_before & ~water(m_after, inputs["nir_after"], p["mndwi_range"][0]), patch, use_opening(res_m))

        margin = float(np.nanmean(m_after[gained])) if gained.any() else 0.0
        reasons = ([f"Mean MNDWI of new-water pixels: {margin:.2f} "
                    f"(threshold {p['mndwi_water']:.2f})."] if gained.any()
                   else ["No new surface water beyond the minimum patch size."])
        confidence = _classify(bool(gained.any()), margin >= 0.30, margin >= 0.15, degraded, reasons)
        metrics = {
            "water_before_px": int(w_before.sum()), "water_after_px": int(w_after.sum()),
            "water_lost_px": int(lost.sum()),
        }
        change = np.where(valid, m_after - m_before, np.nan).astype("float32")
        return Detection(self.metadata, gained, change, valid, int(gained.sum()), int(low.sum()),
                         int(high.sum()), confidence, reasons, metrics, flags, {"lost": lost}, inputs.get("aoi"))


# ── Sentinel-1 flood (change detection) ──────────────────────────────


class SarFloodDetector:
    metadata = ModelMetadata(
        id="s1-flood-change", name="SAR backscatter change + Otsu (Sentinel-1 RTC)", version="1.0.0",
        kind="baseline", modality="C-band SAR, gamma0 RTC, VV+VH",
        inputs=("vv, vh — event and reference pass (same relative orbit)",
                "permanent-water occurrence (optional)", "slope (optional)", "built-up mask (optional)"),
        output="probable inundation mask + VV change field (dB)",
        method=("Boxcar speckle filter (about 50 m) in linear power → dB. Open-water threshold on the event "
                "VV image by Otsu (accepted only if the histogram is separable and the threshold "
                "is physically plausible; otherwise a fixed threshold is used and flagged). "
                "Inundation = below threshold AND backscatter dropped vs the reference pass AND "
                "not permanent water AND not steep terrain AND not built-up; opening + minimum "
                "patch size."),
        parameters={"vv_fixed_db": -17.0, "vv_otsu_bounds_db": [-22.0, -13.0],
                    "otsu_min_separability": 0.55, "drop_db": 3.0, "threshold_range_db": 1.5,
                    "vh_water_db": -20.0, "permanent_water_occurrence_pct": 50,
                    "slope_max_deg": 6.0, "speckle_window_m": SPECKLE_WINDOW_M, "min_patch_m2": MIN_PATCH_M2},
        limitations=(
            "Flooding in built-up areas is generally not detectable (double-bounce raises "
            "backscatter); built-up pixels are excluded, not cleared.",
            "Flooded vegetation often brightens instead of darkening and is missed.",
            "Smooth dry surfaces (sand, bare soil, tarmac) and wet snow look like water.",
            "Radar shadow and layover in steep terrain; wind roughens water and hides it.",
            "Reference and event pass must share the relative orbit; otherwise geometry "
            "differences masquerade as change.",
        ),
    )

    def detect(self, inputs: dict[str, Any], res_m: float) -> Detection:
        p = self.metadata.parameters
        win = speckle_window(res_m)
        vv_a = ix.to_db(ix.boxcar(inputs["vv_after"], win))
        vv_b = ix.to_db(ix.boxcar(inputs["vv_before"], win))
        vh_a = ix.to_db(ix.boxcar(inputs["vh_after"], win))
        valid = np.isfinite(vv_a) & np.isfinite(vv_b)

        flags: list[str] = []
        degraded: list[str] = []
        lo, hi = p["vv_otsu_bounds_db"]
        otsu, sep = ix.otsu_threshold(vv_a[valid], -30.0, 0.0)
        if np.isfinite(otsu) and sep >= p["otsu_min_separability"] and lo <= otsu <= hi:
            threshold, source = float(otsu), "otsu"
        else:
            threshold, source = float(p["vv_fixed_db"]), "fixed"
            flags.append("Event image histogram is not clearly bimodal — a fixed "
                         f"{threshold:.0f} dB threshold was used instead of Otsu.")

        candidates = valid.copy()
        occurrence = inputs.get("permanent_water")
        permanent = np.zeros(valid.shape, dtype=bool)
        if occurrence is not None:
            permanent = np.nan_to_num(occurrence, nan=0.0) >= p["permanent_water_occurrence_pct"]
        else:
            permanent = vv_b < threshold          # fall back to "already dark in the reference"
            degraded.append("No permanent-water layer: existing water was inferred from the "
                            "reference image only.")
        candidates &= ~permanent
        slope = inputs.get("slope")
        if slope is not None:
            candidates &= np.isfinite(slope) & (slope <= p["slope_max_deg"])
        else:
            degraded.append("No elevation data: radar shadow in steep terrain was not masked.")
        builtup = inputs.get("builtup")
        builtup_fraction = None
        if builtup is not None:
            builtup_fraction = float(builtup[valid].mean()) if valid.any() else 0.0
            candidates &= ~builtup
            if builtup_fraction > 0.02:
                flags.append(f"{builtup_fraction:.0%} of the area is built-up and was excluded: "
                             "urban flooding cannot be detected with this method.")
        else:
            flags.append("No land-cover layer: built-up areas were not excluded.")
        share = valid_share(valid, inputs.get("aoi"))
        if share < 0.6:
            degraded.append(f"The two passes jointly cover only {share:.0%} of the area.")
        flags.extend(degraded)

        delta = np.where(valid, vv_a - vv_b, np.nan).astype("float32")
        patch = min_patch_pixels(res_m)

        def decide(t: float, drop: float) -> np.ndarray:
            return ix.clean_mask(candidates & (vv_a < t) & (delta <= -drop), patch, use_opening(res_m))

        flood = decide(threshold, p["drop_db"])
        r = p["threshold_range_db"]
        low = decide(threshold - r, p["drop_db"] + 1.0)
        high = decide(threshold + r, p["drop_db"] - 1.0)

        vh_agree = float((vh_a[flood] < p["vh_water_db"]).mean()) if flood.any() else 0.0
        mean_drop = float(np.nanmean(-delta[flood])) if flood.any() else 0.0
        reasons = ([f"Mean VV drop inside detected patches: {mean_drop:.1f} dB; "
                    f"{vh_agree:.0%} of them are also dark in VH.",
                    f"Water threshold {threshold:.1f} dB ({source})."] if flood.any() else
                   [f"No patch fell below {threshold:.1f} dB ({source}) with a "
                    f"≥{p['drop_db']:.0f} dB drop."])
        if source == "fixed" and flood.any():
            degraded = [*degraded, "Threshold was not derived from this image."]
        confidence = _classify(bool(flood.any()), vh_agree >= 0.7 and mean_drop >= 5.0,
                               vh_agree >= 0.4, degraded, reasons)
        metrics = {
            "vv_threshold_db": round(threshold, 2), "threshold_source": source,
            "otsu_separability": round(float(sep), 3),
            "permanent_water_px": int((permanent & valid).sum()),
            "builtup_fraction": None if builtup_fraction is None else round(builtup_fraction, 3),
            "vh_agreement": round(vh_agree, 3), "mean_vv_drop_db": round(mean_drop, 2),
        }
        return Detection(self.metadata, flood, delta, valid, int(flood.sum()), int(low.sum()),
                         int(high.sum()), confidence, reasons, metrics, flags,
                         {"permanent_water": permanent & valid}, inputs.get("aoi"))


def _mean(values: np.ndarray) -> float | None:
    v = values[np.isfinite(values)]
    return round(float(v.mean()), 3) if v.size else None


REGISTRY: dict[str, Detector] = {
    d.metadata.id: d for d in (NdviChangeDetector(), ForestLossDetector(), WaterChangeDetector(),
                               SarFloodDetector())
}


def list_models() -> list[dict[str, Any]]:
    return [d.metadata.as_dict() for d in REGISTRY.values()]
