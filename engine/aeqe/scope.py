"""Is a question something Bhu-Drishti can answer?

The compiler only knows a few measurable targets. Everything else gets a clear,
friendly reply instead of a cryptic parser error:

* ``help``      — greetings / "what can you do?": explain the scope with examples
* ``related``   — Earth-observation topics we do not measure (yet): say so, name
                  the closest thing we *can* answer
* ``off_topic`` — not about satellite observation of land at all

Rules, not an LLM: deterministic, offline, and testable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

SUPPORTED = ("flooded cropland (share or area)", "satellite fire detections / stubble-burning hotspots",
             "new construction (built-up area)", "burned cropland (experimental)")

EXAMPLES_LIVE = [
    "What percentage of cropland was flooded in the last 14 days?",
    "How many fire detections were there in the last 10 days?",
    "Which areas had fires this week? Prioritise them for review",
    "How much new built-up area appeared between 2020 and 2025?",
]

# Earth-observation topics people ask about that we do not measure yet → (label, closest supported question or None)
RELATED: list[tuple[str, str, Optional[str]]] = [
    (r"\b(air quality|aqi|pollut|smog|pm ?2\.?5|pm ?10|no2|so2|ozone|emission|smoke)\b", "air quality / pollution",
     "How many fire detections were there in the last 10 days?"),
    (r"\b(deforest|forest (loss|cover|fire)|tree (cover|loss)|logging|mangrove|green cover)\b", "forest / tree cover change", None),
    (r"\b(drought|dry spell|soil moisture|crop health|ndvi|vegetation (health|index)|crop (yield|production|condition|stress))\b",
     "crop health, drought or yield", "What percentage of cropland was flooded in the last 14 days?"),
    (r"\b(rain(fall)?|weather|temperature|heat ?wave|humidity|monsoon forecast|forecast|cyclone|storm|wind)\b",
     "weather, rainfall or forecasts",
     "What percentage of cropland was flooded in the last 14 days?"),
    (r"\b(river level|water level|reservoir|dam level|lake|groundwater|glacier|snow)\b", "water levels, lakes, glaciers or snow",
     "What percentage of cropland was flooded in the last 14 days?"),
    (r"\b(landslide|earthquake|tsunami|erosion|sand ?mining|illegal mining|mining|quarr)\b", "landslides, earthquakes or mining",
     "How much new built-up area appeared between 2020 and 2025?"),
    (r"\b(population|people live|census|household|density of people|migration)\b", "population", None),
    (r"\b(traffic|road condition|vehicle|ship|aircraft)\b", "traffic or vehicles", None),
    (r"\b(crop type|which crop|paddy area|wheat area|sown area|land ?use|land ?cover|soil type)\b", "crop types or land use / land cover",
     "What percentage of cropland was flooded in the last 14 days?"),
]

HELP = r"^\s*(hi|hello|hey|namaste|namaskar|good (morning|afternoon|evening)|help|what can you do|who are you|what is this|how (does|do) (this|it) work)\b"
EO_HINT = r"\b(satellite|sentinel|imagery|image|district|village|area|land|crop|farm|field|map|region|km|hectare|acre)\b"


@dataclass
class ScopeReply:
    category: str                    # help | related | off_topic
    message: str
    topic: Optional[str] = None
    suggestions: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {"kind": "out_of_scope", "category": self.category, "topic": self.topic, "message": self.message,
                "suggestions": self.suggestions, "supported": list(SUPPORTED)}


def classify(question: str) -> Optional[ScopeReply]:
    """``None`` when the question looks answerable (the compiler then decides the details)."""
    t = question.lower().strip()
    if not t or len(t) < 3:
        return ScopeReply("help", "Ask a question about floods, fires or construction in the selected area.", suggestions=EXAMPLES_LIVE)
    if re.search(HELP, t) and len(t.split()) <= 8:
        return ScopeReply("help",
                          "I answer questions about what satellites can see on the ground in India: "
                          + ", ".join(SUPPORTED) + ". Pick a district and ask, for example:",
                          suggestions=EXAMPLES_LIVE)
    for pat, label, closest in RELATED:
        if re.search(pat, t):
            msg = (f"Bhu-Drishti cannot measure {label} yet. It currently answers questions about "
                   + ", ".join(SUPPORTED) + ".")
            if label.startswith("weather"):
                msg += " (Flood answers already include rainfall and a 7-day rain/river forecast as supporting context.)"
            return ScopeReply("related", msg, topic=label, suggestions=[closest] if closest else EXAMPLES_LIVE[:2])
    if not re.search(EO_HINT, t):
        return ScopeReply("off_topic",
                          "That question is outside what this app does. Bhu-Drishti only answers questions about satellite "
                          "observations of land in India — " + ", ".join(SUPPORTED) + ".",
                          suggestions=EXAMPLES_LIVE)
    return ScopeReply("related",
                      "I couldn't tell what to measure. Bhu-Drishti answers questions about " + ", ".join(SUPPORTED)
                      + ". Try mentioning one of these, for example:", suggestions=EXAMPLES_LIVE)
