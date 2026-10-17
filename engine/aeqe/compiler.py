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
FIRE_WORDS = r"\bfires?\b|burn|stubble|parali|residue|hotspot|hot spot|thermal anomal|blaze|wildfire"
BURNED_AREA_WORDS = (r"burn(?:ed|t)\s+(?:crop)?(?:land|area|fields?)|(?:cropland|fields?|farmland|area)\s+(?:was|were|got|is|are|has been|have been)\s+burn"
                     r"|area\s+(?:was\s+)?burn|scar|how much .*burn|hectares? .*burn|km.? .*burn|(?:share|percent\w*|%|fraction|proportion)\b.*burn")


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


_MON = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"


def _mon(s: str) -> int:
    return MONTHS["sept" if s[:4] == "sept" else s[:3]]


def parse_relative(t: str, today: date) -> Optional[tuple[date, date, str]]:
    """'last 10 days', 'past 2 weeks', 'this week/month', 'last month', 'yesterday', 'today', 'since 1 Oct'."""
    m = re.search(r"\b(?:last|past|previous|recent)\s+(\d{1,3})\s*(day|days|week|weeks|month|months)\b", t)
    if m:
        n = int(m.group(1))
        days = n * (7 if m.group(2).startswith("week") else 30 if m.group(2).startswith("month") else 1)
        return today - timedelta(days=days - 1), today, f"'{m.group(0)}' → {days} days ending today ({today})"
    if re.search(r"\b(?:last|past) (?:week)\b|\bthis week\b", t):
        return today - timedelta(days=6), today, f"'week' → 7 days ending today ({today})"
    if re.search(r"\bthis month\b", t):
        return today.replace(day=1), today, f"'this month' → {today.replace(day=1)} … {today}"
    if re.search(r"\blast month\b", t):
        first = today.replace(day=1)
        prev_end = first - timedelta(days=1)
        return prev_end.replace(day=1), prev_end, "'last month' → previous calendar month"
    if re.search(r"\byesterday\b", t):
        y = today - timedelta(days=1)
        return y, y, f"'yesterday' → {y}"
    if re.search(r"\btoday\b|\bright now\b|\bcurrently\b|\blatest\b", t):
        return today - timedelta(days=1), today, f"'today/latest' → {today - timedelta(days=1)} … {today}"
    m = re.search(r"\bsince\s+(\d{1,2})\s+" + _MON + r"(?:\s+(\d{4}))?", t)
    if m:
        y = int(m.group(3)) if m.group(3) else today.year
        d = date(y, _mon(m.group(2)), int(m.group(1)))
        if d > today:
            d = d.replace(year=d.year - 1)
        return d, today, f"'since {m.group(1)} {m.group(2)}' → {d} … {today}"
    return None


def parse_dates(text: str, today: Optional[date] = None) -> tuple[Optional[date], Optional[date], Optional[date], Optional[date], list[str]]:
    """Return (start, end, baseline_start, baseline_end, notes)."""
    t = text.lower()
    notes: list[str] = []
    today = today or date.today()
    rel = parse_relative(t, today)
    if rel:
        return rel[0], rel[1], None, None, [rel[2]]
    # "1 Oct 2024 to 15 Nov 2024" / "1 October - 15 November 2024"
    m = re.search(r"(\d{1,2})\s+" + _MON + r"(?:\s+(\d{4}))?\s*(?:-|–|to|until|till|and)\s*(\d{1,2})\s+" + _MON + r"\s+(\d{4})", t)
    if m:
        y1 = int(m.group(6))
        y0 = int(m.group(3)) if m.group(3) else y1
        a, b = date(y0, _mon(m.group(2)), int(m.group(1))), date(y1, _mon(m.group(5)), int(m.group(4)))
        return min(a, b), max(a, b), None, None, notes
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
                latest_year: Optional[int] = None, live: bool = False, today: Optional[date] = None) -> CompileResult:
        """``live``: the region is served by real satellite data, so "no date" means "recently"
        (simulated regions keep their fixed demo archive and defaults)."""
        q = question.strip()
        t = q.lower()
        assumptions: list[str] = []
        overrides = dict(overrides or {})
        today = today or date.today()
        if latest_year is None:
            # a dry-season (Jan–Mar) Sentinel-2 composite for this year exists from April on
            latest_year = (today.year if today.month >= 4 else today.year - 1) if live else 2025

        # ---- target
        if re.search(KILN_WORDS, t):
            target = Target.BRICK_KILN
        elif re.search(FIRE_WORDS, t):
            target = Target.BURNED_CROPLAND if re.search(BURNED_AREA_WORDS, t) else Target.ACTIVE_FIRE
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
        elif target == Target.BURNED_CROPLAND:
            task = Task.AREA_FRACTION if re.search(r"%|percent|percentage|share|fraction|proportion", t) else Task.TOTAL
        elif re.search(r"\b(find|locate|where are|where is|where were|map (all|every)|show (me )?(all|every)|list (all|every)|every)\b", t) or (
                target == Target.ACTIVE_FIRE and re.search(r"\b(identify|prioriti[sz]e|which (areas|places|villages|tiles)|areas with|hotspots? areas?)\b", t)):
            task = Task.FIND_ALL
        elif target in (Target.BRICK_KILN, Target.ACTIVE_FIRE):
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
        start, end, b0, b1, notes = parse_dates(t, today)
        assumptions += notes
        if start is not None and end is not None and end > today and live:
            end = today
            assumptions.append(f"window clipped to today ({today}); future dates have no observations")
        if target in (Target.ACTIVE_FIRE, Target.BURNED_CROPLAND):
            if start is None:
                days = 10 if target == Target.ACTIVE_FIRE else 30
                start, end = today - timedelta(days=days - 1), today
                assumptions.append(f"no dates given → last {days} days ({start} … {end})")
        elif target == Target.NEW_BUILTUP:
            if end is None:
                end = date(latest_year, 12, 31)
                start = date(latest_year, 1, 1)
                assumptions.append(f"target year assumed {latest_year} (latest in archive)")
            if b0 is None:
                b0, b1 = date(end.year - 4, 1, 1), date(end.year - 4, 12, 31)
                assumptions.append(f"baseline year assumed {b0.year} (4 years before)")
        elif target == Target.FLOODED_CROPLAND:
            if start is None and live:
                start, end = today - timedelta(days=13), today
                assumptions.append(f"no dates given → most recent 14 days ({start} … {end})")
            elif start is None:
                start, end = date(latest_year - 1, 7, 1), date(latest_year - 1, 7, 15)
                assumptions.append(f"no dates given → assumed peak monsoon 1–15 July {latest_year - 1}")
            elif (end - start).days < 11:
                if live and start + timedelta(days=12) > today:
                    start = end - timedelta(days=12)
                    assumptions.append("window extended backwards to 13 days so at least one Sentinel-1 pass falls inside")
                else:
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
        census = target == Target.ACTIVE_FIRE
        if precision is None:
            precision = {Task.AREA_FRACTION: 3.0, Task.TOTAL: 10.0, Task.COUNT: 15.0, Task.INSPECT: 5.0}.get(task, 3.0)
            unit = "pp" if task == Task.AREA_FRACTION else "%"
            if task != Task.INSPECT and not census:
                assumptions.append(f"precision target defaulted to ±{precision:g} {unit} at {conf:.0%} confidence")
        if census:
            assumptions.append("fire detections are a complete catalogue → every tile is counted exactly (no sampling)")
        # real imagery is read over the network: allow more time than the simulator needs
        budget = 900.0 if live else 120.0
        m = re.search(r"(\d+)\s*(s|sec|secs|seconds|min|mins|minutes)\b(?!\s*(?:ago|old))", t)
        if m and not re.search(r"\b(?:last|past|previous)\s+\d+\s*(?:min|minutes)\b", t):
            budget = float(m.group(1)) * (60 if m.group(2).startswith("m") else 1)

        fields = dict(
            task=task, target=target, region_id=region_id, start=start, end=end,
            baseline_start=b0, baseline_end=b1, precision=precision, confidence=conf,
            budget_seconds=budget, point=point, question=q,
        )
        if task == Task.FIND_ALL and not census:
            # certifying recall for rare targets needs a large random audit (see FrontierAudit)
            fields["budget_tiles"] = 5000
            if budget == 120.0:
                fields["budget_seconds"] = 300.0
        if census:
            fields["budget_tiles"] = 200000
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
 "target": "flooded_cropland"|"new_builtup"|"brick_kiln"|"active_fire"|"burned_cropland",
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
active_fire = satellite fire detections (NASA FIRMS): task count (how many detections) or find_all (which areas, prioritise).
burned_cropland = burn-scar area on cropland (stubble burning): task total (km²) or area_fraction (% of cropland).
A fire detection is a thermal anomaly, not proof of the cause; never attribute it to a person.
Record every default you chose in "assumptions"."""


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

    def _call(self, question: str, context: str = "") -> str:
        system = LLM_SYSTEM + ("\n" + context if context else "")
        if self.kind == "anthropic":
            r = httpx.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json={"model": self.model, "max_tokens": 600, "system": system,
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
                  "messages": [{"role": "system", "content": system}, {"role": "user", "content": question}]},
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]

    def compile(self, question: str, *, region_id: str, overrides: Optional[dict] = None, live: bool = False,
                today: Optional[date] = None, **_) -> CompileResult:
        today = today or date.today()
        ctx = (f"Today is {today.isoformat()}. The region uses live satellite data: with no dates, use the most recent "
               f"14 days (floods), 10 days (fires) or 30 days (burned area); never use future dates."
               if live else "The region is a simulated demo district; archive covers 2017–2025.")
        raw = self._call(question, ctx)
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


def compile_question(question: str, *, region_id: str, overrides: Optional[dict] = None, live: bool = False,
                     today: Optional[date] = None) -> CompileResult:
    llm = LLMCompiler()
    if llm.enabled:
        try:
            return llm.compile(question, region_id=region_id, overrides=overrides, live=live, today=today)
        except Exception as e:  # noqa: BLE001 — any LLM failure falls back to rules
            res = RuleCompiler().compile(question, region_id=region_id, overrides=overrides, live=live, today=today)
            res.warnings.append(f"LLM compiler failed ({type(e).__name__}); used rule-based compiler")
            return res
    return RuleCompiler().compile(question, region_id=region_id, overrides=overrides, live=live, today=today)
