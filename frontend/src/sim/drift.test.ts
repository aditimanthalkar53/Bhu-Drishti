// Run with the backend's runner (no new dependency):  cd backend && npx tsx --test ../frontend/src/sim/drift.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { bedCriticalSpeed, DEFAULT_PARAMS, requiredPowerW, simulate, uuvLimitSpeed, type Params } from "./drift";

/** No parameter or flow uncertainty and no turbulence: the physics alone. The channel runs through the release point. */
const exact: Params = { ...DEFAULT_PARAMS, paramSpreadPct: 0, flowSpreadPct: 0, turbulence: 0, runs: 200, channel: { x: 0, y: 0, bearingDeg: 90 } };

test("the same seed gives the same result, another seed does not", () => {
  const p = { ...DEFAULT_PARAMS, kind: "floating" as const };
  const a = simulate(p, 7), b = simulate(p, 7), c = simulate(p, 8);
  assert.deepEqual(a.summary, b.summary);
  assert.deepEqual(Array.from(a.run.ends), Array.from(b.run.ends));
  assert.notDeepEqual(Array.from(a.run.ends), Array.from(c.run.ends));
});

test("chunked work gives the same answer as one call", async () => {
  const { createRun, runChunk, summarise } = await import("./drift");
  const whole = simulate(DEFAULT_PARAMS, 3).summary;
  const run = createRun(DEFAULT_PARAMS);
  for (let i = 0; i < run.n; i += 70) runChunk(run, 3, i, i + 70);
  assert.deepEqual(summarise(run), whole);
});

test("a bed object stays put below its friction threshold and moves, further with more flow, above it", () => {
  const p = { ...exact, kind: "bed" as const };
  const critical = bedCriticalSpeed(p.sizeM, p.massKg, p.mu, p.cd);       // near-bed speed; the channel flow needed is higher
  const below = simulate({ ...p, peakFlow: (0.9 * critical) / 0.7 }, 1).summary;
  assert.equal(below.movedCount, 0);
  assert.equal(below.medianM, 0);
  const some = simulate({ ...p, peakFlow: 2.2 }, 1).summary;
  const more = simulate({ ...p, peakFlow: 3.2 }, 1).summary;
  assert.ok(some.medianM > 0, "above the threshold it moves");
  assert.ok(more.medianM > some.medianM, "and goes further with more flow");
});

test("the power a vehicle needs rises with the cube of the flow speed", () => {
  const ratio = requiredPowerW(2.4, 1, 0.3) / requiredPowerW(1.2, 1, 0.3);
  assert.ok(Math.abs(ratio - 8) < 1e-9, `got ${ratio}`);
  const limit = uuvLimitSpeed(300, 1, 0.3);
  assert.ok(Math.abs(requiredPowerW(limit, 1, 0.3) - 300) < 1e-6, "at its limit speed it needs exactly its maximum power");
});

test("a vehicle holds station below its limit and is carried away above it", () => {
  const p = { ...exact, kind: "uuv" as const };
  const limit = uuvLimitSpeed(p.uuvMaxPowerW, p.cd, p.uuvDiameterM);
  assert.equal(simulate({ ...p, peakFlow: 0.95 * limit }, 1).summary.movedCount, 0);
  const carried = simulate({ ...p, peakFlow: 1.5 * limit }, 1).summary;
  assert.equal(carried.movedCount, carried.n);
  assert.ok(carried.medianM > 100);
});

test("more turbulence gives a larger 90% search area", () => {
  const p = { ...exact, kind: "floating" as const, runs: 400 };
  const calm = simulate({ ...p, turbulence: 0.2 }, 5).summary.zone90.areaHa;
  const rough = simulate({ ...p, turbulence: 4 }, 5).summary.zone90.areaHa;
  assert.ok(rough > calm, `${rough} should exceed ${calm}`);
});

test("search areas are not negative and the 50% zone lies inside the 90% zone", () => {
  for (const kind of ["bed", "floating", "uuv"] as const) {
    const s = simulate({ ...DEFAULT_PARAMS, kind }, 11).summary;
    assert.ok(s.zone50.areaHa >= 0 && s.zone90.areaHa >= 0 && s.reductionHa >= 0);
    assert.ok(s.zone50.areaHa <= s.zone90.areaHa + 1e-9);
    const poly = s.zone90.points;
    for (const [x, y] of s.zone50.points) {
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
        assert.ok((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1) >= -1e-6, `${kind}: a 50% corner is outside the 90% zone`);
      }
    }
  }
});

test("an object that never moves still gets a small, non-zero search area (the release position is uncertain)", () => {
  const s = simulate({ ...exact, kind: "bed", peakFlow: 0.2 }, 1).summary;
  assert.equal(s.movedCount, 0);
  assert.ok(s.zone90.areaHa > 0 && s.zone90.areaHa < 0.1);
});
