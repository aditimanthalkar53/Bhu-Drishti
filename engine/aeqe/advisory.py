"""Recovery and prevention guidance attached to results ("what can be done next").

Rule-based and deliberately conservative: it maps *what was measured* (target,
severity, season, state) to well-established Indian public programmes and
agronomic practices, and always tells the reader to confirm with the district
agriculture office or Krishi Vigyan Kendra (KVK). It never prescribes inputs or
doses, never promises eligibility, and never attributes a fire to anyone.

Scheme rules change; each item names the programme so officials can check the
current guidelines rather than relying on this text.
"""

from __future__ import annotations

from datetime import date
from typing import Optional

from .ir import QueryIR, Target, Task

DISCLAIMER = ("General guidance compiled from Government of India schemes and ICAR advisories. It is not a field "
              "assessment: confirm with the District Agriculture Officer or the local Krishi Vigyan Kendra (KVK), and "
              "check current scheme guidelines before acting.")

SUB1_STATES = {"Assam", "Bihar", "West Bengal", "Odisha", "Uttar Pradesh", "Jharkhand", "Tripura", "Manipur", "Meghalaya",
               "Andhra Pradesh", "Chhattisgarh"}
STUBBLE_STATES = {"Punjab", "Haryana", "Uttar Pradesh", "NCT of Delhi", "Delhi", "Rajasthan", "Madhya Pradesh"}


def season(d: date) -> str:
    m = d.month
    if 6 <= m <= 10:
        return "kharif"
    if m >= 11 or m <= 3:
        return "rabi"
    return "zaid"


def severity(share_pct: Optional[float]) -> str:
    if share_pct is None:
        return "unknown"
    if share_pct >= 20:
        return "severe"
    if share_pct >= 5:
        return "moderate"
    return "low"


def _item(title: str, detail: str, who: str, when: str, ref: str = "") -> dict:
    return {"title": title, "detail": detail, "who": who, "when": when, "reference": ref}


def advisory_for(ir: QueryIR, result: dict, region=None) -> Optional[dict]:
    est = result.get("estimate") or {}
    state = getattr(region, "state", "") or ""
    sea = season(ir.end)
    if ir.target == Target.FLOODED_CROPLAND:
        share = est.get("value") if ir.task == Task.AREA_FRACTION else None
        sev = severity(share)
        return _flood(ir, sev, sea, state, est)
    if ir.target in (Target.BURNED_CROPLAND, Target.ACTIVE_FIRE):
        return _fire(ir, sea, state, est)
    if ir.target == Target.NEW_BUILTUP:
        return {"topic": "construction", "headline": "Verify on the ground before acting",
                "items": [_item("Field verification", "Spectral change shows where land cover changed; whether a structure is "
                                "permitted can only be established from planning records and a site visit.",
                                "Town planning / revenue department", "before any notice")],
                "disclaimer": DISCLAIMER}
    return None


def _flood(ir: QueryIR, sev: str, sea: str, state: str, est: dict) -> dict:
    items = [
        _item("Report crop loss quickly", "Inundation is a 'localised calamity' under PMFBY: insured farmers should intimate "
              "the loss within 72 hours through the Crop Insurance app, the insurer, the bank or the toll-free helpline 14447.",
              "Farmers, with help from agriculture extension staff", "within 72 hours", "Pradhan Mantri Fasal Bima Yojana (PMFBY)"),
        _item("Joint damage assessment", "Use the flooded-cropland map to prioritise villages for the joint (revenue + "
              "agriculture) crop-loss survey. Input-subsidy assistance under SDRF/NDRF norms is linked to assessed crop loss "
              "of 33% or more.", "District administration, DDMA", "as soon as water recedes",
              "SDRF/NDRF norms (MHA), State relief manual"),
        _item("Drain and protect what survives", "Drain standing water where possible; most field crops are damaged after "
              "a few days of submergence. Watch for pest and disease outbreaks (e.g. bacterial leaf blight, brown planthopper "
              "in rice) after the water goes down.", "Farmers, KVK", "first 1–2 weeks"),
    ]
    if sea == "kharif":
        rice = ("Submergence-tolerant 'Sub1' rice varieties (for example Swarna-Sub1, Ranjit-Sub1, Bahadur-Sub1) survive "
                "1–2 weeks under water and suit flood-prone lowlands." if state in SUB1_STATES or not state else
                "Ask the KVK which short-duration or submergence-tolerant varieties are recommended locally.")
        items += [
            _item("Re-sow or re-transplant if the season allows", "Follow the District Agriculture Contingency Plan for "
                  "delayed/failed kharif: community or staggered nurseries, short-duration varieties, or a switch to a "
                  "contingency crop. " + rice, "Agriculture department, KVK, seed corporations", "while the sowing window is open",
                  "ICAR-CRIDA District Agriculture Contingency Plans"),
            _item("Plan the rabi crop on residual moisture", "Where kharif is lost, an early rabi crop on residual moisture "
                  "(for example toria/rapeseed-mustard, lentil, pea, early wheat or maize, as locally recommended) can recover "
                  "part of the year's income; arrange seed in advance.", "Agriculture department", "Oct–Nov"),
        ]
    else:
        items.append(_item("Contingency crop", "Ask the KVK for the contingency crop recommended for a late-season loss in this "
                           "district.", "KVK", "now", "ICAR-CRIDA District Agriculture Contingency Plans"))
    items += [
        _item("Check the soil", "Flood silt can change soil texture and nutrients. Test soil before the next crop (Soil Health "
              "Card scheme) instead of applying fertiliser blindly.", "Farmers, soil testing labs", "before the next sowing",
              "Soil Health Card scheme"),
        _item("Reduce next year's risk", "Map the tiles flooded repeatedly across years (run the same query for past seasons) "
              "to target drainage repair, embankments, raised nurseries and crop-calendar changes in those villages.",
              "Agriculture & water resources departments", "before the next monsoon"),
        _item("Monitor recovery", "Re-run this analysis after 3–4 weeks and set a Monitor on the district to see whether "
              "fields drained and replanting happened; MODIS/IMERG context helps judge whether more rain is coming.",
              "District officials (Bhu-Drishti Monitors)", "every Sentinel-1 pass"),
    ]
    head = {"severe": "Severe crop flooding — trigger loss reporting and the joint survey now",
            "moderate": "Moderate crop flooding — prioritise affected villages for survey and re-sowing support",
            "low": "Limited crop flooding — targeted follow-up in the affected tiles",
            "unknown": "Crop flooding detected — plan follow-up"}[sev]
    return {"topic": "flood", "severity": sev, "season": sea, "state": state, "headline": head, "items": items,
            "disclaimer": DISCLAIMER}


def _fire(ir: QueryIR, sea: str, state: str, est: dict) -> dict:
    items = [
        _item("Verify before acting", "A satellite detection is a hot pixel at overpass time. Field staff should verify the "
              "listed tiles; the data does not identify who lit a fire and must not be used on its own for penalties.",
              "Agriculture department field staff", "within 1–2 days"),
        _item("In-situ residue management", "Machines that manage residue in the field (Happy Seeder, Super Seeder, mulchers, "
              "zero-till drills) let farmers sow wheat without burning. The Crop Residue Management (CRM) scheme subsidises "
              "them for individual farmers and at higher rates for Custom Hiring Centres.", "Farmers, cooperatives, CHCs",
              "before the paddy harvest", "Crop Residue Management scheme (MoA&FW)"),
        _item("Bio-decomposer", "Microbial decomposer sprays (for example the IARI 'PUSA decomposer') speed up stubble "
              "decomposition; they need time and moisture, so plan them right after harvest.", "Farmers, KVK", "right after harvest",
              "ICAR-IARI"),
        _item("Ex-situ use", "Link fields in the hotspot tiles to balers and buyers (biomass power, compressed biogas, 2G "
              "ethanol, pellets) so residue has a value.", "District administration, industry", "harvest season"),
        _item("Soil health", "Burning removes organic matter and nutrients from the topsoil; soil testing and residue "
              "retention help restore it over seasons.", "Farmers, KVK", "next season", "Soil Health Card scheme"),
    ]
    if ir.target == Target.BURNED_CROPLAND:
        items.insert(1, _item("Next crop on burned fields", "Fields already burned can be sown normally, but advise farmers on "
                              "soil testing and residue retention next season.", "KVK", "now"))
    head = ("Fire activity on farmland — target residue-management support to the hotspot tiles"
            if state in STUBBLE_STATES else "Fire activity detected — verify and target support to the hotspot tiles")
    return {"topic": "fire", "season": sea, "state": state, "headline": head, "items": items, "disclaimer": DISCLAIMER}
