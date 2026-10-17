"""HTTP interface of the AEQE engine (FastAPI).

Endpoints (all JSON unless noted):

GET  /health                         liveness + provider + LLM compiler status
GET  /regions                        available regions (GeoJSON geometry)
POST /compile                        NL question → IR + validation checks + plan (no execution)
POST /queries                        compile (or accept an IR) and start an anytime run
GET  /queries                        list jobs
GET  /queries/{id}                   job summary (latest estimate / result)
GET  /queries/{id}/events            Server-Sent Events stream of plan/progress/result events
POST /queries/{id}/stop              stop now and keep the best interval so far
GET  /queries/{id}/universe          GeoJSON of every tile with proxy rank and stratum
GET  /queries/{id}/evidence          GeoJSON of sampled / selected tiles with oracle outputs
GET  /queries/{id}/trace             full execution trace (download)
POST /queries/{id}/replay            replay from cache with the same seed; verifies bit-identical result
POST /queries/{id}/exhaustive        run the oracle on every tile and compare (benchmark)
GET  /cache/stats | POST /cache/clear
GET  /regions/{id}                   one region with geometry
POST /regions                        register a custom area of interest (GeoJSON Polygon/MultiPolygon)
DELETE /regions/{id}                 remove a custom area of interest
GET  /regions/{id}/freshness         newest available acquisition per product for the region
GET  /sources                        status of every external data source (no secrets)
POST /sources/check                  run bounded live smoke tests (all, or ?source=id)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from . import __version__
from .cache import ResultCache
from .compiler import CompileError, CompileResult, LLMCompiler, compile_question
from .engine import Engine, EngineConfig
from .ir import QueryIR


DATA_DIR = Path(os.getenv("AEQE_DATA_DIR", "./data"))
log = logging.getLogger("aeqe")


def make_provider():
    """``AEQE_PROVIDER``: ``auto`` (default: demo districts simulated + every Indian district live),
    ``simulated`` (offline only) or ``live`` (no demo districts)."""
    from .providers.simulated import SimulatedProvider

    kind = os.getenv("AEQE_PROVIDER", "auto")
    sim = SimulatedProvider(oracle_latency_s=float(os.getenv("AEQE_SIM_LATENCY", "0.12")))
    if kind == "simulated":
        return sim
    from .providers.composite import CompositeProvider
    from .providers.live import LiveProvider
    from .sources.planetary import planetary

    ok, why = planetary().configured()
    if not ok:
        log.warning("live data disabled: %s", why)
        return CompositeProvider(sim, None)
    live = LiveProvider(DATA_DIR)
    if kind == "live":
        class _NoDemo(SimulatedProvider):
            def regions(self):
                return []
        return CompositeProvider(_NoDemo(), live)
    return CompositeProvider(sim, live)


def _config_report() -> None:
    """Log which credentials are present at startup — names only, never values."""
    from .sources.registry import all_sources

    for s in all_sources():
        ok, detail = s.configured()
        log.info("source %-18s %s (%s)", s.id, "configured" if ok else "NOT configured", detail)


provider = make_provider()
cache = ResultCache(os.getenv("AEQE_CACHE_PATH", str(DATA_DIR / "cache.sqlite")))
engine = Engine(provider, cache, DATA_DIR,
                EngineConfig(workers=int(os.getenv("AEQE_WORKERS", "8")), batch_size=int(os.getenv("AEQE_BATCH", "24")),
                             sequential=os.getenv("AEQE_SEQUENTIAL", "spending")))

app = FastAPI(title="AEQE — Bhu-Drishti Anytime Earth-observation Query Engine", version=__version__)
_cors = [o for o in os.getenv("AEQE_CORS", "http://localhost:4000").split(",") if o]
app.add_middleware(CORSMiddleware, allow_origins=_cors, allow_methods=["GET", "POST", "DELETE"], allow_headers=["*"])


@app.on_event("startup")
def _startup() -> None:
    logging.basicConfig(level=logging.INFO)
    _config_report()


class CompileRequest(BaseModel):
    question: str
    region_id: str
    overrides: dict[str, Any] = {}


class QueryRequest(BaseModel):
    question: Optional[str] = None
    region_id: Optional[str] = None
    overrides: dict[str, Any] = {}
    ir: Optional[QueryIR] = None


def _job(job_id: str):
    job = engine.jobs.get(job_id)
    if job is None:
        raise HTTPException(404, f"no job {job_id}")
    return job


def _compile(req: CompileRequest | QueryRequest) -> CompileResult:
    if getattr(req, "ir", None) is not None:
        return CompileResult(req.ir, "ir", [])
    if not req.question or not req.region_id:
        raise HTTPException(422, "question and region_id are required (or pass an ir)")
    r = provider.region(req.region_id)
    if r is None:
        raise HTTPException(422, f"unknown region '{req.region_id}'")
    try:
        return compile_question(req.question, region_id=req.region_id, overrides=req.overrides, live=not r.simulated)
    except CompileError as e:
        raise HTTPException(422, str(e)) from e


def _live():
    return getattr(provider, "live", None)


@app.get("/health")
def health():
    llm = LLMCompiler()
    return {"ok": True, "version": __version__, "provider": provider.name,
            "live_data": _live() is not None, "sequential": engine.config.sequential,
            "compiler": llm.name if llm.enabled else "rules", "time": time.time()}


@app.get("/regions")
def regions(geometry: bool = False, q: str = "", kind: str = ""):
    """All regions. Geometry is omitted by default (735 districts); filter with ?q=name&kind=district|custom|demo."""
    ql = q.strip().lower()
    out = []
    for r in provider.regions():
        if kind and r.kind != kind:
            continue
        if ql and ql not in r.name.lower() and ql not in r.state.lower() and ql not in r.id:
            continue
        out.append(r.to_json(geometry=geometry))
    return out


@app.get("/regions/{region_id}")
def region_detail(region_id: str):
    r = provider.region(region_id)
    if r is None:
        raise HTTPException(404, f"no region {region_id}")
    return r.to_json(geometry=True)


class AOIRequest(BaseModel):
    id: Optional[str] = None
    name: str
    geometry: dict
    description: str = ""


@app.post("/regions", status_code=201)
def add_region(req: AOIRequest):
    live = _live()
    if live is None:
        raise HTTPException(409, "custom areas need live data (install requirements-real.txt)")
    rid = req.id or f"aoi-{os.urandom(5).hex()}"
    if not re.fullmatch(r"aoi-[a-z0-9-]{3,60}", rid):
        raise HTTPException(422, "custom region ids must look like 'aoi-…' (lowercase letters, digits, dashes)")
    try:
        r = live.add_custom_region(rid, req.name.strip()[:120] or rid, req.geometry, req.description[:500])
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(422, str(e)) from e
    return r.to_json(geometry=True)


@app.delete("/regions/{region_id}")
def delete_region(region_id: str):
    live = _live()
    if live is None or not live.remove_custom_region(region_id):
        raise HTTPException(404, "no such custom region")
    return {"ok": True}


@app.get("/regions/{region_id}/freshness")
def freshness(region_id: str):
    live = _live()
    r = provider.region(region_id)
    if r is None:
        raise HTTPException(404, f"no region {region_id}")
    if r.simulated or live is None:
        return {"region_id": region_id, "simulated": True, "items": [], "note": "simulated demo district — no live data"}
    return live.freshness(region_id)


@app.get("/sources")
def sources():
    from .sources.registry import STATUS_HELP, status_report

    rep = status_report()
    for s in rep:
        s["status_label"] = STATUS_HELP.get(s["status"], s["status"])
    return rep


@app.post("/sources/check")
async def sources_check(source: str = ""):
    from .sources.registry import STATUS_HELP, all_sources, get

    try:
        targets = [get(source)] if source else all_sources()
    except KeyError as e:
        raise HTTPException(404, f"no source {source}") from e
    rep = await asyncio.gather(*[asyncio.to_thread(s.run_smoke_test) for s in targets])
    for s in rep:
        s["status_label"] = STATUS_HELP.get(s["status"], s["status"])
    return rep


def _quick(ir: QueryIR) -> bool:
    return provider.is_live(ir)


@app.post("/compile")
def compile_endpoint(req: CompileRequest):
    cr = _compile(req)
    return {"compile": cr.to_json(), "plan": engine.plan(cr.ir, quick=_quick(cr.ir))}


@app.post("/queries", status_code=201)
def start_query(req: QueryRequest):
    cr = _compile(req)
    plan = engine.plan(cr.ir, quick=_quick(cr.ir))
    if not plan["ok"]:
        raise HTTPException(422, {"message": "input validation failed", "plan": plan, "compile": cr.to_json()})
    job = engine.submit(cr)
    return {"id": job.id, "compile": cr.to_json(), "plan": plan}


@app.get("/queries")
def list_queries():
    return [{"id": j.id, "status": j.status, "question": j.ir.question, "created_at": j.created_at,
             "region_id": j.ir.region_id, "data_mode": "live" if j.live else "simulated"}
            for j in sorted(engine.jobs.values(), key=lambda j: -j.created_at)]


@app.get("/queries/{job_id}")
def get_query(job_id: str):
    return _job(job_id).summary()


@app.get("/queries/{job_id}/events")
async def events(job_id: str, request: Request, since: int = 0):
    job = _job(job_id)

    async def gen():
        cursor = since
        yield "retry: 2000\n\n"
        while True:
            if await request.is_disconnected():
                break
            new = await asyncio.to_thread(job.wait_events, cursor, 1.0)
            for ev in new:
                cursor = ev["seq"] + 1
                yield f"id: {ev['seq']}\nevent: {ev['type']}\ndata: {json.dumps(ev, default=str)}\n\n"
            if job.status not in ("queued", "running") and cursor >= len(job.events):
                yield "event: end\ndata: {}\n\n"
                break
            if not new:
                yield ": keep-alive\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/queries/{job_id}/stop")
def stop(job_id: str):
    _job(job_id)
    engine.stop(job_id)
    return {"ok": True}


@app.get("/queries/{job_id}/universe")
def universe(job_id: str):
    return engine.universe_geojson(_job(job_id))


@app.get("/queries/{job_id}/evidence")
def evidence(job_id: str):
    return engine.evidence_geojson(_job(job_id))


@app.get("/queries/{job_id}/trace")
def trace(job_id: str):
    _job(job_id)
    p = engine.trace_path(job_id)
    if not p.exists():
        raise HTTPException(409, "trace is written when the run finishes")
    return FileResponse(p, media_type="application/json", filename=f"aeqe-trace-{job_id}.json")


@app.post("/queries/{job_id}/replay")
async def replay(job_id: str):
    job = _job(job_id)
    if job.result is None:
        raise HTTPException(409, "job not finished")
    rj = engine.replay(job)
    for _ in range(600):
        if rj.status not in ("queued", "running"):
            break
        await asyncio.sleep(0.1)
    return {"replay_id": rj.id, **engine.verify_replay(job, rj)}


@app.post("/queries/{job_id}/exhaustive")
async def exhaustive(job_id: str, simulate_latency: bool = False):
    job = _job(job_id)
    try:
        return await asyncio.to_thread(engine.exhaustive, job, simulate_latency=simulate_latency)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


@app.get("/cache/stats")
def cache_stats():
    return cache.stats()


@app.post("/cache/clear")
def cache_clear():
    return {"deleted": cache.clear()}
