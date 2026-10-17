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
"""

from __future__ import annotations

import asyncio
import json
import os
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


def make_provider():
    kind = os.getenv("AEQE_PROVIDER", "simulated")
    if kind == "planetary_computer":
        from .providers.planetary import PlanetaryComputerProvider

        return PlanetaryComputerProvider()
    from .providers.simulated import SimulatedProvider

    return SimulatedProvider(oracle_latency_s=float(os.getenv("AEQE_SIM_LATENCY", "0.12")))


DATA_DIR = Path(os.getenv("AEQE_DATA_DIR", "./data"))
provider = make_provider()
cache = ResultCache(os.getenv("AEQE_CACHE_PATH", str(DATA_DIR / "cache.sqlite")))
engine = Engine(provider, cache, DATA_DIR,
                EngineConfig(workers=int(os.getenv("AEQE_WORKERS", "8")), batch_size=int(os.getenv("AEQE_BATCH", "24"))))

app = FastAPI(title="AEQE — Anytime Earth-observation Query Engine", version=__version__)
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("AEQE_CORS", "*").split(","), allow_methods=["*"], allow_headers=["*"])


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
    try:
        return compile_question(req.question, region_id=req.region_id, overrides=req.overrides)
    except CompileError as e:
        raise HTTPException(422, str(e)) from e


@app.get("/health")
def health():
    llm = LLMCompiler()
    return {"ok": True, "version": __version__, "provider": provider.name,
            "compiler": llm.name if llm.enabled else "rules", "time": time.time()}


@app.get("/regions")
def regions():
    return [r.to_json() for r in provider.regions()]


@app.post("/compile")
def compile_endpoint(req: CompileRequest):
    cr = _compile(req)
    return {"compile": cr.to_json(), "plan": engine.plan(cr.ir)}


@app.post("/queries", status_code=201)
def start_query(req: QueryRequest):
    cr = _compile(req)
    plan = engine.plan(cr.ir)
    if not plan["ok"]:
        raise HTTPException(422, {"message": "input validation failed", "plan": plan, "compile": cr.to_json()})
    job = engine.submit(cr)
    return {"id": job.id, "compile": cr.to_json(), "plan": plan}


@app.get("/queries")
def list_queries():
    return [{"id": j.id, "status": j.status, "question": j.ir.question, "created_at": j.created_at}
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
