"""Resolving place names to districts by location (aeqe/places.py), with a fake geocoder."""

from __future__ import annotations

from types import SimpleNamespace

from aeqe import places
from aeqe.places import area_tokens, district_phrases, fold, resolve


def sq(w, s, e, n):
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


def region(id, name, state, w, s, e, n, kind="district"):
    return SimpleNamespace(id=id, name=name, state=state, kind=kind, geometry=sq(w, s, e, n), bbox=(w, s, e, n))


REGIONS = [
    region("od-baleshwar", "Baleshwar", "Odisha", 86.5, 21.2, 87.4, 21.9),
    region("od-kendujhar", "Kendujhar", "Odisha", 85.0, 21.0, 86.0, 22.2),
    region("mh-hingoli", "Hingoli", "Mahārāshtra", 77.0, 19.2, 77.6, 19.9),
    region("dl-south", "South", "Delhi", 77.1, 28.4, 77.3, 28.6),
    region("hr-gurugram", "Gurugram", "Haryana", 76.8, 28.3, 77.2, 28.6),
    region("demo-a", "Barpeta", "Assam", 90.0, 26.0, 91.0, 27.0, kind="demo"),
]

# what the free geocoder would answer (admin1 = state)
GEO = {
    "balasore": [{"name": "Balasore", "admin1": "Odisha", "admin2": "Balasore District", "lat": 21.493, "lon": 86.933}],
    "keonjhar": [{"name": "Keonjhargarh", "admin1": "Odisha", "admin2": "Kendujhar", "lat": 21.632, "lon": 85.597}],
    "jalaka": [{"name": "Jalaka", "admin1": "Rajasthan", "admin2": "Alwar", "lat": 27.97, "lon": 76.70},
               {"name": "Jalakandapuram", "admin1": "Tamil Nadu", "admin2": "Salem", "lat": 11.7, "lon": 77.87}],
    "gurgaon": [{"name": "Gurgaon", "admin1": "Maharashtra", "admin2": "Hingoli District", "lat": 19.34, "lon": 77.27},
                {"name": "Gurgaon", "admin1": "Haryana", "admin2": "Gurugram", "lat": 28.46, "lon": 77.03}],
}


def fake(name):
    return GEO.get(fold(name), [])


ALERT = ("River Jalaka at Mathani Road Bridge in Balasore district of Odisha continues to flow in above normal flood situation. "
         "Jalaka, Mathani Road Bridge, Balasore, Odisha")


def test_the_cwc_alert_from_the_screenshot_finds_baleshwar():
    out = resolve(ALERT, REGIONS, "alert", geocoder=fake)
    assert [d["id"] for d in out] == ["od-baleshwar"]
    assert out[0]["via"] == "location" and out[0]["place"] == "Balasore (Odisha)"


def test_incidental_names_in_the_alert_are_not_looked_up():
    """'Jalaka' (a river) exists in Rajasthan and Tamil Nadu; the district phrase wins and the state filter would drop them anyway."""
    looked_up = []
    resolve(ALERT, REGIONS, "alert", geocoder=lambda n: looked_up.append(n) or fake(n))
    assert looked_up == ["Balasore"]


def test_without_a_district_phrase_area_names_are_used_with_the_state_filter():
    out = resolve("Jalaka, Mathani Road Bridge, Balasore, Odisha", REGIONS, "alert", geocoder=fake)
    assert [d["id"] for d in out] == ["od-baleshwar"], "Rajasthan's and Tamil Nadu's Jalaka are rejected because the alert names Odisha"


def test_alternate_spellings_and_direct_names_both_work():
    out = resolve("Heavy rain in Keonjhar and Hingoli districts of Odisha and Maharashtra", REGIONS, "alert", geocoder=fake)
    assert {d["id"] for d in out} == {"od-kendujhar", "mh-hingoli"}
    assert {d["id"]: d["via"] for d in out} == {"od-kendujhar": "location", "mh-hingoli": "name"}


def test_a_same_named_village_in_another_district_is_not_taken_for_the_district():
    village = lambda n: [{"name": "Khurda", "admin1": "Odisha", "admin2": "Rayagada", "lat": 19.2, "lon": 83.4}]   # a small village
    assert resolve("Heavy rain in Khurda district of Odisha", REGIONS, "alert", geocoder=village) == [], "no answer is better than the wrong district"
    khordha = REGIONS + [region("od-khordha", "Khordha", "Odisha", 85.2, 20.0, 86.0, 20.5)]
    town = lambda n: [{"name": "Khurda", "admin1": "Odisha", "admin2": "Khordha District", "lat": 20.2, "lon": 85.6}]
    assert [d["id"] for d in resolve("Heavy rain in Khurda district of Odisha", khordha, "alert", geocoder=town)] == ["od-khordha"]


def test_an_alert_that_names_no_state_is_not_guessed():
    assert resolve("Heavy rain at Balasore", REGIONS, "alert", geocoder=fake) == []


def test_the_search_box_accepts_a_place_without_a_state_and_suggests_districts():
    assert [d["id"] for d in resolve("Balasore", REGIONS, "search", geocoder=fake)] == ["od-baleshwar"]
    # the state in the phrase narrows it: Gurgaon in Haryana is the city, not the Maharashtra village
    assert [d["id"] for d in resolve("Gurgaon Haryana", REGIONS, "search", geocoder=fake)] == ["hr-gurugram"]


def test_direction_only_district_names_and_demo_areas_are_not_matched_by_accident():
    assert resolve("Light rain in South Tripura district of Tripura", REGIONS, "alert", geocoder=fake) == []
    assert all(d["kind"] == "district" for d in resolve("Barpeta, Assam", REGIONS, "search", geocoder=fake))


def test_a_failing_geocoder_gives_no_error_and_direct_matches_still_work():
    def down(name):
        raise AssertionError("must not be needed")
    assert [d["id"] for d in resolve("Hingoli district of Maharashtra", REGIONS, "alert", geocoder=down)] == ["mh-hingoli"]
    assert places.geocode("Balasore", get=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("offline"))) == []


def test_numbers_in_district_names_match_their_spelled_out_form():
    parganas = REGIONS + [region("wb-s24", "South Twenty Four Parganas", "West Bengal", 88.0, 21.5, 89.0, 22.5)]
    assert fold("South 24 Parganas") == fold("South Twenty Four Parganas") == "south twenty four parganas"
    text = "Light rain very likely over some parts of South 24 Parganas district during next 2-3 hours"
    assert district_phrases(text) == ["South 24 Parganas"]
    assert [d["id"] for d in resolve(text, parganas, "alert", geocoder=fake)] == ["wb-s24"], "found by name, no state needed"


def test_district_phrases_and_area_tokens():
    assert district_phrases("Aizawl, Kolasib, Lunglei districts of Mizoram") == ["Aizawl", "Kolasib", "Lunglei"]
    assert district_phrases("Gomati,Sepahijala,South Tripura districts of Tripura") == ["Gomati", "Sepahijala", "South Tripura"]
    assert district_phrases("rain is very likely over the north of the district") == []
    assert area_tokens("Jalaka, Mathani Road Bridge, Balasore, Odisha") == ["Jalaka", "Mathani Road Bridge", "Balasore", "Odisha"]
