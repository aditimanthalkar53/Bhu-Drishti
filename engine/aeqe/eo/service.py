"""Change-detection jobs: a small worker pool and an on-disk store.

Each analysis lives in ``<data dir>/detections/<id>/`` (``job.json``, ``record.json`` and the PNG overlays), so finished
results, maps and failures survive an engine restart. A job that was running when the engine stopped is reported as
failed rather than left spinning forever.
"""

from __future__ import annotations

import json
import logging
import math
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Optional

import numpy as np

from ..sources.base import SourceError, redact
from . import EOUnavailable, assets, insar, pipeline, render, twin, vector
from .detectors import list_models

log = logging.getLogger("aeqe.eo")

ID_RE = re.compile(r"^det-[0-9a-f]{10}$")
FILE_RE = re.compile(r"^[a-z_]+\.png$")

STEPS = (("discovery", "Finding satellite imagery"), ("preprocess", "Reading and aligning rasters"),
         ("detection", "Detecting change"), ("vectorize", "Tracing patches"))
FOREST_STEP = (("context", "Independent forest evidence"),)
EXPOSURE_STEPS = (("population", "People inside the extent"), ("infrastructure", "Critical facilities inside the extent"))
RISK_STEP = (("risk", "Risk assessment"),)
INSAR_STEPS = (("pair", "Choosing two radar images from the same orbit"), ("processing", "NASA ASF computing the interferogram (20–90 minutes)"),
               ("preprocess", "Reading displacement and coherence"), ("detection", "Finding patches of movement"), ("vectorize", "Tracing patches"),
               ("population", "People inside the extent"), ("infrastructure", "Critical facilities inside the extent"))
INSAR_POLL_S = 60
INSAR_MAX_WAIT_S = 8 * 3600
INSAR_SEARCH_DAYS = 18      # either side of the requested dates


def steps_for(kind: str) -> list[dict[str, str]]:
    if kind == "ground_deformation":
        return [{"key": k, "label": label, "status": "pending", "detail": ""} for k, label in INSAR_STEPS]
    spec = pipeline.ANALYSES[kind]
    rows = STEPS + (FOREST_STEP if kind == "forest_loss" else ()) + (EXPOSURE_STEPS if spec["exposure"] else ()) + RISK_STEP
    return [{"key": k, "label": label, "status": "pending", "detail": ""} for k, label in rows]


def clean_json(v: Any) -> Any:
    """Plain JSON values only: numpy scalars become Python numbers, NaN/inf become null."""
    if isinstance(v, dict):
        return {str(k): clean_json(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean_json(x) for x in v]
    if isinstance(v, np.generic):
        v = v.item()
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


class DetectionService:
    def __init__(self, provider, data_dir: str | Path, workers: int = 2):
        self.provider = provider      # LiveProvider: districts and custom areas with real boundaries
        self.root = Path(data_dir) / "detections"
        self.root.mkdir(parents=True, exist_ok=True)
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="aeqe-eo")
        self.jobs: dict[str, dict[str, Any]] = {}
        self.lock = threading.Lock()
        # InSAR jobs mostly wait for NASA, so they must not occupy the slots of analyses that are working
        self.insar_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="aeqe-insar")
        self.insar_reads = threading.Semaphore(workers)
        self._resume_insar()

    # ------------------------------------------------------------------------ catalogue
    def catalog(self) -> dict[str, Any]:
        models = {m["id"]: m for m in list_models()}
        models[insar.METADATA.id] = insar.METADATA.as_dict()
        out = []
        for kind, spec in pipeline.ANALYSES.items():
            before, after = pipeline.default_dates(kind)
            out.append({"kind": kind, "label": spec["label"], "sensor": spec["sensor"], "noun": spec["noun"],
                        "exposure": spec["exposure"], "default_before": before.isoformat(), "default_after": after.isoformat(),
                        "model": models[spec["detector"]]})
        from ..sources.hyp3 import hyp3

        return {"analyses": out, "max_span_deg": pipeline.MAX_AOI_SPAN_DEG, "insar_configured": hyp3().configured()[0]}

    # ------------------------------------------------------------------------ jobs
    def submit(self, kind: str, region_id: str, before: Optional[date] = None, after: Optional[date] = None) -> dict[str, Any]:
        """Validate and queue one analysis. Raises ``ValueError`` with a user-facing reason."""
        if kind not in pipeline.ANALYSES:
            raise ValueError("Unknown analysis type.")
        region = self.provider.region(region_id)
        if region is None:
            raise ValueError(f"Unknown or simulated area '{region_id}': change detection needs real satellite data, so pick a live district or your own area.")
        d_before, d_after = pipeline.default_dates(kind)
        before, after = before or d_before, after or d_after
        x0, y0, x1, y1 = (float(v) for v in region.bbox)
        bbox = {"west": x0, "south": y0, "east": x1, "north": y1}
        err = pipeline.validate_request(kind, bbox, before, after)
        if err:
            raise ValueError(err)
        if kind == "ground_deformation":
            from ..sources.hyp3 import hyp3

            if not hyp3().configured()[0]:
                raise ValueError("Ground movement needs a free NASA Earthdata login: set EARTHDATA_TOKEN in the server settings.")
        job_id = f"det-{uuid.uuid4().hex[:10]}"
        job = {"id": job_id, "kind": kind, "label": pipeline.ANALYSES[kind]["label"], "region_id": region_id,
               "name": region.name, "state": region.state, "bbox": bbox, "before": before.isoformat(), "after": after.isoformat(),
               "status": "queued", "error": None, "created_at": time.time(), "finished_at": None, "steps": steps_for(kind), "summary": None}
        with self.lock:
            self.jobs[job_id] = job
        self._save(job)
        if kind == "ground_deformation":
            self.insar_pool.submit(self._run_insar, job_id)
        else:
            self.pool.submit(self._run, job_id, region_id, bbox, before, after)
        return json.loads(json.dumps(job))

    def _dir(self, job_id: str) -> Path:
        if not ID_RE.match(job_id):
            raise KeyError(job_id)
        return self.root / job_id

    def _save(self, job: dict[str, Any]) -> None:
        d = self._dir(job["id"])
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "job.json.tmp"
        with self.lock:
            tmp.write_text(json.dumps(clean_json(job)), encoding="utf-8")
        tmp.replace(d / "job.json")

    def _set_step(self, job: dict[str, Any], key: str, status: str, detail: str) -> None:
        with self.lock:
            for s in job["steps"]:
                if s["key"] == key:
                    s["status"], s["detail"] = status, redact(detail)

    def _run(self, job_id: str, region_id: str, bbox: dict[str, float], before: date, after: date) -> None:
        job = self.jobs[job_id]
        job["status"] = "running"
        self._save(job)

        def progress(key: str, status: str, detail: str) -> None:
            self._set_step(job, key, status, detail)
            self._save(job)

        try:
            geometry = self.provider.shape(region_id)
            record = pipeline.run_detection(job["kind"], bbox, geometry, job["name"], before, after, self.root, progress, record_id=job_id)
            found = None
            if record["exposure_applicable"]:
                found = self._facilities(record, progress)
            progress("risk", "running", "Combining hazard and exposure…")
            record = pipeline.finalize(record, found)
            progress("risk", "ok", f"{record['risk']['level'].upper()} — {record['risk']['basis']}.")
            record = clean_json(record)
            (self.root / job_id / "record.json").write_text(json.dumps(record), encoding="utf-8")
            job["summary"] = {"detected": record["detected"], "area_km2": record["area_km2"], "area_low_km2": record["area_low_km2"],
                              "area_high_km2": record["area_high_km2"], "confidence": record["confidence"],
                              "risk": record["risk"]["level"], "noun": record["noun"]}
            job["status"] = "done"
            self._mark_sources(record)
        except EOUnavailable as exc:
            job["status"], job["error"] = "failed", str(exc)
        except Exception as exc:  # noqa: BLE001 — a job failure is reported to the user, never raised into the pool
            log.exception("change detection %s failed", job_id)
            job["status"], job["error"] = "failed", redact(f"The analysis failed unexpectedly ({type(exc).__name__}: {str(exc)[:200]}).")
        job["finished_at"] = time.time()
        with self.lock:
            for s in job["steps"]:
                if s["status"] in ("pending", "running"):
                    s["status"] = "not_run" if job["status"] == "failed" else "skipped"
        self._save(job)

    # ------------------------------------------------------------------------ InSAR
    def _resume_insar(self) -> None:
        """NASA keeps processing while this engine restarts, so waiting jobs are picked up again, without paying twice."""
        for f in self.root.glob("det-*/job.json"):
            try:
                job = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if job.get("kind") == "ground_deformation" and job.get("status") in ("queued", "running"):
                self.jobs[job["id"]] = job
                self.insar_pool.submit(self._run_insar, job["id"])

    def _run_insar(self, job_id: str) -> None:
        job = self.jobs[job_id]
        job["status"] = "running"
        self._save(job)

        def progress(key: str, status: str, detail: str) -> None:
            self._set_step(job, key, status, detail)
            self._save(job)

        try:
            self._insar_steps(job, progress)
            job["status"] = "done"
        except EOUnavailable as exc:
            job["status"], job["error"] = "failed", str(exc)
        except SourceError as exc:
            job["status"], job["error"] = "failed", redact(f"NASA ASF request failed ({exc.kind}): {exc.message}")
        except Exception as exc:  # noqa: BLE001 — reported to the user, never raised into the pool
            log.exception("InSAR %s failed", job_id)
            job["status"], job["error"] = "failed", redact(f"The analysis failed unexpectedly ({type(exc).__name__}: {str(exc)[:200]}).")
        job["finished_at"] = time.time()
        with self.lock:
            for s in job["steps"]:
                if s["status"] in ("pending", "running"):
                    s["status"] = "not_run" if job["status"] == "failed" else "skipped"
        self._save(job)

    def _insar_steps(self, job: dict[str, Any], progress) -> None:
        from ..sources.hyp3 import choose_pair, hyp3, product_paths

        source = hyp3()
        bbox, geometry = job["bbox"], self.provider.shape(job["region_id"])
        if not job.get("hyp3"):
            progress("pair", "running", "Searching Sentinel-1 acquisitions…")
            before, after = date.fromisoformat(job["before"]), date.fromisoformat(job["after"])
            scenes = source.search_slc(geometry, before - timedelta(days=INSAR_SEARCH_DAYS), after + timedelta(days=INSAR_SEARCH_DAYS))
            pair = choose_pair(scenes, geometry, before, after)
            if pair is None:
                raise EOUnavailable("No two Sentinel-1 images from the same orbit cover this area near those dates. Try dates further apart.")
            ref, sec = pair["reference"], pair["secondary"]
            looks = insar.looks_for(bbox)
            progress("pair", "ok", f"{ref.acquired:%d %b %Y} and {sec.acquired:%d %b %Y}: {pair['baseline_days']} days apart, "
                                   f"track {ref.path} ({ref.direction.lower()}), {pair['coverage']:.0%} of the area.")
            progress("processing", "running", "Sending the pair to NASA ASF…")
            remote = source.submit(ref.name, sec.name, looks)
            job["hyp3"] = {"job_id": remote["job_id"], "looks": looks, "coverage": pair["coverage"], "baseline_days": pair["baseline_days"],
                           "reference": ref.to_json(), "secondary": sec.to_json()}
            self._save(job)
        waited = 0
        while True:
            remote = source.job(job["hyp3"]["job_id"])
            code = remote.get("status_code")
            if code == "SUCCEEDED":
                break
            if code == "FAILED":
                reasons = "; ".join(remote.get("logs") or []) or "no reason given"
                raise EOUnavailable(f"NASA ASF could not process this pair. {reasons[:200]}")
            if waited >= INSAR_MAX_WAIT_S:
                raise EOUnavailable("NASA ASF has not finished after 8 hours. Run the analysis again later: finished work is reused.")
            progress("processing", "running", f"NASA ASF status: {str(code).lower()}. This job continues even if the engine restarts.")
            time.sleep(INSAR_POLL_S)
            waited += INSAR_POLL_S
        progress("processing", "ok", "Interferogram ready.")
        with self.insar_reads:
            self._insar_result(job, remote, geometry, product_paths(remote["files"][0]["url"], remote["files"][0]["filename"]), progress)

    def _insar_result(self, job: dict[str, Any], remote: dict[str, Any], geometry, paths: dict[str, str], progress) -> None:
        from ..sources.hyp3 import hyp3

        h, bbox = job["hyp3"], job["bbox"]
        grid = insar.analysis_grid(bbox, h["looks"])
        progress("preprocess", "running", f"Reading displacement at {grid.res_m:.0f} m…")
        layers = insar.read_layers(paths, grid)
        aoi = pipeline.aoi_mask(grid, geometry)
        progress("preprocess", "ok", f"{grid.width}×{grid.height} px at {grid.res_m:.0f} m.")
        result = insar.analyse(layers["los"], layers["coherence"], aoi, grid.res_m, layers.get("vertical"), layers.get("dem"))
        if h["baseline_days"] > insar.LONG_BASELINE_DAYS:
            result.flags.append(f"The images are {h['baseline_days']} days apart. Long gaps lose coherence, and a large signal can wrap and be underestimated.")
        km2 = grid.pixel_area_km2
        detected = result.area_px > 0
        progress("detection", "ok", f"{result.area_px * km2:.2f} km² of possible movement ({result.confidence})." if detected else "No patch beyond the detection limit.")
        fc = vector.mask_to_polygons(result.mask, grid.transform, grid.crs, grid.res_m)
        progress("vectorize", "ok", f"{fc['patch_count']} patch(es).")
        pop, pop_error = pipeline.exposure_block(bbox, fc, detected, progress)
        record: dict[str, Any] = {
            "id": job["id"], "kind": job["kind"], "event_type": "ground_deformation", "name": job["name"], "label": job["label"],
            "noun": pipeline.ANALYSES[job["kind"]]["noun"], "bbox": bbox, "before": {**h["reference"], "coverage": h["coverage"]},
            "after": {**h["secondary"], "coverage": h["coverage"]}, "sensor": "Sentinel-1 InSAR", "model": insar.METADATA.as_dict(),
            "grid": {"crs": grid.crs, "res_m": grid.res_m, "width": grid.width, "height": grid.height}, "detected": detected,
            "confidence": result.confidence, "confidence_reasons": result.reasons, "quality_flags": result.flags,
            "valid_fraction": result.metrics["coherent_share"], "area_km2": round(result.area_px * km2, 4),
            "area_low_km2": round(min(result.area_low_px, result.area_px) * km2, 4), "area_high_km2": round(max(result.area_high_px, result.area_px) * km2, 4),
            "aoi_km2": round(float(aoi.sum()) * km2, 2), "metrics": result.metrics, "geometry": fc, "secondary": {},
            "overlays": [], "forest": None, "population": pop, "population_error": pop_error, "exposure_applicable": True,
            "deformation": {**result.metrics, "looks": h["looks"], "baseline_days": h["baseline_days"], "hyp3_job_id": remote.get("job_id"),
                            "note": "Relative line-of-sight movement. Positive is toward the satellite, negative is away from it."},
            "processing": {"pipeline": "HyP3 INSAR_GAMMA", "seconds": round(time.time() - job["created_at"], 1)},
        }
        out_dir = self.root / job["id"]
        np.savez_compressed(out_dir / "displacement.npz", relative_mm=result.relative_mm, transform=np.array(grid.transform)[:6], crs=grid.crs)
        disp = pipeline.display_grid(bbox)
        show = np.where(aoi, result.relative_mm, np.nan)
        record["overlays"].append(pipeline._overlay(out_dir, "change", "Line-of-sight movement, mm (±30 mm scale)", None,
                                                    render.diverging(pipeline._to_display(show, grid, disp, pipeline.Resampling.bilinear), 30.0)))
        coh = np.where(aoi, layers["coherence"], np.nan)
        record["overlays"].append(pipeline._overlay(out_dir, "coherence", "Coherence: bright areas can be measured", None,
                                                    render.grey_db(pipeline._to_display(coh, grid, disp, pipeline.Resampling.bilinear), 0.0, 1.0)))
        found = self._facilities(record, progress)
        record = pipeline.finalize(record, found)
        record["risk"] = {"level": "not_rated", "complete": False, "basis": "not rated", "range": None, "components": [],
                          "explanation": "No risk level is given: a movement signal needs field inspection before anyone can say what it means for a structure."}
        record = clean_json(record)
        (out_dir / "record.json").write_text(json.dumps(record), encoding="utf-8")
        job["summary"] = {"detected": detected, "area_km2": record["area_km2"], "area_low_km2": record["area_low_km2"], "area_high_km2": record["area_high_km2"],
                          "confidence": record["confidence"], "risk": "not_rated", "noun": record["noun"]}
        hyp3().mark_used_end_to_end(f"used by a ground-movement run for {job['name']}")

    # ------------------------------------------------------------------------ digital twin
    def observations(self, geometry: dict, detection_ids: list[str], buffer_m: float = twin.DEFAULT_BUFFER_M) -> list[dict[str, Any]]:
        """Each finished analysis read at the asset, oldest first, compared with the previous one of its kind."""
        geom = twin.validate_geometry(geometry)
        rows = []
        for job_id in detection_ids:
            try:
                d = self._dir(job_id)
            except KeyError:
                continue
            rec = d / "record.json"
            if rec.exists():
                seen = twin.observe(json.loads(rec.read_text(encoding="utf-8")), geom, d, buffer_m)
                if seen:
                    rows.append(seen)
        return clean_json(twin.compare(rows))

    def terrain(self, geometry: dict, detection_id: Optional[str] = None) -> dict[str, Any]:
        geom = twin.validate_geometry(geometry)
        npz = None
        if detection_id:
            try:
                npz = self._dir(detection_id) / "displacement.npz"
            except KeyError:
                npz = None
        return twin.terrain(geom, self.root.parent / "twin_terrain", npz)

    def _facilities(self, record: dict[str, Any], progress) -> Optional[dict[str, Any]]:
        if not record["detected"]:
            progress("infrastructure", "skipped", "Nothing detected, so no extent to check.")
            return None
        progress("infrastructure", "running", "Looking up hospitals, schools and other facilities…")
        west, south, east, north = vector.union_geometry(record["geometry"]).bounds
        found = assets.fetch_assets({"west": west, "south": south, "east": east, "north": north})
        progress("infrastructure", "ok" if found["status"] == "available" else "unavailable",
                 f"{found['total']} facilities in the surrounding box." if found["status"] == "available" else found.get("reason", ""))
        return found

    def _mark_sources(self, record: dict[str, Any]) -> None:
        from ..sources.opendata import earth_search, hansen_gfc, overpass, population_data

        where = f"used by a change-detection run for {record['name']}"
        if record["sensor"] == "Sentinel-2":
            earth_search().mark_used_end_to_end(where)
        forest = record.get("forest") or {}
        if (forest.get("hansen") or {}).get("status") not in (None, "unavailable", "not_covered"):
            hansen_gfc().mark_used_end_to_end(where)
        if record.get("population"):
            population_data().mark_used_end_to_end(where)
        if (record.get("assets_in_extent") or {}).get("status") == "available" or (forest.get("protected_areas") or {}).get("status") == "available":
            overpass().mark_used_end_to_end(where)

    # ------------------------------------------------------------------------ reads
    def get(self, job_id: str) -> Optional[dict[str, Any]]:
        """The job with its result, from memory or disk; ``None`` when unknown."""
        try:
            d = self._dir(job_id)
        except KeyError:
            return None
        with self.lock:
            live = self.jobs.get(job_id)
            job = json.loads(json.dumps(clean_json(live))) if live else None
        if job is None:
            f = d / "job.json"
            if not f.exists():
                return None
            job = json.loads(f.read_text(encoding="utf-8"))
            if job["status"] in ("queued", "running"):     # the engine restarted while this job ran
                job["status"], job["error"] = "failed", "The engine restarted during this analysis. Run it again."
        rec = d / "record.json"
        job["record"] = json.loads(rec.read_text(encoding="utf-8")) if job["status"] == "done" and rec.exists() else None
        return job

    def overlay_path(self, job_id: str, file: str) -> Optional[Path]:
        if not FILE_RE.match(file):
            return None
        try:
            p = self._dir(job_id) / file
        except KeyError:
            return None
        return p if p.is_file() else None

    def delete(self, job_id: str) -> bool:
        try:
            d = self._dir(job_id)
        except KeyError:
            return False
        with self.lock:
            live = self.jobs.get(job_id)
            if live and live["status"] in ("queued", "running"):
                raise ValueError("This analysis is still running; delete it when it has finished.")
            self.jobs.pop(job_id, None)
        if not d.exists():
            return False
        shutil.rmtree(d, ignore_errors=True)
        return True
