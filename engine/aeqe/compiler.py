"""Natural language → QueryIR.

Two front ends produce the same typed IR:

* ``RuleCompiler`` — deterministic, offline, covers the supported question
  families (flood share, built-up change, kiln count/locate, point inspection).
* ``LLMCompiler`` — one LLM call (Anthropic API, or any OpenAI-compatible
  endpoint such as a local Ollama/vLLM server) that returns IR JSON. Its output
  is validated by the same pydantic model; if anything fails, the engine falls
  back to the rule compiler and says so.

The LLM is called once per question to plan — not once per tool step — which
removes the dominant latency of ReAct-style agents.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

import httpx
from pydantic import ValidationError

from .ir import Point, QueryIR, Target, Task

MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"])}
MONTHS.update({k[:3]: v for k, v in list(MONTHS.items())})
MONTHS["sept"] = 9

FLOOD_WORDS = r"flood|inundat|submerg|waterlog|water-log|under water"
BUILT_WORDS = r"construct|built[- ]?up|urban|building|settlement|expansion|sprawl|development"
KILN_WORDS = r"kiln|brick"


@dataclass
class CompileResult:
    ir: QueryIR
    parser: str
    assumptions: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "ir": json.loads(self.ir.model_dump_json()),
            "parser": self.parser,
            "assumptions": self.assumptions,
            "warnings": self.warnings,
        }


class CompileError(ValueError):
    pass


def _month_end(y: int, m: int) -> date:
    return (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))


def parse_dates(text: str) -> tuple[Optional[date], Optional[date], Optional[date], Optional[date], list[str]]:
    """Return (start, end, baseline_start, baseline_end, notes)."""
    t = text.lower()
    notes: list[str] = []
    iso = re.findall(r"(\d{4})-(\d{2})-(\d{2})", t)
    if len(iso) >= 2:
        d = [date(int(a), int(b), int(c)) for a, b, c in iso[:2]]
        return min(d), max(d), None, None, notes
    if len(iso) == 1:
        d = date(*map(int, iso[0]))
        return d, d + timedelta(days=14), None, None, ["single date given → 15-day window"]

    mon = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
    # "1–15 July 2023" / "1-15 jul 2023"
    m = re.search(r"(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+" + mon + r"\s+(\d{4})", t)
    if m:
        mm = MONTHS[m.group(3)[:3] if m.group(3)[:4] != "sept" else "sept"]
        y = int(m.group(4))
        return date(y, mm, int(m.group(1))), date(y, mm, int(m.group(2))), None, None, notes
    # "July 1 to July 15, 2023" is rarer; "July 2023"
    m = re.search(mon + r"\s+(\d{4})", t)
    if m:
        mm = MONTHS[m.group(1)[:3] if m.group(1)[:4] != "sept" else "sept"]
        y = int(m.group(2))
        return date(y, mm, 1), _month_end(y, mm), None, None, notes
    m = re.search(r"monsoon\s+(?:of\s+)?(\d{4})|(\d{4})\s+monsoon", t)
    if m:
        y = int(m.group(1) or m.group(2))
        return date(y, 6, 1), date(y, 9, 30), None, None, notes
    # change windows: "between 2020 and 2024", "from 2020 to 2024", "since 2020"
    m = re.search(r"(?:between|from)\s+(\d{4})\s+(?:and|to|-|–)\s+(\d{4})", t) or re.search(r"(\d{4})\s*(?:-|–|to)\s*(\d{4})", t)
    if m:
        y0, y1 = sorted((int(m.group(1)), int(m.group(2))))
        return date(y1, 1, 1), date(y1, 12, 31), date(y0, 1, 1), date(y0, 12, 31), notes
    m = re.search(r"since\s+(\d{4})", t)
    if m:
        y0 = int(m.group(1))
        return None, None, date(y0, 1, 1), date(y0, 12, 31), ["'since' → target year assumed to be the latest in the archive"]
    m = re.search(r"\b(?:in|during|for)\s+(\d{4})\b", t) or re.search(r"\b(20\d{2})\b", t)
    if m:
        y = int(m.group(1))
        return date(y, 1, 1), date(y, 12, 31), None, None, notes
    return None, None, None, None, notes


class RuleCompiler:
    name = "rules"

    def compile(self, question: str, *, region_id: str, overrides: Optional[dict] = None,
                latest_year: int = 2025) -> CompileResult:
        q = question.strip()
        t = q.lower()
        assumptions: list[str] = []
        overrides = dict(overrides or {})

        # ---- target
        if re.search(KILN_WORDS, t):
            target = Target.BRICK_KILN
        elif re.search(FLOOD_WORDS, t):
            target = Target.FLOODED_CROPLAND
        elif re.search(BUILT_WORDS, t):
            target = Target.NEW_BUILTUP
        elif "target" in overrides:
            target = Target(overrides["target"])
        else:
            raise CompileError(
                "Couldn't tell what to measure. Supported targets: flooded cropland, new built-up area / construction, brick kilns."
            )

        # ---- point (inspect)
        point = None
        m = re.search(r"(-?\d{1,2}\.\d+)\s*°?\s*([ns])?\s*[, ]\s*(-?\d{1,3}\.\d+)\s*°?\s*([ew])?", t)
        if m:
            lat, lon = float(m.group(1)), float(m.group(3))
            if m.group(2) == "s":
                lat = -lat
            if m.group(4) == "w":
                lon = -lon
            point = Point(lon=lon, lat=lat)
        if "point" in overrides and overrides["point"]:
            point = Point(**overrides["point"])

        # ---- task
        if point is not None and re.search(r"\bis there\b|\bis this\b|\bat (this|the) (point|location|place)\b|\bhere\b|\bnear\b|\baround\b|\bat\b", t):
            task = Task.INSPECT
        elif re.search(r"\b(find|locate|where are|where is|map (all|every)|show (me )?(all|every)|list (all|every)|every)\b", t):
            task = Task.FIND_ALL
        elif target == Target.BRICK_KILN:
            task = Task.COUNT
        elif target == Target.FLOODED_CROPLAND and re.search(r"%|percent|percentage|share|fraction|proportion|portion|what part|how much of", t):
            task = Task.AREA_FRACTION
        elif target == Target.FLOODED_CROPLAND and re.search(r"how much|area|km|hectare|acre", t):
            task = Task.TOTAL
        elif target == Target.FLOODED_CROPLAND:
            task = Task.AREA_FRACTION
            assumptions.append("no unit asked for → reporting the share of cropland flooded")
        else:
            task = Task.TOTAL
        if "task" in overrides and overrides["task"]:
            task = Task(overrides.pop("task"))

        # ---- dates
        start, end, b0, b1, notes = parse_dates(t)
        assumptions += notes
        if target == Target.NEW_BUILTUP:
            if end is None:
                end = date(latest_year, 12, 31)
                start = date(latest_year, 1, 1)
                assumptions.append(f"target year assumed {latest_year} (latest in archive)")
            if b0 is None:
                b0, b1 = date(end.year - 4, 1, 1), date(end.year - 4, 12, 31)
                assumptions.append(f"baseline year assumed {b0.year} (4 years before)")
        elif target == Target.FLOODED_CROPLAND:
            if start is None:
                start, end = date(latest_year - 1, 7, 1), date(latest_year - 1, 7, 15)
                assumptions.append(f"no dates given → assumed peak monsoon 1–15 July {latest_year - 1}")
            elif (end - start).days < 11:
                end = start + timedelta(days=12)
                assumptions.append("window widened to 13 days so at least one Sentinel-1 pass falls inside")
        else:  # kilns
            if start is None:
                start, end = date(latest_year, 1, 1), date(latest_year, 3, 31)
                assumptions.append(f"no dates given → {latest_year} dry-season composite")
            else:
                start, end = date(end.year, 1, 1), date(end.year, 3, 31)
                assumptions.append(f"kilns mapped on the {end.year} dry-season (Jan–Mar) composite")

        # ---- precision / confidence / budget
        precision = None
        conf = 0.95
        m = re.search(r"(\d{2}(?:\.\d+)?)\s*%\s*(?:confidence|ci|conf)", t)
        if m:
            conf = float(m.group(1)) / 100
        m = re.search(r"(?:±|\+/-|\+-|within|to within|precision of|error of)\s*(\d+(?:\.\d+)?)\s*(?:%|percent|pp|percentage points?)", t)
        if m:
            precision = float(m.group(1))
        m = re.search(r"recall\s*(?:of|>=|≥|at least)?\s*(\d{2}(?:\.\d+)?)\s*%?", t)
        if task == Task.FIND_ALL:
            precision = float(m.group(1)) if m else 90.0
            if not m:
                assumptions.append("recall target defaulted to 90%")
        if precision is None:
            precision = {Task.AREA_FRACTION: 3.0, Task.TOTAL: 10.0, Task.COUNT: 15.0, Task.INSPECT: 5.0}.get(task, 3.0)
            unit = "pp" if task == Task.AREA_FRACTION else "%"
            if task != Task.INSPECT:
                assumptions.append(f"precision target defaulted to ±{precision:g} {unit} at {conf:.0%} confidence")
        budget = 120.0
        m = re.search(r"(\d+)\s*(s|sec|secs|seconds|min|mins|minutes)\b", t)
        if m:
            budget = float(m.group(1)) * (60 if m.group(2).startswith("m") else 1)

        fields = dict(
            task=task, target=target, region_id=region_id, start=start, end=end,
            baseline_start=b0, baseline_end=b1, precision=precision, confidence=conf,
            budget_seconds=budget, point=point, question=q,
        )
        if task == Task.FIND_ALL:
            # certifying recall for rare targets needs a large random audit (see FrontierAudit)
            fields["budget_tiles"] = 5000
            if budget == 120.0:
                fields["budget_seconds"] = 300.0
        for k, v in overrides.items():
            if v is not None and k in QueryIR.model_fields:
                fields[k] = v
        try:
            ir = QueryIR(**fields)
        except ValidationError as e:
            raise CompileError("; ".join(err["msg"] for err in e.errors())) from e
        return CompileResult(ir, self.name, assumptions)


LLM_SYSTEM = """You compile Earth-observation questions into a JSON query plan. Reply with ONE JSON object and nothing else.
Schema:
{"task": "area_fraction"|"total"|"count"|"find_all"|"inspect",
 "target": "flooded_cropland"|"new_builtup"|"brick_kiln",
 "start": "YYYY-MM-DD", "end": "YYYY-MM-DD",
 "baseline_start": "YYYY-MM-DD"|null, "baseline_end": "YYYY-MM-DD"|null,
 "precision": number, "confidence": number, "budget_seconds": number,
 "point": {"lon": number, "lat": number}|null,
 "assumptions": [string]}
Rules: area_fraction = share of cropland flooded (precision = ± percentage points, default 3).
total = total area in km² (precision = ± % relative, default 10). count = number of objects (default 15).
find_all = locate every tile with the target (precision = recall target in %, default 90).
inspect = answer about a specific point (requires point).
new_builtup needs a baseline window (before) and a target window (after); default baseline 4 years earlier.
Flood windows must be at least 12 days long. Kilns use a Jan–Mar dry-season window.
Record every default you chose in "assumptions". Archive covers 2017–2025."""


class LLMCompiler:
    """One-call LLM front end. Configure with environment variables:

    * ``AEQE_LLM=anthropic`` + ``ANTHROPIC_API_KEY`` (+ ``AEQE_LLM_MODEL``)
    * ``AEQE_LLM=openai`` + ``AEQE_LLM_BASE_URL`` (e.g. http://localhost:11434/v1 for
      Ollama) + optional ``AEQE_LLM_API_KEY`` + ``AEQE_LLM_MODEL``
    """

    def __init__(self):
        self.kind = os.getenv("AEQE_LLM", "").lower()
        self.model = os.getenv("AEQE_LLM_MODEL", "claude-sonnet-5-5" if self.kind == "anthropic" else "qwen2.5:7b-instruct")
        self.name = f"llm:{self.model}"

    @property
    def enabled(self) -> bool:
        if self.kind == "anthropic":
            return bool(os.getenv("ANTHROPIC_API_KEY"))
        return self.kind == "openai" and bool(os.getenv("AEQE_LLM_BASE_URL"))

    def _call(self, question: str) -> str:
        if self.kind == "anthropic":
            r = httpx.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json={"model": self.model, "max_tokens": 600, "system": LLM_SYSTEM,
                      "messages": [{"role": "user", "content": question}]},
                timeout=30,
            )
            r.raise_for_status()
            return "".join(b.get("text", "") for b in r.json()["content"])
        base = os.environ["AEQE_LLM_BASE_URL"].rstrip("/")
        headers = {"content-type": "application/json"}
        if os.getenv("AEQE_LLM_API_KEY"):
            headers["authorization"] = f"Bearer {os.environ['AEQE_LLM_API_KEY']}"
        r = httpx.post(
            f"{base}/chat/completions", headers=headers, timeout=60,
            json={"model": self.model, "temperature": 0,
                  "messages": [{"role": "system", "content": LLM_SYSTEM}, {"role": "user", "content": question}]},
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]

    def compile(self, question: str, *, region_id: str, overrides: Optional[dict] = None, **_) -> CompileResult:
        raw = self._call(question)
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            raise CompileError("LLM returned no JSON")
        data = json.loads(m.group(0))
        assumptions = [str(a) for a in data.pop("assumptions", []) or []]
        data = {k: v for k, v in data.items() if k in QueryIR.model_fields and v is not None}
        data.update({k: v for k, v in (overrides or {}).items() if v is not None and k in QueryIR.model_fields})
        data["region_id"] = region_id
        data["question"] = question
        try:
            ir = QueryIR(**data)
        except ValidationError as e:
            raise CompileError("; ".join(err["msg"] for err in e.errors())) from e
        return CompileResult(ir, self.name, assumptions)


def compile_question(question: str, *, region_id: str, overrides: Optional[dict] = None) -> CompileResult:
    llm = LLMCompiler()
    if llm.enabled:
        try:
            return llm.compile(question, region_id=region_id, overrides=overrides)
        except Exception as e:  # noqa: BLE001 — any LLM failure falls back to rules
            res = RuleCompiler().compile(question, region_id=region_id, overrides=overrides)
            res.warnings.append(f"LLM compiler failed ({type(e).__name__}: {e}); used rule-based compiler")
            return res
    return RuleCompiler().compile(question, region_id=region_id, overrides=overrides)
