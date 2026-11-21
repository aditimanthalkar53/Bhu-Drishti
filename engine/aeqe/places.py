"""Which district does this text mean? Answered by location, not by spelling.

Official alerts (SACHET, the Central Water Commission) and people write "Balasore", "Keonjhar", "Gurgaon"; the district
list uses "Baleshwar", "Kendujhar", "Gurugram". Comparing names misses those. Instead each place named in the text is
looked up on a map (Open-Meteo's free geocoder, cached), and the district polygon that contains the point is the answer.

Safeguards, because place names repeat across India ("Gurgaon" is also a village in four states):
* the state named in the text (e.g. "... district of Odisha") must match the geocoder's state;
* "X district(s) of Y" phrases are trusted over incidental words such as bridge or village names;
* without a state, only the search box (mode "search") accepts results, and then only as suggestions.
Nothing here raises: if the geocoder is unreachable the result is simply the districts whose names match directly.
"""

from __future__ import annotations

import re
import threading
import unicodedata
from difflib import SequenceMatcher
from typing import Any, Callable, Optional

import httpx
from shapely.geometry import Point, shape

GEOCODER = "https://geocoding-api.open-meteo.com/v1/search"
CACHE_S = 30 * 86400
MAX_GEOCODES = 8


_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
         "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]


def _number_words(n: int) -> str:
    return _ONES[n] if n < 20 else _TENS[n // 10] + ("" if n % 10 == 0 else " " + _ONES[n % 10])


def fold(s: str) -> str:
    """Lower case, accents folded, punctuation to single spaces, 1-2 digit numbers spelled out
    ('South 24 Parganas' and 'South Twenty Four Parganas' compare equal)."""
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"\b(\d{1,2})\b", lambda m: " " + _number_words(int(m.group(1))) + " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


# ---------------------------------------------------------------------------- districts by location

class DistrictIndex:
    def __init__(self, regions):
        self.items = []
        for r in regions:
            if getattr(r, "kind", "") != "district" or not r.geometry:
                continue
            try:
                self.items.append((r, shape(r.geometry), r.bbox))
            except Exception:  # noqa: BLE001 - one bad polygon must not hide the rest
                continue

    def containing(self, lat: float, lon: float):
        p = Point(lon, lat)
        for r, geom, (w, s, e, n) in self.items:
            if w <= lon <= e and s <= lat <= n and geom.contains(p):
                return r
        return None


_index: Optional[tuple[tuple, DistrictIndex]] = None
_lock = threading.Lock()


def district_index(regions) -> DistrictIndex:
    """The polygons are parsed once (735 districts); the index is rebuilt only when the set of districts changes."""
    global _index
    ids = tuple(r.id for r in regions if getattr(r, "kind", "") == "district")
    with _lock:
        if _index is None or _index[0] != ids:
            _index = (ids, DistrictIndex(regions))
        return _index[1]


# ---------------------------------------------------------------------------- geocoder

def geocode(name: str, cache=None, get=httpx.get) -> list[dict]:
    """Places in India called ``name``, best first: [{name, admin1, admin2, lat, lon}]. Cached; [] on any failure."""
    name = name.strip()
    if len(name) < 3:
        return []
    key = None
    if cache is not None:
        key = cache.key("om-geocode", fold(name))
        hit = cache.get(key)
        if hit is not None:
            return hit
    try:
        r = get(GEOCODER, params={"name": name, "count": 10, "language": "en", "format": "json", "countryCode": "IN"}, timeout=15.0)
        r.raise_for_status()
        out = [{"name": x.get("name", ""), "admin1": x.get("admin1", ""), "admin2": x.get("admin2", ""),
                "lat": float(x["latitude"]), "lon": float(x["longitude"])} for x in (r.json().get("results") or [])]
    except Exception:  # noqa: BLE001 - unreachable or malformed: no suggestions, never an error
        return []
    if cache is not None and key:
        cache.put(key, out, CACHE_S)
    return out


# ---------------------------------------------------------------------------- reading the text

_SEP = {",", "&", ";"}


def district_phrases(text: str) -> list[str]:
    """Names written before the word 'district(s)': 'Aizawl, Kolasib districts of Mizoram' -> ['Aizawl', 'Kolasib']."""
    out: list[str] = []
    for m in re.finditer(r"\bdistricts?\b", text, re.I):
        start = len(out)
        toks = re.findall(r"[A-Za-z0-9][\w.'’\-]*|[,&;]", text[max(0, m.start() - 250): m.start()])
        cur: list[str] = []
        for t in reversed(toks):
            if t in _SEP or t.lower() == "and":
                if cur:
                    out.append(" ".join(reversed(cur)))
                    cur = []
                continue
            if t[0].isupper() or (t[0].isdigit() and cur):      # a number inside a name: "South 24 Parganas"
                cur.append(t)
            else:
                break
        if cur:
            out.append(" ".join(reversed(cur)))
        out[start:] = out[start:][::-1]               # the walk went backwards: restore reading order
    seen: set[str] = set()
    return [n for n in out if fold(n) and fold(n) not in seen and not seen.add(fold(n))]


def area_tokens(text: str) -> list[str]:
    seen: set[str] = set()
    out = []
    for t in re.split(r"[,;\n]", text):
        t = t.strip()
        f = fold(t)
        if len(f) >= 3 and f not in seen:
            seen.add(f)
            out.append(t)
    return out


def states_in(text: str, regions) -> set[str]:
    """States of the district list that the text names (accent-folded, whole words)."""
    hay = f" {fold(text)} "
    return {r.state for r in regions if getattr(r, "state", "") and f" {fold(r.state)} " in hay}


# Spelling variants of one district score 0.73-1.0 (Balasore/Balasore, Keonjhar/Kendujhar, Nowrangpur/Nabarangapur);
# a different district scores 0.6 or less.
LIKE = 0.7


def _district_like(a: str, b: str) -> bool:
    """Are these two names the same district spelled differently? ('Angul' and 'Anugul District')"""
    fa, fb = (re.sub(r"\b(district|zila)\b", "", fold(x)).strip() for x in (a, b))
    return bool(fa and fb and (fa == fb or SequenceMatcher(None, fa, fb).ratio() >= LIKE))


def _same_state(a: str, b: str) -> bool:
    fa, fb = fold(a), fold(b)
    return bool(fa and fb and (fa == fb or fa in fb or fb in fa))


# ---------------------------------------------------------------------------- the lookup

def resolve(text: str, regions, mode: str = "alert", cache=None, geocoder: Optional[Callable[..., list[dict]]] = None,
            max_results: int = 8) -> list[dict[str, Any]]:
    """Districts that ``text`` refers to: [{id, name, state, kind, via: 'name'|'location', place}].

    mode "alert": text of an official alert (area text, title). A state must be named for a place to be looked up.
    mode "search": a short phrase typed by a person; places are accepted without a state and returned as suggestions.
    """
    text = (text or "").strip()
    if not text:
        return []
    geocoder = geocoder or (lambda n: geocode(n, cache))
    districts = [r for r in regions if getattr(r, "kind", "") == "district"]
    by_name: dict[str, list] = {}
    for r in districts:
        by_name.setdefault(fold(r.name), []).append(r)
    states = states_in(text, regions)

    phrases = district_phrases(text)
    if mode == "search":
        # "Gurgaon Haryana" / "Balasore, Odisha": the state word narrows the lookup, it is not part of the place name
        rest = f" {fold(text)} "
        for s in sorted(states, key=len, reverse=True):
            rest = rest.replace(f" {fold(s)} ", " ")
        candidates = [rest.strip()] if rest.strip() else [text]
    else:
        candidates = phrases if phrases else area_tokens(text)
    out: dict[str, dict[str, Any]] = {}

    def add(r, via: str, place: str):
        out.setdefault(r.id, {"id": r.id, "name": r.name, "state": r.state, "kind": r.kind, "via": via, "place": place})

    geocodes = 0
    for cand in candidates:
        f = fold(cand)
        if not f or f in {fold(s) for s in states}:
            continue                                            # the state itself is not a place to look up
        direct = [r for r in by_name.get(f, []) if not states or any(_same_state(r.state, s) for s in states)]
        if direct:
            for r in direct:
                add(r, "name", cand)
            continue
        if geocodes >= MAX_GEOCODES or (mode == "alert" and not states):
            continue
        geocodes += 1
        found = geocoder(cand)
        if states:
            found = [g for g in found if any(_same_state(g["admin1"], s) for s in states)]
        if mode == "alert":
            # the alert calls this a district: the place must lie in a district of (nearly) the same name. A small village that
            # happens to share the name (Khurda, in Rayagada) is not the district, and no answer is better than a wrong one.
            found = [g for g in found if _district_like(g["admin2"], cand)][:1]
        else:
            found = found[:3]
        idx = district_index(regions)
        for g in found:
            r = idx.containing(g["lat"], g["lon"])
            if r is not None:
                add(r, "location", f"{g['name']} ({g['admin1']})")
        if len(out) >= max_results:
            break
    return list(out.values())[:max_results]
