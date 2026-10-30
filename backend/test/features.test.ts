import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { normaliseGeometry } from "../src/features.js";
import { ackSignature, dueForEscalation, initialSteps, nextUp, setMailer, wouldLoop } from "../src/escalation.js";
import { compare, isDue, lastDailySlot } from "../src/monitors.js";
import { pdfText } from "../src/report.js";

const POLY = { type: "Polygon", coordinates: [[[91, 26], [91.1, 26], [91.1, 26.1], [91, 26.1], [91, 26]]] };

async function fakeEngine(): Promise<FastifyInstance> {
  const f = Fastify();
  const jobs = new Map<string, any>();
  const regions: Record<string, any> = {
    "in-assam-barpeta": { id: "in-assam-barpeta", name: "Barpeta", state: "Assam", kind: "district", simulated: false, area_km2: 2358, geometry: POLY },
  };
  f.get("/health", async () => ({ ok: true, provider: "fake" }));
  f.get("/regions", async () => Object.values(regions).map(({ geometry, ...r }) => r));
  f.get("/regions/:id", async (req: any, reply) => regions[req.params.id] ?? reply.code(404).send({ detail: "no region" }));
  f.post("/regions", async (req: any, reply) => {
    const id = `aoi-test${Object.keys(regions).length}`;
    regions[id] = { id, name: req.body.name, kind: "custom", simulated: false, area_km2: 120, geometry: req.body.geometry };
    return reply.code(201).send(regions[id]);
  });
  f.delete("/regions/:id", async (req: any) => { delete regions[req.params.id]; return { ok: true }; });
  f.get("/regions/:id/freshness", async () => ({ items: [{ product: "Sentinel-1 RTC", source: "planetary_computer", latest: "2026-10-16T12:00:00Z" }] }));
  f.get("/sources", async () => [{ id: "firms", status: "retrieval_verified" }]);
  f.post("/compile", async (req: any) => ({ compile: { ir: {} }, plan: { ok: !req.body.question.includes("penguin") } }));
  f.post("/queries", async (req: any, reply) => {
    const id = `job${jobs.size + 1}`;
    const value = req.body.question.includes("big") ? 25 : 2;
    jobs.set(id, { id, status: "done", result: { answer: `About ${value}% of cropland was flooded`, estimate: { value, lo: value - 1, hi: value + 1 },
      units: { short: "%" }, stop_reason: "precision_met", n: 100, population: 2000, oracle_calls: 100, data_mode: "live",
      caveats: ["test caveat"], supporting_evidence: [{ id: "rainfall", status: "ok", title: "Rainfall", summary: "120 mm" }],
      advisory: { headline: "Moderate crop flooding", items: [{ title: "Report crop loss", detail: "within 72 hours", who: "Farmers", when: "now" }], disclaimer: "General guidance" },
      region: { name: "Barpeta", state: "Assam" } } });
    return reply.code(201).send({ id, compile: {}, plan: { ok: true } });
  });
  f.get("/queries/:id", async (req: any, reply) => jobs.get(req.params.id) ?? reply.code(404).send({ detail: "no job" }));
  f.get("/queries/:id/evidence", async () => ({ type: "FeatureCollection", features: [{ type: "Feature", geometry: POLY, properties: { value: 1 } }] }));
  // digital twins
  f.get("/twins/osm", async () => [{ osmId: "way/1", name: "Test Bridge", assetType: "bridge", geometry: { type: "Point", coordinates: [91, 26] }, attributes: { material: "steel" } }]);
  f.post("/twins/observations", async (req: any, reply) => {
    if (req.body.geometry?.type === "Bad") return reply.code(422).send({ detail: "The asset needs a point, line or polygon." });
    return req.body.detection_ids.map((id: string) => ({ detection_id: id, kind: "sar_flood", touches_asset: true }));
  });
  f.post("/twins/terrain", async (req: any) => ({ width: 2, height: 2, heights: [1, 2, 3, 4], lines: [[[0.5, 0.5]]], detection: req.body.detection_id ?? null }));
  // change detection
  const detections = new Map<string, any>();
  let detectionCount = 0;
  f.get("/detections/analyses", async () => ({ analyses: [{ kind: "sar_flood", label: "Flood detection (radar)" }], max_span_deg: 1.5 }));
  f.post("/detections", async (req: any, reply) => {
    if (req.body.kind === "nope") return reply.code(422).send({ detail: "Unknown analysis type." });
    const id = `det-${detectionCount++}`;
    detections.set(id, { id, kind: req.body.kind, label: "Flood detection (radar)", region_id: req.body.region_id, name: "Barpeta", before: req.body.before ?? "2026-09-01",
      after: req.body.after ?? "2026-09-25", status: "running", error: null, summary: null, steps: [], record: null });
    return reply.code(201).send(detections.get(id));
  });
  f.get("/detections/:id", async (req: any, reply) => detections.get(req.params.id) ?? reply.code(404).send({ detail: "no detection" }));
  f.get("/detections/:id/overlays/:file", async (req: any, reply) => reply.header("content-type", "image/png").send(Buffer.from(`png:${req.params.file}`)));
  f.delete("/detections/:id", async (req: any) => { detections.delete(req.params.id); return { ok: true }; });
  f.post("/test/finish-detection/:id", async (req: any) => {
    detections.set(req.params.id, { ...detections.get(req.params.id), status: "done", summary: { detected: true, area_km2: 12.5, risk: "high", confidence: "probable", noun: "probable inundation" } });
    return { ok: true };
  });
  await f.listen({ port: 0, host: "127.0.0.1" });
  return f;
}

/** Captures signed webhook deliveries. */
async function receiver(): Promise<{ f: FastifyInstance; got: any[] }> {
  const f = Fastify();
  const got: any[] = [];
  f.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  f.post("/hook", async (req) => { got.push({ headers: req.headers, body: req.body as string }); return { ok: true }; });
  await f.listen({ port: 0, host: "127.0.0.1" });
  return { f, got };
}

let engine: FastifyInstance;
let hook: { f: FastifyInstance; got: any[] };
let app: Awaited<ReturnType<typeof buildApp>>;
let H: Record<string, string>;

before(async () => {
  engine = await fakeEngine();
  hook = await receiver();
  const port = (engine.server.address() as { port: number }).port;
  app = await buildApp(loadConfig({ ENGINE_URL: `http://127.0.0.1:${port}`, JWT_SECRET: "test", ALLOW_GUEST: "true", SQLITE_PATH: ":memory:", MONITOR_SCHEDULER: "false",
    ALLOW_PRIVATE_WEBHOOKS: "true", PUBLIC_API_URL: "http://backend:4000" } as any), { logger: false });
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "officer@example.org", password: "password123", name: "Officer" } });
  H = { authorization: `Bearer ${reg.json().token}` };
});

after(async () => {
  await app.close();
  await engine.close();
  await hook.f.close();
});

async function until<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

test("schedule maths", () => {
  // 08:00 IST = 02:30 UTC
  const at = new Date("2026-10-17T03:00:00Z");
  assert.equal(new Date(lastDailySlot("08:00", at)).toISOString(), "2026-10-17T02:30:00.000Z");
  assert.equal(new Date(lastDailySlot("09:00", at)).toISOString(), "2026-10-16T03:30:00.000Z");
  const m: any = { enabled: true, schedule: { type: "daily", time: "08:00" }, lastRunAt: "2026-10-16T02:31:00Z" };
  assert.equal(isDue(m, at), true);
  assert.equal(isDue({ ...m, lastRunAt: "2026-10-17T02:31:00Z" }, at), false);
  assert.equal(isDue({ enabled: true, schedule: { type: "interval", hours: 6 }, lastRunAt: "2026-10-16T20:00:00Z" } as any, at), true);
  assert.equal(compare(10, { metric: "value", op: ">", value: 5 }), true);
  assert.equal(compare(5, { metric: "value", op: ">", value: 5 }), false);
});

test("geometry normalisation and PDF text sanitising", () => {
  assert.equal(normaliseGeometry({ type: "Feature", geometry: POLY })?.type, "Polygon");
  assert.equal(normaliseGeometry({ type: "FeatureCollection", features: [{ geometry: POLY }, { geometry: POLY }] })?.type, "MultiPolygon");
  assert.equal(normaliseGeometry({ type: "Point", coordinates: [0, 0] }), null);
  assert.equal(pdfText("≈239 km² ≥ 5 → ok"), "~239 km² >= 5 -> ok");
});

test("areas of interest: district and custom polygon", async () => {
  const d = await app.inject({ method: "POST", url: "/api/aois", headers: H, payload: { regionId: "in-assam-barpeta" } });
  assert.equal(d.statusCode, 201);
  assert.equal(d.json().name, "Barpeta");
  assert.equal(d.json().kind, "district");
  const c = await app.inject({ method: "POST", url: "/api/aois", headers: H, payload: { name: "Embankment stretch", geometry: { type: "Feature", geometry: POLY } } });
  assert.equal(c.statusCode, 201);
  assert.equal(c.json().kind, "custom");
  assert.match(c.json().regionId, /^aoi-/);
  const bad = await app.inject({ method: "POST", url: "/api/aois", headers: H, payload: { geometry: { type: "Point", coordinates: [1, 2] } } });
  assert.equal(bad.statusCode, 400);
  const list = (await app.inject({ url: "/api/aois", headers: H })).json();
  assert.equal(list.length, 2);
  const del = await app.inject({ method: "DELETE", url: `/api/aois/${c.json().id}`, headers: H });
  assert.equal(del.statusCode, 200);
});

test("recipients, groups and report recipient resolution", async () => {
  const g = (await app.inject({ method: "POST", url: "/api/groups", headers: H, payload: { name: "DDMA Barpeta" } })).json();
  const bad = await app.inject({ method: "POST", url: "/api/recipients", headers: H, payload: { name: "X", email: "not-an-email" } });
  assert.equal(bad.statusCode, 400);
  const r1 = await app.inject({ method: "POST", url: "/api/recipients", headers: H, payload: { name: "DM Barpeta", designation: "District Magistrate",
    department: "Revenue", email: "dm@example.org", regionIds: ["in-assam-barpeta"], groupIds: [g.id] } });
  assert.equal(r1.statusCode, 201);
  await app.inject({ method: "POST", url: "/api/recipients", headers: H, payload: { name: "DAO", email: "dao@example.org", groupIds: [g.id], active: false } });
  const area = (await app.inject({ url: "/api/recipients?area=in-assam-barpeta", headers: H })).json();
  assert.equal(area.length, 1);
  assert.equal(area[0].email, "dm@example.org");
});

test("monitor run → threshold alert → report awaiting approval → signed webhooks → n8n delivery callback", async () => {
  const addr = hook.f.server.address() as { port: number };
  const wh = await app.inject({ method: "POST", url: "/api/webhooks", headers: H, payload: { url: `http://127.0.0.1:${addr.port}/hook`,
    events: ["alert.triggered", "report.ready", "report.approved"] } });
  assert.equal(wh.statusCode, 201);
  const secret = wh.json().secret as string;
  assert.match(secret, /^whsec_/);
  assert.equal((await app.inject({ url: "/api/webhooks", headers: H })).json()[0].secret, undefined, "secret is never listed");

  const aoi = (await app.inject({ method: "POST", url: "/api/aois", headers: H, payload: { regionId: "in-assam-barpeta", name: "Barpeta district" } })).json();
  const groups = (await app.inject({ url: "/api/groups", headers: H })).json();
  const badQ = await app.inject({ method: "POST", url: "/api/monitors", headers: H, payload: { name: "x", aoiId: aoi.id, question: "count penguins", schedule: { type: "manual" } } });
  assert.equal(badQ.statusCode, 422, "questions that cannot run are rejected at creation");
  const m = await app.inject({ method: "POST", url: "/api/monitors", headers: H, payload: {
    name: "Barpeta flood watch", aoiId: aoi.id, question: "big flood share of cropland in the last 14 days?",
    schedule: { type: "daily", time: "08:00" }, threshold: { metric: "lo", op: ">=", value: 10 }, groupIds: [groups[0].id], requireApproval: true } });
  assert.equal(m.statusCode, 201);
  assert.ok(m.json().nextRunAt);

  const run = await app.inject({ method: "POST", url: `/api/monitors/${m.json().id}/run`, headers: H });
  assert.equal(run.statusCode, 202);
  const alerts = await until(async () => { const a = (await app.inject({ url: "/api/alerts", headers: H })).json(); return a.length ? a : undefined; });
  assert.equal(alerts[0].status, "open");
  assert.equal(alerts[0].value, 25);
  const reports = await until(async () => { const r = (await app.inject({ url: "/api/reports", headers: H })).json(); return r.length ? r : undefined; });
  const rep = reports[0];
  assert.equal(rep.status, "pending_approval");
  assert.match(rep.summary, /ALERT/);

  // webhooks carry a valid HMAC signature over `${timestamp}.${body}`
  await until(async () => (hook.got.length >= 2 ? true : undefined));
  for (const g of hook.got) {
    const ts = g.headers["x-bhudrishti-timestamp"];
    const expect = "sha256=" + createHmac("sha256", secret).update(`${ts}.${g.body}`).digest("hex");
    assert.equal(g.headers["x-bhudrishti-signature"], expect);
  }
  const events = hook.got.map((g) => g.headers["x-bhudrishti-event"]);
  assert.ok(events.includes("alert.triggered") && events.includes("report.ready"));
  const ready = JSON.parse(hook.got.find((g) => g.headers["x-bhudrishti-event"] === "report.ready").body);
  assert.equal(ready.data.pdf_url, `http://backend:4000/api/reports/${rep.id}/pdf`);
  assert.equal(ready.data.recipients.length, 1, "inactive group members are not included");

  // sending before approval is refused
  const early = await app.inject({ method: "POST", url: `/api/reports/${rep.id}/send`, headers: H });
  assert.equal(early.statusCode, 409);

  const pdf = await app.inject({ url: `/api/reports/${rep.id}/pdf`, headers: H });
  assert.equal(pdf.statusCode, 200);
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.equal(pdf.rawPayload.subarray(0, 4).toString(), "%PDF");
  const pages = (pdf.rawPayload.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
  assert.ok(pages >= 1 && pages <= 2, `no blank footer pages (got ${pages})`);

  const ap = await app.inject({ method: "POST", url: `/api/reports/${rep.id}/approve`, headers: H, payload: { note: "checked against field report" } });
  assert.equal(ap.statusCode, 200);
  assert.equal(ap.json().status, "approved");
  // no SMTP configured in tests → clear error, report marked failed
  const send = await app.inject({ method: "POST", url: `/api/reports/${rep.id}/send`, headers: H });
  assert.equal(send.statusCode, 503);

  // n8n callback path
  const cb = await app.inject({ method: "POST", url: `/api/reports/${rep.id}/deliveries`, headers: H, payload: { to: "dm@example.org", status: "sent" } });
  assert.equal(cb.statusCode, 201);
  const detail = (await app.inject({ url: `/api/reports/${rep.id}`, headers: H })).json();
  assert.equal(detail.status, "sent");
  assert.ok(detail.deliveries.length >= 1);

  const audit = (await app.inject({ url: "/api/audit", headers: H })).json().map((a: any) => a.action);
  for (const a of ["monitor.create", "monitor.run", "report.approve", "report.send"]) assert.ok(audit.includes(a), `audit has ${a}`);

  const dash = (await app.inject({ url: "/api/dashboard", headers: H })).json();
  assert.equal(dash.counts.open_alerts, 1);
  assert.ok(dash.counts.unread_notifications >= 1);
  const usage = (await app.inject({ url: "/api/usage", headers: H })).json();
  assert.equal(usage.model_runs, 100);
  const hist = (await app.inject({ url: "/api/history?source=monitor", headers: H })).json();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].data_mode, "live");

  const ack = await app.inject({ method: "PATCH", url: `/api/alerts/${alerts[0].id}`, headers: H, payload: { status: "acknowledged", note: "team dispatched" } });
  assert.equal(ack.json().history.length, 2);
});

test("other users cannot see or change records", async () => {
  const g = await app.inject({ method: "POST", url: "/api/auth/guest" });
  const H2 = { authorization: `Bearer ${g.json().token}` };
  const reps = (await app.inject({ url: "/api/reports", headers: H })).json();
  assert.equal((await app.inject({ url: `/api/reports/${reps[0].id}`, headers: H2 })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: `/api/reports/${reps[0].id}/approve`, headers: H2 })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/recipients", headers: H2 })).json().length, 0);
});

test("change detection: start, status, overlays, delete, and other users are refused", async () => {
  const cat = await app.inject({ method: "GET", url: "/api/detections/analyses", headers: H });
  assert.equal(cat.json().analyses[0].kind, "sar_flood");

  const bad = await app.inject({ method: "POST", url: "/api/detections", headers: H, payload: { kind: "nope", regionId: "in-assam-barpeta" } });
  assert.equal(bad.statusCode, 422);
  const noDate = await app.inject({ method: "POST", url: "/api/detections", headers: H, payload: { kind: "sar_flood", regionId: "in-assam-barpeta", before: "soon" } });
  assert.equal(noDate.statusCode, 400);

  const started = await app.inject({ method: "POST", url: "/api/detections", headers: H, payload: { kind: "sar_flood", regionId: "in-assam-barpeta", before: "2024-03-15", after: "2024-07-05" } });
  assert.equal(started.statusCode, 201);
  const d = started.json();
  assert.equal(d.status, "running");
  assert.equal(d.before, "2024-03-15");

  // a second run is allowed, a third goes over the per-user limit
  const second = await app.inject({ method: "POST", url: "/api/detections", headers: H, payload: { kind: "sar_flood", regionId: "in-assam-barpeta" } });
  assert.equal(second.statusCode, 201);
  const third = await app.inject({ method: "POST", url: "/api/detections", headers: H, payload: { kind: "sar_flood", regionId: "in-assam-barpeta" } });
  assert.equal(third.statusCode, 429);

  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "other-detect@example.org", password: "password123", name: "Other" } });
  const other = { authorization: `Bearer ${reg.json().token}` };
  assert.equal((await app.inject({ method: "GET", url: `/api/detections/${d.id}`, headers: other })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/detections/${d.id}/overlays/change.png`, headers: other })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/detections/${d.id}`, headers: other })).statusCode, 404);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/detections", headers: other })).json(), []);
  assert.equal((await app.inject({ method: "GET", url: `/api/detections/${d.id}` })).statusCode, 401);

  // status follows the engine, in the detail view and the list
  const port = (engine.server.address() as { port: number }).port;
  await fetch(`http://127.0.0.1:${port}/test/finish-detection/${d.id}`, { method: "POST" });
  assert.equal((await app.inject({ method: "GET", url: `/api/detections/${d.id}`, headers: H })).json().status, "done");
  const row = (await app.inject({ method: "GET", url: "/api/detections", headers: H })).json().find((x: any) => x.id === d.id);
  assert.equal(row.status, "done");
  assert.equal(row.summary.area_km2, 12.5);

  // overlays work with the token in the URL, as an <img> or map layer requests them
  const token = H.authorization.slice("Bearer ".length);
  const png = await app.inject({ method: "GET", url: `/api/detections/${d.id}/overlays/change.png?token=${token}` });
  assert.equal(png.statusCode, 200);
  assert.equal(png.headers["content-type"], "image/png");
  assert.equal(png.body, "png:change.png");

  assert.equal((await app.inject({ method: "DELETE", url: `/api/detections/${d.id}`, headers: H })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/api/detections/${d.id}`, headers: H })).statusCode, 404);
});

test("ground movement waits have their own limit and do not block other analyses", async () => {
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "insar@example.org", password: "password123", name: "InSAR" } });
  const U = { authorization: `Bearer ${reg.json().token}` };
  const start = (kind: string) => app.inject({ method: "POST", url: "/api/detections", headers: U, payload: { kind, regionId: "in-assam-barpeta" } });
  for (let i = 0; i < 5; i++) assert.equal((await start("ground_deformation")).statusCode, 201);
  assert.equal((await start("ground_deformation")).statusCode, 429);
  assert.equal((await start("sar_flood")).statusCode, 201);    // five waiting on NASA do not stop a normal analysis
});

test("digital twins: create, records, observations, terrain, and other users are refused", async () => {
  const POINT = { type: "Point", coordinates: [91, 26] };
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "twin@example.org", password: "password123", name: "Engineer" } });
  const U = { authorization: `Bearer ${reg.json().token}` };
  const reg2 = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "twin-other@example.org", password: "password123", name: "Other" } });
  const O = { authorization: `Bearer ${reg2.json().token}` };

  assert.equal((await app.inject({ method: "GET", url: "/api/twins/osm?lat=26&lon=91", headers: U })).json()[0].name, "Test Bridge");
  assert.equal((await app.inject({ method: "POST", url: "/api/twins", headers: U, payload: { name: "X", assetType: "bridge", geometry: { type: "Bad" } } })).statusCode, 422);
  assert.equal((await app.inject({ method: "POST", url: "/api/twins", headers: U, payload: { name: "X", assetType: "spaceship", geometry: POINT } })).statusCode, 400);

  const made = await app.inject({ method: "POST", url: "/api/twins", headers: U, payload: { name: "Test Bridge", assetType: "bridge", geometry: POINT, osmId: "way/1", attributes: { material: "steel" } } });
  assert.equal(made.statusCode, 201);
  const t = made.json();
  assert.deepEqual(t.records, []);

  const rec = await app.inject({ method: "POST", url: `/api/twins/${t.id}/records`, headers: U, payload: { type: "sensor", date: "2026-01-05", title: "Crack gauge", value: 1.5, unit: "mm" } });
  assert.equal(rec.statusCode, 201);
  assert.equal(rec.json().author, "Engineer");
  assert.equal((await app.inject({ method: "POST", url: `/api/twins/${t.id}/records`, headers: U, payload: { type: "guess", date: "2026-01-05", title: "x" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/twins/${t.id}`, headers: U, payload: { attributes: { material: "concrete" } } })).json().attributes.material, "concrete");

  // only this user's finished analyses are read at the asset
  const started = (await app.inject({ method: "POST", url: "/api/detections", headers: U, payload: { kind: "sar_flood", regionId: "in-assam-barpeta" } })).json();
  const port = (engine.server.address() as { port: number }).port;
  assert.deepEqual((await app.inject({ method: "GET", url: `/api/twins/${t.id}`, headers: U })).json().observations, []);
  await fetch(`http://127.0.0.1:${port}/test/finish-detection/${started.id}`, { method: "POST" });
  await app.inject({ method: "GET", url: `/api/detections/${started.id}`, headers: U });
  const full = (await app.inject({ method: "GET", url: `/api/twins/${t.id}`, headers: U })).json();
  assert.deepEqual(full.observations.map((o: any) => o.detection_id), [started.id]);
  assert.equal(full.twin.records[0].title, "Crack gauge");

  const terr = await app.inject({ method: "POST", url: `/api/twins/${t.id}/terrain`, headers: U, payload: { detectionId: started.id } });
  assert.equal(terr.json().detection, started.id);

  // another user can neither see the twin nor point its terrain at someone else's analysis
  const mine = (await app.inject({ method: "POST", url: "/api/twins", headers: O, payload: { name: "Mine", assetType: "road", geometry: POINT } })).json();
  assert.equal((await app.inject({ method: "POST", url: `/api/twins/${mine.id}/terrain`, headers: O, payload: { detectionId: started.id } })).statusCode, 404);
  for (const [method, url] of [["GET", `/api/twins/${t.id}`], ["DELETE", `/api/twins/${t.id}`], ["POST", `/api/twins/${t.id}/terrain`]] as const) {
    assert.equal((await app.inject({ method, url, headers: O, payload: method === "POST" ? {} : undefined })).statusCode, 404);
  }
  assert.equal((await app.inject({ method: "GET", url: "/api/twins", headers: O })).json().length, 1);
  assert.equal((await app.inject({ method: "GET", url: "/api/twins" })).statusCode, 401);

  assert.equal((await app.inject({ method: "DELETE", url: `/api/twins/${t.id}/records/${rec.json().id}`, headers: U })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/twins/${t.id}`, headers: U })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/api/twins/${t.id}`, headers: U })).statusCode, 404);
});

test("escalation chain rules: loops, next level up, vacancies, severity and timing", () => {
  const r = (id: string, reportsToId: string | null, active = true): any => ({ id, reportsToId, active });
  const all = [r("block", "district"), r("district", "state"), r("state", "national"), r("national", null)];
  assert.equal(wouldLoop(all, "national", "block"), true);      // the top reporting to the bottom
  assert.equal(wouldLoop(all, "block", "block"), true);
  assert.equal(wouldLoop(all, "block", "state"), false);
  assert.deepEqual(nextUp(all, ["block"]).map((x) => x.id), ["district"]);
  assert.deepEqual(nextUp(all, ["block", "district"]).map((x) => x.id), ["state"]);   // already told people are not told again
  assert.deepEqual(nextUp(all, ["national"]), []);
  const vacancy = [r("block", "district"), r("district", "state", false), r("state", null)];
  assert.deepEqual(nextUp(vacancy, ["block"]).map((x) => x.id), ["state"]);           // an inactive official is passed over
  const esc = { enabled: true, ackMinutes: 30, severeValue: 50, criticalValue: 80 };
  assert.deepEqual([null, 10, 50, 79, 80, 200].map((v) => initialSteps(v, esc)), [0, 0, 1, 1, 2, 2]);
  const open: any = { status: "open", createdAt: "2026-10-30T10:00:00Z", escalation: esc };
  assert.equal(dueForEscalation(open, new Date("2026-10-30T10:29:00Z")), false);
  assert.equal(dueForEscalation(open, new Date("2026-10-30T10:30:00Z")), true);
  assert.equal(dueForEscalation({ ...open, status: "acknowledged" }, new Date("2026-10-31T10:30:00Z")), false);   // confirmed: stop
  assert.equal(dueForEscalation({ ...open, escalation: null }, new Date("2026-10-31T10:30:00Z")), false);
});

test("hierarchy and escalation end to end: levels, drills, manual and timed escalation, email confirmation", async () => {
  const sent: { to: string; subject: string; text: string }[] = [];
  let failFor: string | null = null;
  setMailer(async (to, subject, text) => { if (to === failFor) throw new Error("mailbox full"); sent.push({ to, subject, text }); });
  // This test moves the scheduler clock forward to trigger escalation. Monitors left by other tests (a daily 08:00 IST one)
  // would also become due, depending on the time of day, and start a background run after the test has closed the database.
  const realRun = app.scheduler.run;
  app.scheduler.run = async () => null;
  try {
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "chain@example.org", password: "password123", name: "Chain Admin" } });
    const U = { authorization: `Bearer ${reg.json().token}` };
    const reg2 = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "chain-other@example.org", password: "password123", name: "Other" } });
    const O = { authorization: `Bearer ${reg2.json().token}` };
    const add = async (name: string, level: number, reportsToId: string | null) => {
      const res = await app.inject({ method: "POST", url: "/api/recipients", headers: U, payload: { name, designation: `Officer ${level}`, email: `${name.toLowerCase().replace(/\W/g, "")}@gov.test`, level, reportsToId } });
      assert.equal(res.statusCode, 201, res.body);
      return res.json();
    };
    const state = await add("State Chief", 3, null);
    const district = await add("District Collector", 2, state.id);
    const block = await add("Block Officer", 1, district.id);
    assert.equal(block.reportsToId, district.id);
    assert.equal((await app.inject({ method: "POST", url: "/api/recipients", headers: U, payload: { name: "X", email: "x@gov.test", level: 9 } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/recipients", headers: U, payload: { name: "X", email: "x@gov.test", reportsToId: "nobody" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/recipients/${state.id}`, headers: U, payload: { reportsToId: block.id } })).statusCode, 400);   // a loop
    assert.equal((await app.inject({ method: "PATCH", url: `/api/recipients/${state.id}`, headers: O, payload: { reportsToId: null } })).statusCode, 404);

    const aoi = (await app.inject({ method: "POST", url: "/api/aois", headers: U, payload: { regionId: "in-assam-barpeta" } })).json();
    const monitor = (await app.inject({ method: "POST", url: "/api/monitors", headers: U, payload: {
      name: "Barpeta flood", aoiId: aoi.id, question: "What percentage of cropland was flooded in the last 14 days?", schedule: { type: "manual" },
      threshold: { metric: "value", op: ">=", value: 10 }, recipientIds: [block.id], escalation: { enabled: true, ackMinutes: 30, severeValue: 50, criticalValue: 80 } } })).json();
    assert.equal(monitor.escalation.ackMinutes, 30);
    const drill = async (value: number) => (await app.inject({ method: "POST", url: `/api/monitors/${monitor.id}/drill`, headers: U, payload: { value } })).json();
    const told = (a: any) => a.notified.map((n: any) => n.name);

    // severity decides how far up it goes straight away
    sent.length = 0;
    const small = await drill(20);
    assert.deepEqual(told(small), ["Block Officer"]);
    assert.equal(small.drill, true);
    assert.match(sent[0].subject, /^DRILL: /);
    assert.match(sent[0].text, /This is a drill/);
    assert.deepEqual(told(await drill(60)), ["Block Officer", "District Collector"]);
    assert.deepEqual(told(await drill(90)), ["Block Officer", "District Collector", "State Chief"]);

    // a person escalates one step at a time, and the top of the chain is reported, not looped
    const step1 = await app.inject({ method: "POST", url: `/api/alerts/${small.id}/escalate`, headers: U });
    assert.deepEqual(step1.json().toldNow.map((x: any) => x.name), ["District Collector"]);
    assert.deepEqual((await app.inject({ method: "POST", url: `/api/alerts/${small.id}/escalate`, headers: U })).json().toldNow.map((x: any) => x.name), ["State Chief"]);
    const top = await app.inject({ method: "POST", url: `/api/alerts/${small.id}/escalate`, headers: U });
    assert.deepEqual(top.json().toldNow, []);
    assert.equal(top.json().alert.history.at(-1).action, "top of chain");
    assert.equal((await app.inject({ method: "POST", url: `/api/alerts/${small.id}/escalate`, headers: O })).statusCode, 404);

    // silence escalates on its own, once per waiting period
    const quiet = await drill(20);
    await app.scheduler.tick(new Date(Date.now() + 5 * 60_000));
    assert.deepEqual(told((await app.inject({ method: "GET", url: "/api/alerts", headers: U })).json().find((a: any) => a.id === quiet.id)), ["Block Officer"]);
    await app.scheduler.tick(new Date(Date.now() + 31 * 60_000));
    const after = (await app.inject({ method: "GET", url: "/api/alerts", headers: U })).json().find((a: any) => a.id === quiet.id);
    assert.deepEqual(told(after), ["Block Officer", "District Collector"]);
    const toDistrict = sent.filter((m) => m.to === district.email && m.text.includes(`/api/alerts/${quiet.id}/ack`)).at(-1)!;
    assert.match(toDistrict.text, /within 30 minutes/);
    await app.scheduler.tick(new Date(Date.now() + 32 * 60_000));   // too soon after the last step
    assert.equal((await app.inject({ method: "GET", url: "/api/alerts", headers: U })).json().find((a: any) => a.id === quiet.id).notified.length, 2);

    // the emailed link confirms for one person, needs no login, cannot be forged, and stops further escalation
    const link = toDistrict.text.match(/https?:\/\/\S+\/api\/alerts\/[\w-]+\/ack\?r=[\w-]+&s=\w+/)![0];
    const path = link.slice(link.indexOf("/api/"));
    assert.equal((await app.inject({ method: "GET", url: path.replace(/s=\w+$/, "s=forged") })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: `/api/alerts/${quiet.id}/ack?r=${state.id}&s=${ackSignature("test", quiet.id, district.id)}` })).statusCode, 400);   // signature of someone else
    const ok = await app.inject({ method: "GET", url: path });
    assert.equal(ok.statusCode, 200);
    assert.match(ok.body, /District Collector/);
    assert.match(ok.body, /drill/);
    assert.equal((await app.inject({ method: "GET", url: path })).body.includes("Already confirmed"), true);
    const done = (await app.inject({ method: "GET", url: "/api/alerts", headers: U })).json().find((a: any) => a.id === quiet.id);
    assert.equal(done.status, "acknowledged");
    assert.deepEqual(done.confirmedBy.map((c: any) => c.name), ["District Collector"]);
    await app.scheduler.tick(new Date(Date.now() + 500 * 60_000));
    assert.equal((await app.inject({ method: "GET", url: "/api/alerts", headers: U })).json().find((a: any) => a.id === quiet.id).notified.length, 2);

    // a failed email is recorded on the alert and does not stop the rest
    failFor = state.email;
    const rough = await drill(90);
    assert.deepEqual(rough.notified.map((n: any) => `${n.name}:${n.status}`), ["Block Officer:sent", "District Collector:sent", "State Chief:failed"]);
    assert.match(rough.notified[2].error, /mailbox full/);
    failFor = null;

    // removing an official re-links the people who reported to them
    assert.equal((await app.inject({ method: "DELETE", url: `/api/recipients/${district.id}`, headers: U })).statusCode, 200);
    const relinked = (await app.inject({ method: "GET", url: "/api/recipients", headers: U })).json().find((r: any) => r.id === block.id);
    assert.equal(relinked.reportsToId, state.id);

    // drills need the rule switched on, and are audited
    const plain = (await app.inject({ method: "POST", url: "/api/monitors", headers: U, payload: { name: "Plain", aoiId: aoi.id, question: "What percentage of cropland was flooded in the last 14 days?", schedule: { type: "manual" } } })).json();
    assert.equal((await app.inject({ method: "POST", url: `/api/monitors/${plain.id}/drill`, headers: U, payload: {} })).statusCode, 400);
    const audit = (await app.inject({ method: "GET", url: "/api/audit", headers: U })).json();
    assert.ok(audit.some((e: any) => e.action === "alert.drill") && audit.some((e: any) => e.action === "alert.notify") && audit.some((e: any) => e.action === "alert.confirmed"));
  } finally {
    app.scheduler.run = realRun;
    setMailer(null);
  }
});

test("webhook URLs are restricted unless private targets are allowed", async () => {
  const { isAllowedUrl } = await import("../src/webhooks.js");
  assert.equal(isAllowedUrl("https://hooks.example.org/x", false), true);
  assert.equal(isAllowedUrl("http://hooks.example.org/x", false), false);
  assert.equal(isAllowedUrl("https://192.168.1.4/x", false), false);
  assert.equal(isAllowedUrl("http://n8n:5678/webhook/x", true), true);
  assert.equal(isAllowedUrl("ftp://x", true), false);
});
