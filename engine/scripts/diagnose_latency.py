"""Why is Bhu-Drishti slow on THIS machine?  Run from the engine folder:

    python scripts/diagnose_latency.py          (use the engine's virtualenv)

It times each step a live query depends on and prints a verdict, so team members can compare results.
It is read-only: it downloads at most ~1 MB and writes nothing.
"""
from __future__ import annotations

import os
import platform
import socket
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "engine"
sys.path.insert(0, str(ENGINE))
RESULTS: list[tuple[str, str, str]] = []   # (check, value, verdict)


def note(check: str, value: str, verdict: str = "") -> None:
    RESULTS.append((check, value, verdict))
    print(f"  {check:<46} {value:<28} {verdict}", flush=True)


def timed(fn):
    t = time.perf_counter()
    try:
        out = fn()
        return time.perf_counter() - t, out, None
    except Exception as e:  # noqa: BLE001
        return time.perf_counter() - t, None, e


def http_time(url: str, timeout: float = 25.0, rng: str | None = None):
    def go():
        req = urllib.request.Request(url, headers={"User-Agent": "bhu-drishti-diagnose", **({"Range": rng} if rng else {})})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return len(r.read())
    return timed(go)


def dotenv() -> dict:
    out = {}
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf8", errors="ignore").splitlines():
            line = line.split("#")[0].strip() if not line.strip().startswith("#") else ""
            if "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


print("\n=== 1. This machine ===")
note("OS / Python", f"{platform.system()} {platform.release()} / {platform.python_version()}")
note("CPU cores", str(os.cpu_count()), "few cores slow raster decoding" if (os.cpu_count() or 0) < 4 else "ok")
try:
    import psutil  # type: ignore
    gb = psutil.virtual_memory().total / 1e9
    note("RAM", f"{gb:.1f} GB", "low: may swap" if gb < 8 else "ok")
except ImportError:
    note("RAM", "psutil not installed", "skipped")
note("Proxy / VPN env vars", ",".join(k for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy") if os.environ.get(k)) or "none",
     "traffic goes through a proxy: can be slow" if any(os.environ.get(k) for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")) else "ok")

print("\n=== 2. Settings that change speed (.env) ===")
env = dotenv()
for k, expect in (("GDAL_HTTP_RETRY_CODES", "429,500,502,503,504"), ("GDAL_HTTP_MAX_RETRY", "4"), ("GDAL_HTTP_TIMEOUT", "60"),
                  ("AEQE_WORKERS", "12 (default)"), ("AEQE_PROVIDER", "auto"), ("AEQE_SEQUENTIAL", "spending")):
    v = env.get(k, "(not set)")
    flag = ""
    if k == "GDAL_HTTP_RETRY_CODES" and v.strip().upper() == "ALL":
        flag = "SLOW: retries 403 for minutes. Set 429,500,502,503,504"
    note(k, v, flag)
for k in ("NASA_FIRMS_MAP_KEY", "CDSE_CLIENT_ID", "EARTHDATA_TOKEN"):
    note(k, "set" if env.get(k) else "MISSING", "" if env.get(k) else "that evidence/source will be unavailable or slow")

print("\n=== 3. Network: how far is the data? ===")
for name, url in (("Planetary Computer catalogue (STAC)", "https://planetarycomputer.microsoft.com/api/stac/v1"),
                  ("Copernicus Data Space", "https://catalogue.dataspace.copernicus.eu/odata/v1/Products?%24top=1"),
                  ("NASA FIRMS", "https://firms.modaps.eosdis.nasa.gov/api/"),
                  ("Open-Meteo", "https://api.open-meteo.com/v1/forecast?latitude=26&longitude=91&daily=precipitation_sum&forecast_days=1")):
    dt, n, err = http_time(url)
    if err:
        note(name, f"FAILED after {dt:.1f}s", f"{type(err).__name__}: this is a major cause of delay")
    else:
        note(name, f"{dt:.2f}s", "slow" if dt > 3 else "ok")
for host in ("sentinel1euwestrtc.blob.core.windows.net", "elevationeuwest.blob.core.windows.net"):
    try:
        t = time.perf_counter(); socket.create_connection((host, 443), timeout=10).close()
        dt = time.perf_counter() - t
        note(f"Connect to {host.split('.')[0]}", f"{dt*1000:.0f} ms", "far: most pixels come from West Europe" if dt > 0.25 else "ok")
    except Exception as e:  # noqa: BLE001
        note(f"Connect to {host.split('.')[0]}", "FAILED", type(e).__name__)

print("\n=== 4. A real satellite read (the step each tile repeats) ===")
try:
    from aeqe.sources.planetary import PlanetarySource, fresh_signed
    pc = PlanetarySource()
    bbox = (90.95, 26.30, 91.00, 26.35)   # a small window near Barpeta
    dt, items, err = timed(lambda: pc.search("sentinel-1-rtc", bbox, date.today() - timedelta(days=60), date.today(), limit=3))
    if err or not items:
        note("STAC search (small)", f"FAILED after {dt:.1f}s" if err else f"{dt:.1f}s, 0 items", str(err)[:60] if err else "no recent scenes")
    else:
        note("STAC search (small)", f"{dt:.1f}s", "slow" if dt > 5 else "ok")
        href = fresh_signed(items[:1])[0].assets["vv"].href
        dt, n, err = http_time(href, 40, rng="bytes=0-999999")
        if err:
            note("Download 1 MB of a radar image", f"FAILED after {dt:.1f}s", type(err).__name__)
        else:
            mbps = (n * 8 / 1e6) / max(dt, 1e-6)
            note("Download 1 MB of a radar image", f"{dt:.1f}s ({mbps:.1f} Mbit/s)", "slow link to the data" if mbps < 5 else "ok")
        dt, ds, err = timed(lambda: pc.load(items[:1], ["vv"], bbox, 0.002))
        note("Read a small radar window (like one tile)", f"FAILED after {dt:.1f}s" if err else f"{dt:.1f}s",
             str(err)[:50] if err else ("slow: x hundreds of tiles = minutes" if dt > 4 else "ok"))
except Exception as e:  # noqa: BLE001
    note("Satellite read test", "could not run", f"{type(e).__name__}: {e}"[:70])

print("\n=== 5. Local caches (a cold cache means a slow first run) ===")
static = ENGINE / "data" / "static"
n_static = len(list(static.glob("*.npz"))) if static.exists() else 0
note("Cached district land-cover files", str(n_static), "none: first run in each district is slow" if n_static == 0 else "ok (these districts start fast)")
for fn in ("cache.sqlite", "sources.sqlite"):
    f = ENGINE / "data" / fn
    note(f"{fn}", f"{f.stat().st_size/1e6:.1f} MB" if f.exists() else "absent", "" if f.exists() else "cold cache")
traces = ENGINE / "data" / "traces"
note("Saved run traces", str(len(list(traces.glob('*.json')))) if traces.exists() else "0")

print("\n=== 6. Software version ===")
try:
    src = (ENGINE / "aeqe" / "sources" / "planetary.py").read_text(encoding="utf8")
    note("Has expired-link fix (fresh_signed)", "yes" if "def fresh_signed" in src else "NO", "" if "def fresh_signed" in src else "OLD CODE: pull the latest version")
    note("Has catalogue timeout fix", "yes" if "AEQE_STAC_READ_S" in src else "NO", "" if "AEQE_STAC_READ_S" in src else "OLD CODE: pull the latest version")
except Exception as e:  # noqa: BLE001
    note("Code version", "unreadable", str(e)[:60])
try:
    r = urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3)
    note("Engine running on :8000", "yes", "if it has run for days, restart it (stale links)")
except Exception:  # noqa: BLE001
    note("Engine running on :8000", "no", "start it before asking questions")

print("\n=== Summary (share this with the team) ===")
bad = [r for r in RESULTS if r[2] and any(w in r[2].lower() for w in ("slow", "failed", "old code", "major", "far", "missing", "cold", "none:", "proxy"))]
if not bad:
    print("  Nothing obviously wrong here.")
for c, v, m in bad:
    print(f"  - {c}: {v}  ->  {m}")
