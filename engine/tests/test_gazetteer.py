"""Naming points after the nearest real place (aeqe/gazetteer.py), with a small fake GeoNames table."""

from __future__ import annotations

import io
import zipfile
from types import SimpleNamespace

import pytest

from aeqe import gazetteer
from aeqe.gazetteer import Gazetteer, load, parse_geonames

ROWS = [("Barpeta", 26.3235, 91.0060), ("Ganak Kuchi Gaon", 26.3140, 91.0380), ("Budrutop", 26.3650, 90.9900)]


def geonames_line(gid, name, lat, lon, cls="P", code="PPL"):
    cols = [str(gid), name, name, "", f"{lat}", f"{lon}", cls, code] + [""] * 11
    return "\t".join(cols)


def test_a_point_in_a_village_takes_its_name():
    g = Gazetteer(ROWS)
    lab = g.label(26.3125, 91.0375)
    assert lab["label"] == "Ganak Kuchi Gaon" and lab["direction"] is None and lab["km"] < 1.5


def test_further_away_the_label_gives_distance_and_direction():
    g = Gazetteer(ROWS)
    lab = g.label(26.3375, 90.9625)                 # south-west of Budrutop, about 4 km
    assert lab["place"] == "Budrutop" and lab["direction"] == "south-west"
    assert lab["label"] == f"{lab['km']:.0f} km south-west of Budrutop"


def test_nothing_nearby_gives_no_name_rather_than_a_misleading_one():
    assert Gazetteer(ROWS).label(28.6, 77.2) is None          # Delhi: no place in the fake table within 25 km


def test_abandoned_and_non_populated_entries_are_left_out():
    lines = [geonames_line(1, "Live Village", 26.3, 91.0), geonames_line(2, "Ghost Village", 26.31, 91.01, code="PPLQ"),
             geonames_line(3, "Some River", 26.32, 91.02, cls="H", code="STM"), geonames_line(4, "Old Fort Town", 26.33, 91.03, code="PPLH")]
    assert [r[0] for r in parse_geonames(lines)] == ["Live Village"]


def test_first_use_downloads_once_then_reads_the_small_table(tmp_path, monkeypatch):
    monkeypatch.setattr(gazetteer, "_cache", {})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("IN.txt", "\n".join(geonames_line(i, n, a, b) for i, (n, a, b) in enumerate(ROWS)) + "\n")
    calls = []

    def get(url, **kw):
        calls.append(url)
        return SimpleNamespace(content=buf.getvalue(), raise_for_status=lambda: None)

    g = load(tmp_path, get=get)
    assert g.label(26.3125, 91.0375)["label"] == "Ganak Kuchi Gaon"
    assert (tmp_path / "geonames" / "IN_places.tsv").exists()
    monkeypatch.setattr(gazetteer, "_cache", {})          # a fresh process: reads the table, no second download
    load(tmp_path, get=lambda *a, **k: pytest.fail("downloaded twice"))
    assert calls == [gazetteer.SOURCE_URL]
