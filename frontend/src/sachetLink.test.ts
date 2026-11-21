// Run with the backend's runner (no new dependency):  cd backend && npx tsx --test ../frontend/src/sachetLink.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { alertsForRegion, exploreUrl, matchDistricts, suggestedQuestion } from "./sachetLink";

const R = (id: string, name: string, state: string, kind = "district") => ({ id, name, state, kind, bbox: [0, 0, 1, 1], simulated: false, description: "" }) as any;
const regions = [R("in-assam-barpeta", "Barpeta", "Assam"), R("in-delhi-south", "South", "Delhi"), R("in-tripura-south", "South Tripura", "Tripura"),
  R("in-mh-hingoli", "Hingoli", "Mahārāshtra"), R("in-mh-aurangabad", "Aurangabad", "Maharashtra"), R("in-br-aurangabad", "Aurangabad", "Bihar"), R("x-demo", "Barpeta", "Assam", "demo")];
const alert = (areaDesc: string | null, title = "Alert", extra: object = {}) => ({ title, event: title, areaDesc, ...extra });

test("an alert matches the districts it names, with accents folded and demo areas ignored", () => {
  assert.deepEqual(matchDistricts(alert("Barpeta district of Assam"), regions).map((r) => r.id), ["in-assam-barpeta"]);
  assert.deepEqual(matchDistricts(alert("Hingoli district of Maharashtra"), regions).map((r) => r.id), ["in-mh-hingoli"]);
  assert.deepEqual(matchDistricts(alert("nowhere in particular"), regions), []);
});

test("direction-only district names do not match inside other places", () => {
  const ids = matchDistricts(alert("Gomati, South Tripura districts of Tripura"), regions).map((r) => r.id);
  assert.deepEqual(ids, ["in-tripura-south"], "South Tripura matches, Delhi's 'South' does not");
});

test("a name shared by two states is narrowed by the state the alert names", () => {
  assert.deepEqual(matchDistricts(alert("Aurangabad district of Bihar"), regions).map((r) => r.id), ["in-br-aurangabad"]);
  assert.equal(matchDistricts(alert("Aurangabad"), regions).length, 2, "no state in the text: offer both");
});

test("only active alerts count for a district", () => {
  const barpeta = regions[0];
  const live = alert("Barpeta", "Flood warning", { expires: new Date(Date.now() + 3600_000).toISOString() });
  const expired = alert("Barpeta", "Old", { expires: new Date(Date.now() - 3600_000).toISOString() });
  const cancelled = alert("Barpeta", "Cancelled", { msgType: "Cancel" });
  assert.deepEqual(alertsForRegion(barpeta, [live, expired, cancelled, alert("Hingoli")]).map((a) => a.title), ["Flood warning"]);
  assert.deepEqual(alertsForRegion(regions[6], [live]), [], "a simulated demo area never shows official alerts");
});

test("the suggested question follows the hazard, or none", () => {
  assert.match(suggestedQuestion(alert("Barpeta", "Heavy rainfall warning"))!, /flooded/);
  assert.match(suggestedQuestion(alert("Barpeta", "Forest fire alert"))!, /fire detections/);
  assert.equal(suggestedQuestion(alert("Barpeta", "Earthquake advisory")), null);
  assert.equal(exploreUrl(regions[0], null), "/app?region=in-assam-barpeta");
  assert.equal(exploreUrl(regions[0], "How many?"), "/app?region=in-assam-barpeta&q=How%20many%3F");
});
