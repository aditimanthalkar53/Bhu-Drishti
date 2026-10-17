"""Shared plumbing for external Earth-observation data sources.

Every adapter in this package (Planetary Computer, Copernicus Data Space,
Earth Engine, NASA FIRMS, NASA Earthdata, Open-Meteo) builds on these pieces:

* ``SourceError`` — one error type with a ``kind`` so callers can tell an
  expired token from a quota problem from a missing scene, and decide whether
  a retry or a fallback makes sense.
* ``http_request`` — httpx with bounded retries, exponential backoff + jitter,
  ``Retry-After`` support, and no retries for permanent errors (400/401/403/404).
* ``redact`` — strips secrets from anything that might reach a log, a trace,
  an error message or the browser.
* ``Status`` — the operational ladder reported per source. A source only climbs
  a rung after the corresponding live check actually passed.
* ``Provenance`` — what supplied a piece of evidence (source, product, item,
  acquisition time, asset, resolution) so traces stay reproducible.
"""

from __future__ import annotations

import os
import random
import re
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Iterable, Optional

import httpx


class Status(str, Enum):
    NOT_CONFIGURED = "not_configured"
    CONFIGURED = "configured"                      # credentials present, not yet tried
    AUTHENTICATED = "authenticated"                # login/token works, data access unverified
    DISCOVERY_VERIFIED = "discovery_verified"      # catalogue / search returned real records
    RETRIEVAL_VERIFIED = "retrieval_verified"      # an actual asset or processing response was read
    E2E_VERIFIED = "e2e_verified"                  # consumed by a Bhu-Drishti workflow end to end
    BLOCKED = "blocked"                            # a precise, external reason prevents use


RANK = {s: i for i, s in enumerate([Status.NOT_CONFIGURED, Status.CONFIGURED, Status.AUTHENTICATED,
                                     Status.DISCOVERY_VERIFIED, Status.RETRIEVAL_VERIFIED, Status.E2E_VERIFIED])}


class SourceError(Exception):
    """kind: not_configured | auth | forbidden | not_found | rate_limited | quota | timeout |
    server | bad_request | network | unavailable | parse"""

    RETRYABLE = {"rate_limited", "timeout", "server", "network"}

    def __init__(self, source: str, kind: str, message: str, status_code: Optional[int] = None):
        super().__init__(f"[{source}] {kind}: {message}")
        self.source, self.kind, self.message, self.status_code = source, kind, message, status_code

    @property
    def retryable(self) -> bool:
        return self.kind in self.RETRYABLE

    def to_json(self) -> dict:
        return {"source": self.source, "kind": self.kind, "message": self.message, "status_code": self.status_code}


# ------------------------------------------------------------------------- secrets

_SECRET_ENV = ("CDSE_CLIENT_SECRET", "CDSE_CLIENT_ID", "NASA_FIRMS_MAP_KEY", "EARTHDATA_TOKEN", "EARTHDATA_PASSWORD",
               "ANTHROPIC_API_KEY", "AEQE_LLM_API_KEY")
_PATTERNS = [
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-~+/=]{8,}"),
    re.compile(r"(?i)(access_token|client_secret|token|map_key|api_key|password)=([^&\s\"']+)"),
    re.compile(r"(?i)(sig|se|sp|sv|sr|skoid|sktid|skt|ske|sks|skv)=[^&\s\"']+"),  # Azure SAS fields
]


def redact(text: Any, extra: Iterable[str] = ()) -> str:
    """Remove secret values and token-looking substrings from ``text``."""
    s = str(text)
    for k in _SECRET_ENV:
        v = os.getenv(k)
        if v and len(v) >= 6:
            s = s.replace(v, f"<{k.lower()}>")
    for v in extra:
        if v and len(v) >= 6:
            s = s.replace(v, "<secret>")
    s = _PATTERNS[0].sub(r"\1<redacted>", s)
    s = _PATTERNS[1].sub(lambda m: f"{m.group(1)}=<redacted>", s)
    s = _PATTERNS[2].sub(lambda m: m.group(0).split("=")[0] + "=<redacted>", s)
    return s


# ------------------------------------------------------------------------- HTTP

def classify_status(code: int, body: str = "") -> str:
    b = body.lower()
    if code == 401:
        return "auth"
    if code == 403:
        return "quota" if ("quota" in b or "processing units" in b or "limit" in b) else "forbidden"
    if code == 404:
        return "not_found"
    if code == 429:
        return "rate_limited"
    if code in (400, 405, 409, 413, 415, 422):
        return "bad_request"
    if code >= 500:
        return "server"
    return "unavailable"


def http_request(source: str, method: str, url: str, *, retries: int = 3, timeout: float = 60.0,
                 backoff: float = 1.0, client: Optional[httpx.Client] = None,
                 on_auth_error: Optional[Callable[[], dict]] = None, **kw) -> httpx.Response:
    """HTTP with bounded retries. Raises ``SourceError`` (message redacted).

    ``on_auth_error`` may refresh credentials once (returns new headers) when a
    401 arrives, e.g. an access token that expired between check and use.
    """
    refreshed = False
    last: Optional[SourceError] = None
    for attempt in range(retries + 1):
        try:
            if client is not None:
                r = client.request(method, url, timeout=timeout, **kw)
            else:
                r = httpx.request(method, url, timeout=timeout, **kw)
        except httpx.TimeoutException as e:
            last = SourceError(source, "timeout", redact(f"{type(e).__name__} after {timeout:g}s"))
        except httpx.HTTPError as e:
            last = SourceError(source, "network", redact(f"{type(e).__name__}: {e}"))
        else:
            if r.status_code < 400:
                return r
            body = r.text[:500]
            kind = classify_status(r.status_code, body)
            if kind == "auth" and on_auth_error is not None and not refreshed:
                refreshed = True
                kw["headers"] = {**kw.get("headers", {}), **on_auth_error()}
                continue
            last = SourceError(source, kind, redact(f"HTTP {r.status_code}: {body}"), r.status_code)
            if not last.retryable:
                raise last
            ra = r.headers.get("retry-after")
            if ra and ra.isdigit() and attempt < retries:
                time.sleep(min(float(ra), 30.0))
                continue
        if attempt < retries and last.retryable:
            time.sleep(backoff * (2 ** attempt) * (0.5 + random.random()))
    assert last is not None
    raise last


# ------------------------------------------------------------------------- provenance & capabilities

def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Provenance:
    source: str
    product: str
    item_id: Optional[str] = None
    acquired_start: Optional[str] = None
    acquired_end: Optional[str] = None
    published: Optional[str] = None       # when the provider made it available, if known
    asset: Optional[str] = None
    resolution_m: Optional[float] = None
    retrieved_at: str = field(default_factory=utcnow)
    url: Optional[str] = None             # always redacted
    extra: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        d = asdict(self)
        if d["url"]:
            d["url"] = redact(d["url"])
        return d


@dataclass
class Capability:
    product: str
    kind: str          # imagery | landcover | elevation | embedding | fire | rainfall | flood_aux | forecast | statistics | catalog
    description: str
    temporal: str
    resolution_m: Optional[float] = None
    latency: str = ""
    limitations: str = ""

    def to_json(self) -> dict:
        return asdict(self)


class Source:
    """Base class: identity, capabilities, configuration and live status."""

    id: str = ""
    name: str = ""
    homepage: str = ""
    requires: tuple[str, ...] = ()      # env vars needed (names only — values never reported)
    capabilities: list[Capability] = []
    concurrency: int = 4

    def __init__(self):
        self._sem = threading.BoundedSemaphore(self.concurrency)
        self._status = Status.CONFIGURED if self.configured()[0] else Status.NOT_CONFIGURED
        self._detail = self.configured()[1]
        self._checked_at: Optional[str] = None
        self._steps: list[dict] = []
        self._last_error: Optional[dict] = None
        self._e2e = False

    # -- configuration
    def configured(self) -> tuple[bool, str]:
        missing = [k for k in self.requires if not os.getenv(k)]
        return (not missing, "missing " + ", ".join(missing) if missing else "credentials present")

    # -- status bookkeeping
    def mark(self, status: Status, detail: str) -> None:
        if status == Status.BLOCKED or RANK.get(status, -1) >= RANK.get(self._status, -1) or self._status == Status.BLOCKED:
            self._status, self._detail = status, redact(detail)

    def mark_used_end_to_end(self, detail: str) -> None:
        self._e2e = True
        self.mark(Status.E2E_VERIFIED, detail)

    def record_error(self, e: Exception) -> None:
        self._last_error = e.to_json() if isinstance(e, SourceError) else {"kind": "error", "message": redact(e)}
        self._last_error["at"] = utcnow()

    def smoke_test(self) -> list[dict]:
        """Bounded, read-only live checks. Subclasses append steps via ``_step``."""
        return []

    def run_smoke_test(self) -> dict:
        self._steps = []
        ok, detail = self.configured()
        if not ok:
            self._status, self._detail = Status.NOT_CONFIGURED, detail
        else:
            self._status = Status.CONFIGURED
            try:
                self.smoke_test()
            except Exception as e:  # noqa: BLE001 — recorded as a failed step
                self.record_error(e)
        self._checked_at = utcnow()
        return self.status()

    def _step(self, name: str, fn: Callable[[], Any], on_ok: Optional[Status] = None,
              blocked_kinds: tuple[str, ...] = ("forbidden", "auth", "quota")) -> Any:
        t0 = time.perf_counter()
        try:
            out = fn()
        except Exception as e:  # noqa: BLE001
            err = e.to_json() if isinstance(e, SourceError) else {"kind": type(e).__name__, "message": redact(e)}
            self._steps.append({"step": name, "ok": False, "seconds": round(time.perf_counter() - t0, 2), "error": err})
            self.record_error(e)
            if isinstance(e, SourceError) and e.kind in blocked_kinds:
                self.mark(Status.BLOCKED, f"{name}: {e.message}")
            raise
        self._steps.append({"step": name, "ok": True, "seconds": round(time.perf_counter() - t0, 2),
                            "result": redact(out)[:400] if not isinstance(out, (dict, list)) else _short(out)})
        if on_ok is not None:
            self.mark(on_ok, name)
        return out

    def status(self) -> dict:
        return {
            "id": self.id, "name": self.name, "homepage": self.homepage,
            "status": self._status.value, "detail": self._detail, "checked_at": self._checked_at,
            "requires": list(self.requires), "configured": self.configured()[0],
            "capabilities": [c.to_json() for c in self.capabilities],
            "steps": self._steps, "last_error": self._last_error,
        }

    @property
    def usable(self) -> bool:
        return self.configured()[0] and self._status != Status.BLOCKED


def _short(obj: Any, limit: int = 400) -> Any:
    s = redact(obj)
    return s if len(s) <= limit else s[:limit] + "…"
