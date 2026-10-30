"""Change detection (aeqe.eo): detectors on synthetic scenes with known truth, geometry and area maths, population
intersection, the risk framework, ForestGuard evidence, mosaics, boundary clipping and the job store.

No network: every raster is synthetic and HTTP is faked. ``scripts/smoke_sources.py`` is the live check.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta

import httpx
import numpy as np
import pytest

pytest.importorskip("rasterio")   # the pipeline needs the live-data packages

from affine import Affine
from shapely.geometry import box, shape

from aeqe.eo import EOUnavailable, assets, forest, insar, pipeline, population, risk, twin, vector
from aeqe.eo import indices as ix
from aeqe.eo.detectors import REGISTRY, list_models, min_patch_pixels, speckle_window, use_opening
from aeqe.eo.grid import aoi_mask, display_grid, make_grid, overview_level, slope_degrees, utm_epsg
from aeqe.eo.service import DetectionService, clean_json, steps_for
from aeqe.providers.base import Region
from aeqe.scope import classify
from aeqe.sources.base import SourceError
from aeqe.sources.hyp3 import SlcScene, choose_pair, job_name, parse_scenes, product_paths

BBOX = {"south": 27.6, "north": 27.8, "west": 85.2, "east": 85.45}
RES = 10.0
SHAPE = (200, 200)

# â”€â”€ indices â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def test_indices_and_reflectance():
    red, nir = np.array([[0.05, 0.2, 0.0]]), np.array([[0.45, 0.2, 0.0]])
    out = ix.ndvi(red, nir)
    assert out[0, 0] == pytest.approx(0.8) and out[0, 1] == pytest.approx(0.0)
    assert np.isnan(out[0, 2])                       # 0/0 is unknown, not 0
    dn = np.array([[1000.0, 3000.0]])
    assert ix.s2_reflectance(dn, False)[0].tolist() == pytest.approx([0.0, 0.2])   # offset removed
    assert ix.s2_reflectance(dn, True)[0].tolist() == pytest.approx([0.1, 0.3])    # already removed
    assert ix.scl_clear(np.array([[4, 5, 6, 7, 3, 8, 9, 10, 0, np.nan]])).tolist() == [
        [True, True, True, True, False, False, False, False, False, False]]


def test_otsu_separates_two_modes_and_flags_one_mode():
    rng = np.random.default_rng(0)
    bimodal = np.concatenate([rng.normal(-20, 1, 4000), rng.normal(-8, 1.5, 16000)])
    t, sep = ix.otsu_threshold(bimodal, -30, 0)
    assert -17 < t < -11 and sep > 0.8
    _, sep_uni = ix.otsu_threshold(rng.normal(-8, 1.5, 20000), -30, 0)
    assert sep_uni < 0.7 and sep_uni < sep
    assert np.isnan(ix.otsu_threshold(np.array([1.0]), -30, 0)[0])


def test_clean_mask_drops_specks_and_boxcar_ignores_nan():
    mask = np.zeros((40, 40), bool)
    mask[5:20, 5:20] = True
    mask[30, 30] = True
    out = ix.clean_mask(mask, min_pixels=20)
    assert out[10, 10] and not out[30, 30]
    img = np.full((9, 9), 2.0)
    img[4, 4] = np.nan
    smooth = ix.boxcar(img, 3)
    assert np.isnan(smooth[4, 4]) and smooth[3, 3] == pytest.approx(2.0)


# â”€â”€ detectors on scenes with known truth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def _s2_scene(ndvi_value=0.8):
    nir = np.full(SHAPE, 0.45, "float32")
    red = (nir * (1 - ndvi_value) / (1 + ndvi_value)).astype("float32")
    return red, nir


def _veg_inputs(shift=0.0):
    rng = np.random.default_rng(1)
    red_b, nir_b = _s2_scene()
    red_a, nir_a = _s2_scene()
    red_a = red_a + rng.normal(0, 0.004, SHAPE).astype("float32") + shift
    clear = np.ones(SHAPE, bool)
    return {"red_before": red_b, "nir_before": nir_b, "clear_before": clear,
            "red_after": red_a, "nir_after": nir_a, "clear_after": clear.copy()}


def test_ndvi_detector_finds_a_cleared_patch_and_reports_a_range():
    inputs = _veg_inputs()
    inputs["red_after"][50:80, 60:90] = 0.22          # 30Ã—30 px cleared: NDVI 0.8 â†’ ~0.2
    inputs["nir_after"][50:80, 60:90] = 0.33
    det = REGISTRY["s2-ndvi-change"].detect(inputs, RES)
    assert 780 <= det.area_px <= 900                  # 900 px truth, opening trims the rim
    assert det.mask[65, 75] and not det.mask[150, 150]
    assert det.area_low_px <= det.area_px <= det.area_high_px
    assert det.confidence == "high" and det.quality_flags == []
    assert det.metrics["ndvi_before_mean"] == pytest.approx(0.8, abs=0.01)


def test_scene_wide_shift_is_not_reported_as_change():
    # Every pixel a little less green (season / atmosphere): no local event.
    det = REGISTRY["s2-ndvi-change"].detect(_veg_inputs(shift=0.03), RES)
    assert det.area_px == 0 and det.confidence == "not_detected"
    assert det.metrics["scene_median_shift"] < -0.05


def test_cloud_on_either_date_is_unknown_not_change():
    inputs = _veg_inputs()
    inputs["red_after"][50:80, 60:90] = 0.22
    inputs["nir_after"][50:80, 60:90] = 0.33
    inputs["clear_after"][:, :100] = False            # half the scene clouded, incl. the patch
    det = REGISTRY["s2-ndvi-change"].detect(inputs, RES)
    assert det.area_px == 0 and det.valid_fraction == pytest.approx(0.5)


def test_low_valid_fraction_downgrades_confidence_to_uncertain():
    inputs = _veg_inputs()
    inputs["red_after"][150:180, 150:180] = 0.22
    inputs["nir_after"][150:180, 150:180] = 0.33
    inputs["clear_before"][:90, :] = False            # 55% usable
    det = REGISTRY["s2-ndvi-change"].detect(inputs, RES)
    assert det.area_px > 0 and det.confidence == "uncertain"
    assert any("cloud-free" in f for f in det.quality_flags)


def _water_inputs():
    land = {"green": 0.08, "nir": 0.30, "swir": 0.20}
    out = {}
    for tag in ("before", "after"):
        for band, v in land.items():
            out[f"{band}_{tag}"] = np.full(SHAPE, v, "float32")
        out[f"clear_{tag}"] = np.ones(SHAPE, bool)
    for tag in ("before", "after"):                    # a river present on both dates
        out[f"green_{tag}"][:, 20:26], out[f"nir_{tag}"][:, 20:26], out[f"swir_{tag}"][:, 20:26] = 0.07, 0.03, 0.01
    out["green_after"][100:140, 100:150], out["nir_after"][100:140, 100:150] = 0.07, 0.03
    out["swir_after"][100:140, 100:150] = 0.01         # 40Ã—50 px newly flooded
    return out


def test_water_detector_reports_new_water_not_the_existing_river():
    inputs = _water_inputs()
    inputs["slope"] = np.zeros(SHAPE, "float32")
    det = REGISTRY["s2-water-change"].detect(inputs, RES)
    assert 1800 <= det.area_px <= 2000 and det.mask[120, 125]
    assert not det.mask[50, 22]                        # river: water before and after
    assert det.metrics["water_before_px"] == 200 * 6
    assert det.confidence == "high"

    steep = _water_inputs()
    steep["slope"] = np.full(SHAPE, 30.0, "float32")   # "water" on a mountainside = shadow
    assert REGISTRY["s2-water-change"].detect(steep, RES).area_px == 0

    no_dem = REGISTRY["s2-water-change"].detect(_water_inputs(), RES)
    assert no_dem.confidence == "uncertain" and any("elevation" in f for f in no_dem.quality_flags)


def _sar_inputs():
    rng = np.random.default_rng(2)
    speckle = lambda: rng.gamma(4.0, 0.25, SHAPE).astype("float32")   # noqa: E731  4-look speckle
    land_vv, land_vh, water_vv, water_vh = 0.16, 0.035, 0.008, 0.002  # âˆ’8 / âˆ’14.5 / âˆ’21 / âˆ’27 dB
    out = {}
    for tag in ("before", "after"):
        out[f"vv_{tag}"] = land_vv * speckle()
        out[f"vh_{tag}"] = land_vh * speckle()
        out[f"vv_{tag}"][:, 10:30] = water_vv * speckle()[:, 10:30]     # permanent lake, both dates
        out[f"vh_{tag}"][:, 10:30] = water_vh * speckle()[:, 10:30]
    for rows, cols in (((60, 110), (80, 150)), ((150, 190), (150, 190))):  # two flooded fields
        out["vv_after"][rows[0]:rows[1], cols[0]:cols[1]] = (water_vv * speckle())[rows[0]:rows[1], cols[0]:cols[1]]
        out["vh_after"][rows[0]:rows[1], cols[0]:cols[1]] = (water_vh * speckle())[rows[0]:rows[1], cols[0]:cols[1]]
    occurrence = np.zeros(SHAPE, "float32")
    occurrence[:, 10:30] = 95.0
    return out, occurrence


def test_sar_detector_separates_flood_from_permanent_water_urban_and_slopes():
    inputs, occurrence = _sar_inputs()
    builtup = np.zeros(SHAPE, bool)
    builtup[150:190, 150:190] = True                   # second flooded field is "urban"
    slope = np.zeros(SHAPE, "float32")
    det = REGISTRY["s1-flood-change"].detect(
        {**inputs, "permanent_water": occurrence, "slope": slope, "builtup": builtup}, RES)
    truth = 50 * 70
    assert 0.85 * truth <= det.area_px <= 1.05 * truth
    assert det.mask[85, 115]                           # flooded field
    assert not det.mask[100, 20]                       # permanent lake
    assert not det.mask[170, 170]                      # built-up: excluded, and said so
    assert any("built-up" in f for f in det.quality_flags)
    assert det.metrics["threshold_source"] == "otsu" and -22 <= det.metrics["vv_threshold_db"] <= -13
    assert det.confidence == "high" and det.metrics["vh_agreement"] > 0.7
    assert det.area_low_px <= det.area_px <= det.area_high_px

    steep = np.full(SHAPE, 20.0, "float32")
    masked = REGISTRY["s1-flood-change"].detect(
        {**inputs, "permanent_water": occurrence, "slope": steep, "builtup": builtup}, RES)
    assert masked.area_px == 0


def test_sar_detector_without_ancillary_data_says_what_it_could_not_control():
    inputs, _ = _sar_inputs()
    det = REGISTRY["s1-flood-change"].detect(inputs, RES)
    assert det.area_px > 0 and det.confidence == "uncertain"
    flags = " ".join(det.quality_flags)
    assert "permanent-water" in flags and "elevation" in flags and "land-cover" in flags
    assert not det.mask[100, 20]                       # lake still excluded via the reference image


def test_sar_detector_finds_nothing_when_nothing_changed():
    inputs, occurrence = _sar_inputs()
    inputs["vv_after"], inputs["vh_after"] = inputs["vv_before"].copy(), inputs["vh_before"].copy()
    det = REGISTRY["s1-flood-change"].detect({**inputs, "permanent_water": occurrence}, RES)
    assert det.area_px == 0 and det.confidence == "not_detected"


def test_model_registry_is_explicit_about_evaluation():
    models = list_models()
    assert {m["id"] for m in models} == {"s2-ndvi-change", "s2-forest-loss", "s2-water-change",
                                         "s1-flood-change"}
    for m in models:
        assert m["version"] and m["limitations"] and m["parameters"]
        assert m["kind"] == "baseline" and m["evaluation"]["status"] == "not_evaluated"
    assert min_patch_pixels(10) == 50 and min_patch_pixels(30) == 6 and min_patch_pixels(100) == 4


# â”€â”€ grid / vectors / areas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def test_grid_is_metric_utm_and_respects_the_pixel_budget():
    assert utm_epsg(27.7, 85.3) == "EPSG:32645" and utm_epsg(-33.9, 151.2) == "EPSG:32756"
    grid = make_grid(BBOX)
    assert grid.crs == "EPSG:32645" and grid.res_m % 10 == 0
    assert grid.width * grid.height <= 1_400_000 * 1.05
    km2 = grid.width * grid.height * grid.pixel_area_km2
    assert 520 < km2 < 600                              # 0.25Â° Ã— 0.2Â° at 27.7Â°N â‰ˆ 546 kmÂ²
    small = make_grid({"south": 27.70, "north": 27.72, "west": 85.30, "east": 85.32})
    assert small.res_m == 10.0
    disp = display_grid(BBOX, 900)
    assert disp.crs == "EPSG:3857" and max(disp.width, disp.height) == 900


def test_polygon_area_matches_pixel_area_and_points_are_tested_spatially():
    grid = make_grid(BBOX)
    mask = np.zeros(grid.shape, bool)
    mask[100:140, 200:260] = True
    fc = vector.mask_to_polygons(mask, grid.transform, grid.crs, grid.res_m)
    expected = 40 * 60 * grid.pixel_area_km2
    assert fc["patch_count"] == 1 and fc["features"][0]["properties"]["area_km2"] == pytest.approx(expected, rel=1e-3)
    extent = vector.union_geometry(fc)
    w, s, e, n = extent.bounds
    assert BBOX["west"] < w < e < BBOX["east"] and BBOX["south"] < s < n < BBOX["north"]
    points = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"asset_type": "hospital"},
         "geometry": {"type": "Point", "coordinates": [(w + e) / 2, (s + n) / 2]}},
        {"type": "Feature", "properties": {"asset_type": "school"},
         "geometry": {"type": "Point", "coordinates": [BBOX["west"] + 0.001, BBOX["south"] + 0.001]}},
    ]}
    inside = vector.points_inside(points, extent)
    assert [f["properties"]["asset_type"] for f in inside["features"]] == ["hospital"]
    assert vector.points_inside(points, None)["features"] == []
    empty = vector.mask_to_polygons(np.zeros((5, 5), bool), grid.transform, grid.crs, grid.res_m)
    assert empty["features"] == [] and vector.union_geometry(empty) is None


def test_slope_from_a_tilted_plane():
    dem = np.tile(np.arange(50, dtype="float32") * 10.0, (50, 1))   # rises 10 m per 10 m cell
    assert slope_degrees(dem, 10.0)[25, 25] == pytest.approx(45.0, abs=0.1)
    assert slope_degrees(np.zeros((10, 10), "float32"), 30.0).max() == 0.0


# â”€â”€ population â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def test_population_is_summed_inside_the_geometry_only():
    # 10Ã—10 cells of 0.01Â°, 5 people each (500 total); hazard covers the left 4 columns.
    values = np.full((10, 10), 5.0)
    values[0, 0] = np.nan                                # no-data cell is skipped, not counted
    transform = Affine(0.01, 0, 85.0, 0, -0.01, 28.0)
    hazard = box(85.0, 27.9, 85.04, 28.0)
    assert population.zonal_sum(values, transform, hazard) == pytest.approx(4 * 10 * 5 - 5)
    assert population.zonal_sum(values, transform, None) == 0.0
    # NOT area Ã— mean density: an uneven raster gives a different answer.
    uneven = np.zeros((10, 10))
    uneven[:, 9] = 50.0                                  # everyone lives in the far column
    assert population.zonal_sum(uneven, transform, hazard) == 0.0


def test_exposure_range_comes_from_dataset_disagreement():
    est = population.exposure_estimate(1000.0, area_hrsl=50_000.0, area_worldpop=65_000.0)
    assert (est["value"], est["low"], est["high"]) == (1000, 1000, 1300)
    assert est["dataset_ratio_worldpop_over_hrsl"] == 1.3
    single = population.exposure_estimate(1000.0, 50_000.0, None)
    assert single["low"] == single["high"] == 1000 and "Only one" in " ".join(single["notes"])


# â”€â”€ risk â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def test_risk_bands_matrix_and_unknown_vulnerability():
    assert [risk.hazard_level(a) for a in (0.1, 0.5, 5, 25)] == [0, 1, 2, 3]
    assert risk.exposure_level(50, None) == (0, False)
    assert risk.exposure_level(50, {"hospital": 1}) == (1, True)
    assert risk.exposure_level(20_000, {"hospital": 2}) == (3, True)
    assert risk.combine(3, 3) == 3 and risk.combine(2, 3) == 3 and risk.combine(0, 3) == 2

    a = risk.assess(detected=True, area_km2=6.0, area_low=0.3, area_high=9.0, confidence="probable",
                    population={"value": 4200, "low": 4200, "high": 5600},
                    assets={"status": "available", "counts": {"school": 3}})
    by = {c["name"]: c for c in a["components"]}
    assert a["level"] == "high" and a["complete"] is False
    assert by["hazard"]["label"] == "HIGH" and by["exposure"]["label"] == "HIGH"
    assert by["vulnerability"]["label"] == "UNKNOWN" and by["vulnerability"]["score"] is None
    assert a["range"] == {"low": "medium", "high": "high"}        # the low end of the extent is two bands down
    assert "Vulnerability is unknown" in a["explanation"]


def test_risk_without_population_or_detection_is_stated_not_scored():
    no_pop = risk.assess(detected=True, area_km2=6.0, area_low=5.5, area_high=7.0, confidence="high",
                         population=None, assets=None)
    assert no_pop["basis"] == "hazard only"
    assert next(c for c in no_pop["components"] if c["name"] == "exposure")["score"] is None
    none = risk.assess(detected=False, area_km2=0, area_low=0, area_high=0, confidence="not_detected",
                       population=None, assets=None)
    assert none["level"] == "low" and none["complete"] is True and none["basis"] == "nothing detected"
    veg = risk.assess(detected=True, area_km2=1.2, area_low=0.4, area_high=2.0, confidence="high",
                      population=None, assets=None, exposure_applicable=False)
    assert next(c for c in veg["components"] if c["name"] == "exposure")["label"] == "NOT APPLICABLE"



# â”€â”€ detector â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def _cleared_inputs():
    inputs = _veg_inputs()
    inputs["red_after"][50:80, 40:100] = 0.22         # 30Ã—60 px cleared, NDVI 0.8 â†’ ~0.2
    inputs["nir_after"][50:80, 40:100] = 0.33
    trees = np.zeros(SHAPE, bool)
    trees[:, 70:] = True                              # only the right half is forest
    inputs["tree_cover"] = trees
    return inputs


def test_forest_detector_counts_only_loss_on_tree_cover():
    det = REGISTRY["s2-forest-loss"].detect(_cleared_inputs(), RES)
    assert det.model.id == "s2-forest-loss"
    assert det.mask[65, 85] and not det.mask[65, 50]              # forest side only
    assert det.secondary["other_vegetation_loss"][65, 50]         # the rest is kept, separately
    assert not (det.mask & det.secondary["other_vegetation_loss"]).any()
    assert 700 <= det.area_px <= 900                              # 30Ã—30 px truth on trees
    assert det.metrics["all_vegetation_loss_px"] > det.area_px
    assert det.metrics["tree_cover_fraction"] == pytest.approx(0.65, abs=0.01)
    assert det.area_low_px <= det.area_px <= det.area_high_px


def test_forest_detector_finds_nothing_where_there_are_no_trees():
    inputs = _cleared_inputs()
    inputs["tree_cover"] = np.zeros(SHAPE, bool)
    det = REGISTRY["s2-forest-loss"].detect(inputs, RES)
    assert det.area_px == 0 and det.confidence == "not_detected"
    assert det.secondary["other_vegetation_loss"].sum() > 1500    # still reported, not as forest
    assert any("tree cover" in flag for flag in det.quality_flags)


def test_forest_analysis_is_registered_with_honest_wording():
    spec = pipeline.ANALYSES["forest_loss"]
    assert spec["detector"] == "s2-forest-loss" and spec["noun"] == "potential forest loss"
    meta = REGISTRY["s2-forest-loss"].metadata.as_dict()
    assert meta["evaluation"]["status"] == "not_evaluated"
    assert "not confirmed deforestation" in meta["limitations"][0]


# â”€â”€ Hansen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def test_hansen_tiles_are_named_by_their_top_left_corner():
    india = forest.hansen_tile_urls("lossyear", {"south": 15.1, "north": 15.4, "west": 74.5, "east": 74.8})
    assert len(india) == 1 and india[0].endswith("_lossyear_20N_070E.tif")
    amazon = forest.hansen_tile_urls("treecover2000", {"south": -3.4, "north": -3.1, "west": -60.4, "east": -60.1})
    assert amazon[0].endswith("_treecover2000_00N_070W.tif")
    south = forest.hansen_tile_urls("lossyear", {"south": -15.4, "north": -15.1, "west": 28.1, "east": 28.4})
    assert south[0].endswith("_lossyear_10S_020E.tif")
    edge = forest.hansen_tile_urls("lossyear", {"south": 19.9, "north": 20.1, "west": 79.9, "east": 80.1})
    assert len(edge) == 4                                         # an area on a tile corner needs all four


def test_hansen_years_stop_where_the_dataset_stops():
    assert forest.loss_years(date(2024, 2, 1), date(2025, 2, 1)) == ([2024, 2025], None)
    years, note = forest.loss_years(date(2025, 10, 1), date(2026, 10, 1))
    assert years == [2025] and "2026 is not covered" in note
    years, note = forest.loss_years(date(2026, 3, 1), date(2026, 9, 1))
    assert years == [] and note


def test_hansen_summary_separates_overlap_from_loss_elsewhere():
    lossyear = np.zeros((10, 10), "float32")
    canopy = np.full((10, 10), 80.0, "float32")
    lossyear[0:2, 0:5] = 25                 # 10 px lost in 2025
    lossyear[5, 5] = 12                     # an older loss: must not count
    canopy[0, 0] = 10                       # below the 30% forest baseline: must not count
    detected = np.zeros((10, 10), bool)
    detected[1, 0:3] = True
    out = forest.summarize_hansen(lossyear, canopy, detected, [2025], pixel_km2=0.01)
    assert out["status"] == "supporting"
    assert out["matching_annual_loss_km2"] == pytest.approx(0.09) and out["overlap_km2"] == pytest.approx(0.03)
    nearby = forest.summarize_hansen(lossyear, canopy, np.zeros((10, 10), bool), [2025], 0.01)
    assert nearby["status"] == "nearby_only" and nearby["overlap_km2"] == 0
    none = forest.summarize_hansen(lossyear, canopy, detected, [2020], 0.01)
    assert none["status"] == "no_matching_annual_loss"


def test_hansen_gaps_are_reported_not_filled(monkeypatch):
    grid = type("G", (), {"pixel_area_km2": 0.01})()
    out = forest.hansen_evidence(BBOX, grid, np.zeros((4, 4), bool), date(2026, 3, 1), date(2026, 9, 1))
    assert out["status"] == "not_covered" and out["matching_annual_loss_km2"] is None

    def fail(*args, **kwargs):
        raise pipeline.EOUnavailable("Satellite raster could not be read (RasterioIOError).")

    monkeypatch.setattr(forest, "read_mosaic", fail)
    out = forest.hansen_evidence(BBOX, grid, np.zeros((4, 4), bool), date(2024, 3, 1), date(2025, 3, 1))
    assert out["status"] == "unavailable" and "could not be read" in out["reason"]


# â”€â”€ hotspots â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def test_hotspots_are_the_largest_patches_with_centroids():
    def patch(i, area, x):
        return {"type": "Feature", "id": i, "properties": {"area_km2": area},
                "geometry": {"type": "Polygon", "coordinates": [[
                    [x, 15.0], [x + 0.02, 15.0], [x + 0.02, 15.02], [x, 15.02], [x, 15.0]]]}}

    spots = forest.hotspots({"features": [patch(0, 0.4, 74.0), patch(1, 2.5, 74.5), patch(2, 0.03, 75.0)]})
    assert [s["area_km2"] for s in spots] == [2.5, 0.4]            # sorted, 0.03 kmÂ² dropped
    assert spots[0]["longitude"] == pytest.approx(74.51) and spots[0]["latitude"] == pytest.approx(15.01)
    assert spots[0]["event_type"] == "potential_forest_loss"
    assert forest.hotspots({"features": []}) == []




# ---------------------------------------------------------------------------- additions for Bhu-Drishti

def test_forest_steps_include_the_evidence_stage_only_for_forest():
    assert "context" in [s["key"] for s in steps_for("forest_loss")]
    assert "context" not in [s["key"] for s in steps_for("water_change")]
    assert "population" in [s["key"] for s in steps_for("sar_flood")]
    assert "population" not in [s["key"] for s in steps_for("vegetation_change")]


class FakeFirms:
    def __init__(self, ok=True, rows=None, error=None):
        self.ok, self.rows, self.error = ok, rows or [], error

    def configured(self):
        return self.ok, "x"

    def detections(self, bbox, start, end):
        if self.error:
            raise self.error
        return self.rows, []


def test_firms_without_a_key_says_not_configured():
    out = forest.firms_evidence(BBOX, date(2025, 3, 20), source=FakeFirms(ok=False))
    assert out["status"] == "not_configured" and out["fire_detections"] is None
    assert "NASA_FIRMS_MAP_KEY" in out["reason"] and "do not prove" in out["note"]


def test_firms_counts_only_fires_inside_the_boundary():
    rows = [{"lat": 27.7, "lon": 85.3, "acq_date": "2025-03-02", "confidence": "nominal", "frp_mw": 4.2},
            {"lat": 27.7, "lon": 85.44, "acq_date": "2025-03-03", "confidence": "high", "frp_mw": 9.0}]
    out = forest.firms_evidence(BBOX, date(2025, 3, 20), geometry=box(85.2, 27.6, 85.35, 27.8), source=FakeFirms(rows=rows))
    assert out["status"] == "detected" and out["fire_detections"] == 1
    assert out["detections"][0] == {"latitude": 27.7, "longitude": 85.3, "date": "2025-03-02", "confidence": "nominal", "frp_mw": 4.2}
    none = forest.firms_evidence(BBOX, date(2025, 3, 20), source=FakeFirms())
    assert none["status"] == "not_detected" and none["fire_detections"] == 0


def test_firms_failures_are_reported_without_detail_that_could_leak_the_key():
    out = forest.firms_evidence(BBOX, date(2025, 3, 20), source=FakeFirms(error=SourceError("firms", "server", "url with SECRETKEY")))
    assert out["status"] == "error" and out["fire_detections"] is None and "SECRETKEY" not in json.dumps(out)
    out = forest.firms_evidence(BBOX, date(2025, 3, 20), source=FakeFirms(error=RuntimeError("SECRETKEY")))
    assert out["status"] == "error" and "SECRETKEY" not in json.dumps(out)


def test_fusion_counts_independent_forest_data_and_never_fire():
    both = forest.fuse(True, {"status": "supporting"}, {"status": "not_detected"})
    assert both["corroboration"] == "stronger" and both["not_a_calibrated_probability"] is True
    fire_only = forest.fuse(True, {"status": "nearby_only"}, {"status": "detected"})
    assert fire_only["corroboration"] == "supporting" and fire_only["independent_forest_evidence_sources"] == 1
    assert fire_only["indicators"]["firms_fire_detected"] is True
    assert forest.fuse(False, {"status": "supporting"}, {})["assessment"] == "no_detected_forest_loss"


def test_protected_areas_report_overlap_and_failure():
    class Resp:
        def raise_for_status(self):
            return None

        def json(self):
            ring = [{"lon": 85.2, "lat": 27.6}, {"lon": 85.3, "lat": 27.6}, {"lon": 85.3, "lat": 27.7}, {"lon": 85.2, "lat": 27.6}]
            return {"elements": [{"type": "way", "id": 1, "tags": {"name": "Park A", "boundary": "national_park"}, "geometry": ring}]}

    out = forest.protected_areas(BBOX, box(85.21, 27.60, 85.25, 27.62), post=lambda *a, **k: Resp())
    assert out["status"] == "available" and out["in_area"] == 1 and out["overlapping"][0]["name"] == "Park A"
    assert "geometry" not in out["overlapping"][0]
    away = forest.protected_areas(BBOX, box(85.40, 27.75, 85.44, 27.79), post=lambda *a, **k: Resp())
    assert away["overlapping"] == []

    def boom(*a, **k):
        raise TimeoutError("slow")

    assert forest.protected_areas(BBOX, None, post=boom)["status"] == "unavailable"


def test_a_wrong_offset_flag_is_overruled_by_the_pixel_values():
    dn = np.full((20, 20), 300.0)    # far below the 1000 offset, so it cannot still be in the data
    assert ix.s2_offset_present(dn, False) == (True, True)
    assert ix.s2_offset_present(dn + 1000, False) == (False, False)
    assert ix.s2_offset_present(dn, True) == (True, False)


def test_a_district_is_judged_on_its_boundary_not_on_its_rectangle():
    inputs = _veg_inputs()
    aoi = np.zeros(SHAPE, bool)
    aoi[:, :100] = True                # the district fills half of its rectangle
    inputs["aoi"] = aoi
    inputs["clear_before"] = inputs["clear_before"] & aoi
    inputs["clear_after"] = inputs["clear_after"] & aoi
    det = REGISTRY["s2-ndvi-change"].detect(inputs, RES)
    assert det.valid_fraction == pytest.approx(1.0)     # all of the district was seen: not "50% cloud-free"
    assert not any("cloud-free" in f for f in det.quality_flags)


def test_aoi_mask_rasterises_the_real_shape():
    grid = make_grid(BBOX)
    mask = aoi_mask(grid, box(85.2, 27.6, 85.325, 27.8))
    assert 0.45 < mask.mean() < 0.55 and mask[grid.height // 2, 5] and not mask[grid.height // 2, grid.width - 5]
    assert aoi_mask(grid, None).all()


def test_mosaic_choice_takes_scenes_that_add_clear_pixels_nearest_first():
    aoi = np.ones((10, 10), bool)
    left, right = np.zeros((10, 10), bool), np.zeros((10, 10), bool)
    left[:, :5], right[:, 5:] = True, True
    chosen, share = pipeline.choose_mosaic([left, None, left.copy(), right], aoi)
    assert chosen == [0, 3] and share == pytest.approx(1.0)      # unreadable and redundant scenes are skipped
    assert pipeline.choose_mosaic([left], aoi)[1] == pytest.approx(0.5)
    assert pipeline.choose_mosaic([None], aoi) == ([], 0.0)
    many = [np.arange(100).reshape(10, 10) % 20 == i for i in range(20)]
    assert len(pipeline.choose_mosaic(many, aoi, max_scenes=3)[0]) == 3


def _layer(value, clear_cols, flag=False):
    layer = {b: np.full((4, 4), value, "float32") for b in ("red", "green", "blue", "nir", "swir16")}
    clear = np.zeros((4, 4), bool)
    clear[:, clear_cols] = True
    return {**layer, "clear": clear, "flag_wrong": flag}


def test_merge_takes_the_nearest_clear_pixel_and_never_marks_cloud_clear():
    aoi = np.ones((4, 4), bool)
    aoi[3, :] = False
    out = pipeline.merge_s2([_layer(0.1, slice(0, 2)), _layer(0.2, slice(1, 3), flag=True)], "after", aoi)
    row = out["red_after"][0]
    assert row[0] == pytest.approx(0.1) and row[1] == pytest.approx(0.1)   # nearest scene wins where both are clear
    assert row[2] == pytest.approx(0.2)                                    # second scene fills the gap
    assert row[3] == pytest.approx(0.1) and not out["clear_after"][0, 3]   # cloud shown in the picture, never analysed
    assert np.isnan(out["red_after"][3, 0]) and not out["clear_after"][3].any()   # outside the boundary
    assert out["offset_flag_wrong_after"] is True and "swir_after" in out


def test_request_validation_and_default_dates():
    before, after = pipeline.default_dates("sar_flood", today=date(2026, 7, 30))
    assert after == date(2026, 7, 25) and before == date(2026, 7, 1)
    assert pipeline.default_dates("forest_loss", today=date(2026, 7, 30))[0] == date(2025, 7, 25)
    ok = {"south": 26.0, "north": 27.0, "west": 91.0, "east": 92.0}
    assert pipeline.validate_request("sar_flood", ok, date(2024, 7, 1), date(2024, 7, 20)) is None
    assert "Unknown" in pipeline.validate_request("nope", ok, date(2024, 7, 1), date(2024, 7, 20))
    wide = {**ok, "east": 96.0}
    assert "limited" in pipeline.validate_request("sar_flood", wide, date(2024, 7, 1), date(2024, 7, 20))
    assert "earlier" in pipeline.validate_request("sar_flood", ok, date(2024, 7, 20), date(2024, 7, 1))
    assert "future" in pipeline.validate_request("sar_flood", ok, date(2024, 7, 1), datetime.now(UTC).date() + timedelta(days=9))


def _record(**over):
    fc = {"type": "FeatureCollection", "features": [{"type": "Feature", "id": 0, "properties": {"area_km2": 2.0},
          "geometry": {"type": "Polygon", "coordinates": [[[85.2, 27.6], [85.3, 27.6], [85.3, 27.7], [85.2, 27.7], [85.2, 27.6]]]}}]}
    return {"detected": True, "area_km2": 2.0, "area_low_km2": 1.5, "area_high_km2": 2.5, "confidence": "probable", "geometry": fc,
            "population": {"value": 500, "low": 500, "high": 600}, "exposure_applicable": True, **over}


def test_finalize_counts_only_facilities_inside_the_extent():
    pts = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"asset_type": "hospital"}, "geometry": {"type": "Point", "coordinates": [85.25, 27.65]}},
        {"type": "Feature", "properties": {"asset_type": "school"}, "geometry": {"type": "Point", "coordinates": [85.40, 27.75]}}]}
    rec = pipeline.finalize(_record(), {"status": "available", "geojson": pts, "total": 2, "truncated": False})
    assert rec["assets_in_extent"]["counts"] == {"hospital": 1} and rec["assets_in_extent"]["area_total"] == 2
    assert next(c for c in rec["risk"]["components"] if c["name"] == "exposure")["status"] == "available"
    gone = pipeline.finalize(_record(), {"status": "unavailable", "reason": "Overpass timed out."})
    assert gone["assets_in_extent"]["reason"] == "Overpass timed out."


def test_overpass_elements_become_typed_facilities_and_failures_are_explicit():
    feats = assets.parse_elements([
        {"type": "node", "id": 1, "lat": 27.7, "lon": 85.3, "tags": {"amenity": "hospital", "name": "Civil Hospital"}},
        {"type": "way", "id": 2, "center": {"lat": 27.71, "lon": 85.31}, "tags": {"power": "substation"}},
        {"type": "node", "id": 3, "lat": 27.7, "lon": 85.3, "tags": {"amenity": "cafe"}}])
    assert [f["properties"]["asset_type"] for f in feats] == ["hospital", "power_substation"]
    assert feats[0]["properties"]["name"] == "Civil Hospital" and feats[1]["geometry"]["coordinates"] == [85.31, 27.71]
    box_, clamped = assets.clamp_bbox({"south": 20.0, "north": 25.0, "west": 80.0, "east": 81.0})
    assert clamped and box_["north"] - box_["south"] == pytest.approx(1.5) and box_["east"] - box_["west"] == pytest.approx(1.0)

    def boom(*a, **k):
        raise OSError("down")

    out = assets.fetch_assets({"south": 1.0, "north": 1.1, "west": 2.0, "east": 2.1}, post=boom)
    assert out["status"] == "unavailable" and out["total"] == 0 and "OSError" in out["reason"]


def test_clean_json_makes_results_servable():
    assert clean_json({"a": np.float32(1.5), "b": float("nan"), "c": [np.int64(2), np.bool_(True)], "d": (float("inf"),)}) == \
        {"a": 1.5, "b": None, "c": [2, True], "d": [None]}


class FakeProvider:
    def __init__(self):
        self.reg = Region("in-x", "Testpur", (85.2, 27.6, 85.45, 27.8), {"type": "Polygon", "coordinates": []}, False, kind="district", state="Bihar")

    def region(self, rid):
        return self.reg if rid == "in-x" else None

    def shape(self, rid):
        return box(85.2, 27.6, 85.45, 27.8)


def _wait(svc, job_id):
    svc.pool.shutdown(wait=True)
    return svc.get(job_id)


FAKE_RECORD = {"id": "x", "name": "Testpur", "sensor": "Sentinel-1", "forest": None, "population": None, "assets_in_extent": None,
               **_record(population=None, exposure_applicable=False), "noun": "probable inundation", "secondary": {}, "overlays": []}


def test_job_lifecycle_survives_a_restart_and_keeps_paths_safe(tmp_path, monkeypatch):
    def fake_run(kind, bbox, geometry, name, before, after, out_root, progress, record_id=None):
        progress("discovery", "ok", "found")
        (out_root / record_id).mkdir(exist_ok=True)
        (out_root / record_id / "change.png").write_bytes(b"png")
        return {**FAKE_RECORD, "id": record_id}

    monkeypatch.setattr(pipeline, "run_detection", fake_run)
    svc = DetectionService(FakeProvider(), tmp_path)
    job = svc.submit("sar_flood", "in-x", date(2024, 7, 1), date(2024, 7, 20))
    assert job["name"] == "Testpur" and job["before"] == "2024-07-01"
    done = _wait(svc, job["id"])
    assert done["status"] == "done" and done["summary"]["area_km2"] == 2.0 and done["record"]["risk"]["level"]
    assert next(s for s in done["steps"] if s["key"] == "discovery")["status"] == "ok"
    assert svc.overlay_path(job["id"], "change.png") is not None

    fresh = DetectionService(FakeProvider(), tmp_path)        # restart: served from disk
    again = fresh.get(job["id"])
    assert again["status"] == "done" and again["record"]["area_km2"] == 2.0

    for bad in ("../x.png", "change.tif", "..\\x.png", "a/b.png"):
        assert fresh.overlay_path(job["id"], bad) is None
    assert fresh.get("../../etc") is None and fresh.overlay_path("../x", "change.png") is None and fresh.delete("../x") is False
    assert fresh.delete(job["id"]) is True and fresh.get(job["id"]) is None and fresh.delete(job["id"]) is False


def test_jobs_report_failures_and_a_restart_does_not_leave_them_spinning(tmp_path, monkeypatch):
    def fail(*a, **k):
        raise EOUnavailable("No Sentinel-1 pass within 8 days.")

    monkeypatch.setattr(pipeline, "run_detection", fail)
    svc = DetectionService(FakeProvider(), tmp_path)
    job = svc.submit("sar_flood", "in-x", date(2024, 7, 1), date(2024, 7, 20))
    out = _wait(svc, job["id"])
    assert out["status"] == "failed" and out["error"] == "No Sentinel-1 pass within 8 days." and out["record"] is None
    assert all(s["status"] != "pending" for s in out["steps"])

    meta = tmp_path / "detections" / job["id"] / "job.json"
    meta.write_text(json.dumps({**json.loads(meta.read_text(encoding="utf-8")), "status": "running", "error": None}), encoding="utf-8")
    stale = DetectionService(FakeProvider(), tmp_path).get(job["id"])
    assert stale["status"] == "failed" and "restarted" in stale["error"]


def test_requests_for_simulated_or_oversized_areas_are_refused(tmp_path):
    svc = DetectionService(FakeProvider(), tmp_path)
    with pytest.raises(ValueError, match="simulated"):
        svc.submit("sar_flood", "demo-barpeta")
    with pytest.raises(ValueError, match="Unknown analysis"):
        svc.submit("nope", "in-x")
    with pytest.raises(ValueError, match="earlier"):
        svc.submit("sar_flood", "in-x", date(2024, 7, 20), date(2024, 7, 1))


def test_catalog_lists_every_method_with_its_limits(tmp_path):
    cat = DetectionService(FakeProvider(), tmp_path).catalog()
    assert {a["kind"] for a in cat["analyses"]} == set(pipeline.ANALYSES)
    assert all(a["model"]["limitations"] and a["default_before"] < a["default_after"] for a in cat["analyses"])


def test_explore_points_forest_and_vegetation_questions_at_change_detection():
    assert "Change detection" in classify("How much forest cover was lost?").message
    assert "Vegetation change" in classify("Show ndvi for my crop").message
    assert "cannot measure traffic" in classify("how is the traffic on the highway").message


def test_reads_use_the_coarsest_overview_that_is_still_fine_enough():
    levels = [2, 4, 8, 16, 32, 64]
    assert overview_level(levels, 10.0, 340.0) == 4      # 32Ã— = 320 m
    assert overview_level(levels, 10.0, 60.0) == 1       # 4Ã— = 40 m, never coarser than the grid
    assert overview_level(levels, 10.0, 10.0) is None    # native resolution: no overview
    assert overview_level([], 30.0, 500.0) is None       # the file has none


def test_filters_keep_their_physical_size_at_district_scale():
    assert speckle_window(10) == 5 and speckle_window(20) == 3 and speckle_window(60) == 1 and speckle_window(100) == 1
    assert use_opening(10) and use_opening(30) and not use_opening(60)
    inputs = _veg_inputs()
    inputs["red_after"][50:52, 20:60] = 0.22            # a strip 2 px wide: 120 m at 60 m per pixel
    inputs["nir_after"][50:52, 20:60] = 0.33
    assert REGISTRY["s2-ndvi-change"].detect(inputs, 60.0).area_px == 80
    assert REGISTRY["s2-ndvi-change"].detect(inputs, 10.0).area_px == 0   # at 10 m it is only 20 m wide: noise


def test_overpass_moves_to_the_next_server_when_one_is_overloaded():
    calls = []

    class Resp:
        def __init__(self, code):
            self.code = code

        def raise_for_status(self):
            if self.code != 200:
                raise httpx.HTTPStatusError("bad", request=httpx.Request("POST", "http://x"), response=httpx.Response(self.code))

        def json(self):
            return {"elements": [1]}

    def post(url, **kw):
        calls.append(url)
        return Resp(502 if len(calls) == 1 else 200)

    assert assets.overpass_query("q", post) == {"elements": [1]} and len(calls) == 2


def test_worldpop_json_is_found_behind_php_notices():
    text = '<br />\n<b>Deprecated</b>: Return type of Pimple\\Container::offsetExists($id) on line <b>133</b><br />\n{"error":false,"data":{"total_population":12.5}}'
    assert population.parse_worldpop(text)["data"]["total_population"] == 12.5
    with pytest.raises(ValueError):
        population.parse_worldpop("<b>Fatal error</b>")


# ---------------------------------------------------------------------------- InSAR and digital twins

def _scene(name, day, path=63, frame=488, direction="DESCENDING", pol="VV+VH", area=box(79, 30, 80.5, 31.5)):
    return SlcScene(name, datetime(*day, 0, 43, tzinfo=UTC), path, frame, direction, "Sentinel-1A", pol, area)


JOSHIMATH = box(79.53, 30.54, 79.59, 30.58)


def test_pair_stays_on_one_track_and_nearest_the_dates():
    scenes = [_scene("a", (2022, 12, 27)), _scene("b", (2023, 1, 8)), _scene("c", (2023, 1, 7), path=56, direction="ASCENDING"),
              _scene("d", (2022, 12, 31), path=129, direction="ASCENDING"), _scene("e", (2023, 1, 20))]
    pair = choose_pair(scenes, JOSHIMATH, date(2022, 12, 27), date(2023, 1, 8))
    assert (pair["reference"].name, pair["secondary"].name, pair["baseline_days"]) == ("a", "b", 12)
    assert pair["coverage"] == pytest.approx(1.0)


def test_pair_refuses_other_tracks_polarisations_and_poor_coverage():
    assert choose_pair([_scene("a", (2023, 1, 1)), _scene("b", (2023, 1, 13), path=56)], JOSHIMATH, date(2023, 1, 1), date(2023, 1, 13)) is None
    assert choose_pair([_scene("a", (2023, 1, 1)), _scene("b", (2023, 1, 13), pol="HH+HV")], JOSHIMATH, date(2023, 1, 1), date(2023, 1, 13)) is None
    far = box(70, 10, 71, 11)
    assert choose_pair([_scene("a", (2023, 1, 1), area=far), _scene("b", (2023, 1, 13), area=far)], JOSHIMATH, date(2023, 1, 1), date(2023, 1, 13)) is None
    assert choose_pair([_scene("a", (2023, 1, 1))], JOSHIMATH, date(2023, 1, 1), date(2023, 1, 13)) is None


def test_scene_parsing_skips_broken_records_and_names_are_stable():
    good = {"properties": {"sceneName": "S1A_x", "startTime": "2023-01-08T00:43:31Z", "pathNumber": 63, "frameNumber": 488, "flightDirection": "DESCENDING",
                           "platform": "Sentinel-1A", "polarization": "VV+VH"},
            "geometry": {"type": "Polygon", "coordinates": [[[79, 30], [80, 30], [80, 31], [79, 31], [79, 30]]]}}
    assert [s.path for s in parse_scenes([good, {"properties": {}}])] == [63]
    a = "S1A_IW_SLC__1SDV_20221227T004332_20221227T004400_046510_0592AA_64CA"
    b = "S1A_IW_SLC__1SDV_20230108T004331_20230108T004359_046685_059889_81E2"
    assert job_name(a, b, "10x2") == "bd-20221227T004332-20230108T004331-64CA81E2-10x2" and len(job_name(a, b, "10x2")) <= 100
    paths = product_paths("https://x/y.zip", "S1AA_abc.zip")
    assert paths["los"] == "/vsizip//vsicurl/https://x/y.zip/S1AA_abc/S1AA_abc_los_disp.tif" and paths["coherence"].endswith("_corr.tif")


def _interferogram(sigma_mm=3.0, seed=4):
    """A 200Ã—200 scene: the area is the centre square, with a 40Ã—40 px patch sinking 50 mm."""
    rng = np.random.default_rng(seed)
    los = rng.normal(0.012, sigma_mm / 1000.0, (200, 200)).astype("float32")     # 12 mm offset: the reference must remove it
    coh = np.full((200, 200), 0.8, "float32")
    aoi = np.zeros((200, 200), bool)
    aoi[50:150, 50:150] = True
    los[80:120, 80:120] -= 0.050
    return los, coh, aoi


def test_insar_finds_the_sinking_patch_relative_to_surrounding_ground():
    los, coh, aoi = _interferogram()
    r = insar.analyse(los, coh, aoi, 40.0)
    assert 1500 <= r.area_px <= 1650 and r.mask[100, 100] and not r.mask[60, 60]
    assert r.metrics["median_abs_mm"] == pytest.approx(50, abs=2) and r.metrics["reference"] == "the surrounding ground"
    assert r.metrics["max_away_mm"] < -45 and r.metrics["threshold_mm"] == 15.0
    assert r.confidence == "high" and r.flags == [] and r.area_low_px <= r.area_px <= r.area_high_px


def test_insar_ignores_a_uniform_offset_and_ordinary_noise():
    los, coh, aoi = _interferogram()
    los[80:120, 80:120] += 0.050
    r = insar.analyse(los, coh, aoi, 40.0)
    assert r.area_px == 0 and r.confidence == "not_detected" and "could be measured" in r.reasons[0]


def test_insar_raises_the_limit_when_the_scene_is_noisy():
    los, coh, aoi = _interferogram(sigma_mm=30.0)
    r = insar.analyse(los, coh, aoi, 40.0)
    assert r.metrics["threshold_mm"] > 60


def test_insar_never_measures_low_coherence_and_says_so():
    los, coh, aoi = _interferogram()
    coh[aoi] = 0.1
    r = insar.analyse(los, coh, aoi, 40.0)
    assert r.area_px == 0 and r.metrics["coherent_share"] == 0 and any("coherence" in f for f in r.flags)
    los, coh, aoi = _interferogram()
    coh[80:120, 80:120] = 0.1                          # the moving patch itself decorrelated
    assert insar.analyse(los, coh, aoi, 40.0).mask[100, 100] == False  # noqa: E712


def test_insar_flags_a_signal_that_follows_elevation():
    los, coh, aoi = _interferogram()
    dem = np.tile(np.linspace(1000, 3000, 200, dtype="float32"), (200, 1))
    los = los + (dem - 2000) * 2e-5
    r = insar.analyse(los, coh, aoi, 40.0, dem=dem)
    assert r.confidence == "uncertain" and any("elevation" in f for f in r.flags)


def test_insar_without_surrounding_ground_uses_the_area_and_warns():
    los, coh, aoi = _interferogram()
    coh[~aoi] = 0.0
    r = insar.analyse(los, coh, aoi, 40.0)
    assert r.metrics["reference"] == "the area itself" and r.confidence == "uncertain" and any("hides" in f for f in r.flags)


def test_insar_resolution_follows_area_size():
    assert insar.looks_for({"west": 79.5, "east": 79.6, "south": 30.5, "north": 30.6}) == "10x2"
    assert insar.looks_for({"west": 79.0, "east": 80.0, "south": 30.0, "north": 31.0}) == "20x4"
    assert insar.METADATA.as_dict()["evaluation"]["status"] == "not_evaluated"
    assert "does not show" in insar.METADATA.limitations[0]


class FakeHyp3:
    """Stands in for NASA ASF: counts submissions, succeeds on the second status check."""
    def __init__(self):
        self.submitted, self.checks = 0, 0

    def configured(self):
        return True, "x"

    def mark_used_end_to_end(self, detail):
        pass

    def search_slc(self, area, start, end):
        here = box(85, 27, 86, 28)     # over FakeProvider's district
        return [_scene("S1A_ref", (2022, 12, 27), area=here), _scene("S1A_sec", (2023, 1, 8), area=here)]

    def submit(self, a, b, looks):
        self.submitted += 1
        return {"job_id": "remote-1", "status_code": "PENDING"}

    def job(self, job_id):
        self.checks += 1
        return {"job_id": job_id, "status_code": "SUCCEEDED", "files": [{"url": "https://x/p.zip", "filename": "p.zip"}]}


def test_insar_job_runs_end_to_end_and_saves_a_readable_field(tmp_path, monkeypatch):
    import aeqe.sources.hyp3 as H

    fake = FakeHyp3()
    monkeypatch.setattr(H, "hyp3", lambda: fake)
    los, coh, aoi = _interferogram()

    def fake_grid(bbox, looks):
        return make_grid(insar.with_margin(bbox), max_pixels=40_000, min_res_m=40.0)

    def fake_layers(paths, grid):
        def fit(a):
            out = np.resize(a, grid.shape)
            return out.astype("float32")
        return {"los": fit(los), "coherence": fit(coh), "vertical": None, "dem": None}

    monkeypatch.setattr(insar, "analysis_grid", fake_grid)
    monkeypatch.setattr(insar, "read_layers", fake_layers)
    monkeypatch.setattr(pipeline, "exposure_block", lambda *a: (None, "skipped in test"))
    monkeypatch.setattr(assets, "fetch_assets", lambda bbox: {"status": "unavailable", "reason": "offline", "total": 0, "counts": {}, "geojson": {"type": "FeatureCollection", "features": []}})
    svc = DetectionService(FakeProvider(), tmp_path)
    job = svc.submit("ground_deformation", "in-x", date(2022, 12, 27), date(2023, 1, 8))
    svc.insar_pool.shutdown(wait=True)
    out = svc.get(job["id"])
    assert out["status"] == "done", out["error"]
    rec = out["record"]
    assert fake.submitted == 1 and out["hyp3"]["job_id"] == "remote-1" and out["hyp3"]["baseline_days"] == 12
    assert rec["kind"] == "ground_deformation" and rec["risk"]["level"] == "not_rated" and rec["deformation"]["looks"] == "10x2"
    assert {o["id"] for o in rec["overlays"]} == {"change", "coherence"} and svc.overlay_path(job["id"], "coherence.png")
    assert (tmp_path / "detections" / job["id"] / "displacement.npz").exists()
    assert next(s for s in out["steps"] if s["key"] == "processing")["status"] == "ok"


def test_insar_job_resumes_after_a_restart_without_paying_twice(tmp_path, monkeypatch):
    import aeqe.sources.hyp3 as H

    fake = FakeHyp3()
    monkeypatch.setattr(H, "hyp3", lambda: fake)
    monkeypatch.setattr(DetectionService, "_insar_result", lambda self, job, remote, geometry, paths, progress: job.update(summary={"resumed": True}))
    d = tmp_path / "detections" / "det-0123456789"
    d.mkdir(parents=True)
    (d / "job.json").write_text(json.dumps({"id": "det-0123456789", "kind": "ground_deformation", "label": "x", "region_id": "in-x", "name": "Testpur",
                                            "bbox": {"west": 85.2, "south": 27.6, "east": 85.45, "north": 27.8}, "before": "2022-12-27", "after": "2023-01-08",
                                            "status": "running", "error": None, "created_at": 1.0, "finished_at": None, "steps": steps_for("ground_deformation"),
                                            "summary": None, "hyp3": {"job_id": "remote-9", "looks": "10x2", "baseline_days": 12, "coverage": 1.0, "reference": {}, "secondary": {}}}), encoding="utf-8")
    svc = DetectionService(FakeProvider(), tmp_path)
    svc.insar_pool.shutdown(wait=True)
    assert fake.submitted == 0 and fake.checks == 1 and svc.get("det-0123456789")["status"] == "done"


def test_insar_refuses_clearly_without_a_login(tmp_path, monkeypatch):
    import aeqe.sources.hyp3 as H

    monkeypatch.setattr(H, "hyp3", lambda: type("N", (), {"configured": lambda self: (False, "missing")})())
    with pytest.raises(ValueError, match="EARTHDATA_TOKEN"):
        DetectionService(FakeProvider(), tmp_path).submit("ground_deformation", "in-x")


def test_twin_geometry_is_one_structure_not_a_city():
    assert twin.validate_geometry({"type": "Point", "coordinates": [91.7, 26.2]}).geom_type == "Point"
    with pytest.raises(ValueError, match="10 km"):
        twin.validate_geometry({"type": "LineString", "coordinates": [[91, 26], [92, 26]]})
    for bad in ({"type": "Nope"}, {"type": "Point", "coordinates": [500, 500]}, {}):
        with pytest.raises(ValueError):
            twin.validate_geometry(bad)


def test_osm_assets_keep_only_stated_facts_and_list_structures_first():
    rows = twin.parse_osm_assets([
        {"id": 1, "tags": {"highway": "primary", "name": "NH 27"}, "geometry": [{"lat": 26.1, "lon": 91.1}, {"lat": 26.2, "lon": 91.2}]},
        {"id": 2, "tags": {"bridge": "yes", "highway": "primary", "name": "Saraighat", "start_date": "1962", "material": "steel"}, "geometry": [{"lat": 26.1, "lon": 91.1}, {"lat": 26.2, "lon": 91.2}]},
        {"id": 3, "tags": {"bridge": "no", "highway": "tertiary"}, "geometry": [{"lat": 26.1, "lon": 91.1}, {"lat": 26.2, "lon": 91.2}]},
        {"id": 4, "tags": {"building": "hospital", "name": "Civil"}, "geometry": [{"lat": 1, "lon": 1}, {"lat": 1, "lon": 2}, {"lat": 2, "lon": 2}, {"lat": 1, "lon": 1}]},
        {"id": 5, "tags": {"bridge": "yes"}, "geometry": [{"lat": 1, "lon": 1}]},
    ])
    assert [r["osmId"] for r in rows] == ["way/2", "way/4", "way/1", "way/3"]
    assert rows[0]["attributes"] == {"constructionYear": "1962", "material": "steel"} and rows[0]["assetType"] == "bridge"
    assert rows[1]["geometry"]["type"] == "Polygon" and rows[2]["geometry"]["type"] == "LineString"


def _obs_record(**over):
    fc = {"type": "FeatureCollection", "truncated": False, "features": [{"type": "Feature", "id": 0, "properties": {"area_km2": 1.0},
          "geometry": {"type": "Polygon", "coordinates": [[[85.30, 27.70], [85.31, 27.70], [85.31, 27.71], [85.30, 27.71], [85.30, 27.70]]]}}]}
    return {"id": "det-a", "kind": "sar_flood", "label": "Flood", "noun": "probable inundation", "bbox": BBOX, "geometry": fc, "confidence": "probable", "quality_flags": [],
            "valid_fraction": 1.0, "grid": {"res_m": 60}, "before": {"acquired": "2024-01-01T00:00:00+00:00"}, "after": {"acquired": "2024-02-01T00:00:00+00:00"}, **over}


def test_observation_says_whether_a_detection_reaches_the_asset(tmp_path):
    inside = box(85.303, 27.703, 85.304, 27.704)
    away = box(85.40, 27.75, 85.401, 27.751)
    hit = twin.observe(_obs_record(), inside, tmp_path)
    assert hit["touches_asset"] is True and hit["overlap_share"] > 0.9 and hit["reading"] is None
    assert twin.observe(_obs_record(), away, tmp_path)["touches_asset"] is False
    assert twin.observe(_obs_record(), box(10, 10, 10.001, 10.001), tmp_path) is None     # analysis did not cover the asset


def test_observation_reads_the_saved_displacement_at_the_asset(tmp_path):
    grid = make_grid({"south": 27.70, "north": 27.72, "west": 85.30, "east": 85.32})
    field_mm = np.full(grid.shape, -20.0, "float32")
    field_mm[:, grid.width // 2:] = np.nan
    np.savez_compressed(tmp_path / "displacement.npz", relative_mm=field_mm, transform=np.array(grid.transform)[:6], crs=grid.crs)
    rec = _obs_record(kind="ground_deformation", bbox={"south": 27.70, "north": 27.72, "west": 85.30, "east": 85.32})
    seen = twin.observe(rec, box(85.303, 27.71, 85.304, 27.711), tmp_path, buffer_m=50)
    assert seen["reading"]["median_mm"] == -20.0 and seen["reading"]["measured_pixels"] > 0
    blank = twin.observe(rec, box(85.316, 27.71, 85.317, 27.711), tmp_path, buffer_m=50)
    assert blank["reading"]["measured_pixels"] == 0 and blank["reading"]["median_mm"] is None


def test_each_observation_is_compared_with_the_previous_one_of_its_kind():
    def obs(i, after, touches, mm=None, kind="ground_deformation"):
        return {"detection_id": i, "kind": kind, "after": after, "touches_asset": touches, "reading": {"median_mm": mm} if mm is not None else None}

    rows = twin.compare([obs("c", "2024-03", True, -30), obs("a", "2024-01", False, -5), obs("f", "2024-02-20", True, kind="sar_flood"), obs("b", "2024-02", False, -10)])
    assert [r["detection_id"] for r in rows] == ["a", "b", "f", "c"]
    by = {r["detection_id"]: r["change"] for r in rows}
    assert by["a"] is None and by["f"] is None
    assert by["b"]["median_mm_change"] == -5.0 and by["b"]["newly_touches_asset"] is False
    assert by["c"]["newly_touches_asset"] is True and by["c"]["median_mm_change"] == -20.0


def test_terrain_lines_are_fractions_of_the_square():
    grid = make_grid(BBOX, max_pixels=40_000, min_res_m=30.0)
    lines = twin.terrain_lines(box(85.3, 27.7, 85.31, 27.71).exterior, grid)
    assert all(0 <= u <= 1 and 0 <= v <= 1 for u, v in lines[0])
    point = twin.terrain_lines(shape({"type": "Point", "coordinates": [85.325, 27.7]}), grid)
    assert len(point[0]) == 1 and point[0][0][0] == pytest.approx(0.5, abs=0.02)


def test_osm_lookup_falls_back_to_a_smaller_query_when_servers_are_busy():
    asked = []

    class Resp:
        def __init__(self, code):
            self.code = code

        def raise_for_status(self):
            if self.code != 200:
                raise httpx.HTTPStatusError("busy", request=httpx.Request("POST", "http://x"), response=httpx.Response(self.code))

        def json(self):
            return {"elements": [{"id": 7, "tags": {"bridge": "yes", "name": "Core"}, "geometry": [{"lat": 26.1, "lon": 91.1}, {"lat": 26.2, "lon": 91.2}]}]}

    def post(url, data, **kw):
        asked.append(data["data"])
        return Resp(200 if "out geom 60" in data["data"] else 502)

    assert [a["name"] for a in twin.find_osm_assets(26.1, 91.1, post=post)] == ["Core"]
    assert "building" in asked[0] and "building" not in asked[-1]


def test_a_server_side_timeout_is_a_failure_not_an_empty_result():
    class Resp:
        def __init__(self, body):
            self.body = body

        def raise_for_status(self):
            return None

        def json(self):
            return self.body

    answers = [{"elements": [], "remark": "runtime error: Query timed out in \"query\" at line 1 after 26 seconds."}, {"elements": [1]}]
    assert assets.overpass_query("q", lambda url, **kw: Resp(answers.pop(0))) == {"elements": [1]}
    with pytest.raises(ValueError):
        assets.overpass_query("q", lambda url, **kw: Resp({"elements": [], "remark": "runtime error: out of memory"}))
    assert assets.overpass_query("q", lambda url, **kw: Resp({"elements": []})) == {"elements": []}   # truly nothing mapped
