import threading
import time

from aeqe.cache import ResultCache
from aeqe.compiler import compile_question
from aeqe.engine import Engine, EngineConfig
from aeqe.providers.simulated import SimulatedProvider


def test_stop_during_preparation_ends_job_promptly(tmp_path):
    prov = SimulatedProvider(oracle_latency_s=0.0)
    gate = threading.Event()
    real = prov.universe

    def slow_universe(ir):   # stands in for a minutes-long live district preparation
        gate.wait(10)
        return real(ir)

    prov.universe = slow_universe
    eng = Engine(prov, ResultCache(), tmp_path, EngineConfig(workers=2))
    job = eng.submit(compile_question("What percentage of cropland was flooded during 1-15 July 2023?", region_id="lower-brahmaputra-a"))
    time.sleep(0.3)
    assert job.status == "running"
    t0 = time.time()
    eng.stop(job.id)
    while job.status == "running" and time.time() - t0 < 3:
        time.sleep(0.05)
    gate.set()
    assert job.status == "stopped"
    assert time.time() - t0 < 2
    assert job.result["stop_reason"] == "user_stop" and job.result["n"] == 0
    assert any(e["type"] == "result" for e in job.events)
