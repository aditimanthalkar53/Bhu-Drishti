import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { normaliseGeometry } from "../src/features.js";
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
  app = await buildApp(loadConfig({ ENGINE_URL: `http://127.0.0.1:${port}`, JWT_SECRET: "test", MONITOR_SCHEDULER: "false",
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

test("webhook URLs are restricted unless private targets are allowed", async () => {
  const { isAllowedUrl } = await import("../src/webhooks.js");
  assert.equal(isAllowedUrl("https://hooks.example.org/x", false), true);
  assert.equal(isAllowedUrl("http://hooks.example.org/x", false), false);
  assert.equal(isAllowedUrl("https://192.168.1.4/x", false), false);
  assert.equal(isAllowedUrl("http://n8n:5678/webhook/x", true), true);
  assert.equal(isAllowedUrl("ftp://x", true), false);
});
