import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, parseWardEmails } from "../src/config.js";
import { confidenceOf, type HelpRequest } from "../src/disaster.js";
import { isHidden } from "../src/featureFlags.js";
import { cleanImage, sniffImage, stripJpeg, stripPng } from "../src/images.js";
import { runIntake, validateIntake } from "../src/intake.js";
import { extractJson, llmConfig } from "../src/llm.js";
import { countReports, makeGrid } from "../src/maun.js";
import type { Store } from "../src/store/types.js";
import { analysePhoto, validateVision } from "../src/vision.js";

// ---------------------------------------------------------------- a fake engine for hazard + Maun
let computeCalls: any[] = [];
async function fakeEngine(): Promise<FastifyInstance> {
  const f = Fastify();
  f.get("/health", async () => ({ ok: true }));
  f.post("/hazard/grid", async (req: any) => ({
    bbox: req.body.bbox, cell_deg: req.body.cell_deg, generated_at: "2026-11-21T00:00:00Z", score_doc: "max of weighted layers",
    cells: makeGrid(req.body.bbox, req.body.cell_deg).map((c, i) => ({ cell_id: c.id, bbox: c.bbox, hazard_score: i % 2 ? 0.8 : 0.1, layers: {} })),
    sources: [{ id: "firms", name: "FIRMS", state: "ok", observed_at: "2026-11-20T10:00:00Z", age_s: 3600, latency_s: 10800, note: "" },
      { id: "imerg", name: "IMERG", state: "not_configured", observed_at: null, age_s: null, latency_s: null, note: "EARTHDATA_TOKEN missing" }],
  }));
  f.post("/maun/compute", async (req: any) => {
    const s = req.body;
    computeCalls.push(s);
    const taken = new Set(s.waves.flatMap((_w: any, i: number) => s.cells.slice(i * 3, i * 3 + 3).map((c: any) => c.id)));
    const nw = s.new_wave ? { alloc: [3], cells: s.cells.slice(s.waves.length * 3, s.waves.length * 3 + 3).map((c: any) => c.id) } : null;
    const pending = [...taken, ...(nw?.cells ?? [])].filter((id) => !s.results[id]);
    const done = Object.keys(s.results).length;
    return { status: done >= 3 ? "estimating" : "collecting", overall: done >= 3 ? { estimate: 10, lo: 5, hi: 15, reported: 2, hidden: 8, method: "stratified" } : null,
      new_wave: nw, pending, unreachable: Object.keys(s.results).filter((k) => s.results[k].unreachable), checks_done: done, cells: [], strata: [], waves: [],
      silent_zones: [{ id: s.cells[1].id, reason: "high hazard, no reports", action: "send a team" }], observation_suggestion: { stratum: 0, reason: "widest", cells: [s.cells[5].id] },
      trace: [{ step: "design" }] };
  });
  await f.listen({ port: 0, host: "127.0.0.1" });
  return f;
}

let engine: FastifyInstance, app: FastifyInstance, full: FastifyInstance;
let uploads: string;
const AUTH1 = "chief@district.example", AUTH2 = "deputy@district.example";
type H = Record<string, string>;
const hdr = (t: string): H => ({ authorization: `Bearer ${t}` });
let ipN = 0;
const ip = () => `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}`;   // the auth rate limit is per IP
let A1: H, A2: H;
async function signup(a: FastifyInstance, email: string, extra: Record<string, unknown> = {}) {
  const r = await a.inject({ method: "POST", url: "/api/auth/register", remoteAddress: ip(), payload: { email, password: "password123", name: email.split("@")[0], ...extra } });
  assert.equal(r.statusCode, 201, r.body);
  return { h: hdr(r.json().token), user: r.json().user, token: r.json().token as string };
}

before(async () => {
  engine = await fakeEngine();
  uploads = mkdtempSync(join(tmpdir(), "maun-test-"));
  const port = (engine.server.address() as { port: number }).port;
  const env = { ENGINE_URL: `http://127.0.0.1:${port}`, JWT_SECRET: "test", SQLITE_PATH: ":memory:", MONITOR_SCHEDULER: "false",
    AUTHORITY_EMAILS: `${AUTH1}, ${AUTH2}`, UPLOADS_DIR: uploads, DRAIN_AUTHORITY_EMAIL: "ward-office@city.example" };
  app = await buildApp(loadConfig(env as any), { logger: false });
  full = await buildApp(loadConfig({ ...env, FEATURE_MODE: "full" } as any), { logger: false });
  A1 = (await signup(app, AUTH1)).h;
  A2 = (await signup(app, AUTH2)).h;
});

after(async () => {
  await app.close();
  await full.close();
  await engine.close();
  rmSync(uploads, { recursive: true, force: true });
});

// ---------------------------------------------------------------- feature flag
test("disaster mode hides API keys, webhooks, usage and new satellite questions; full mode restores them", async () => {
  const a = await signup(app, "flag@x.example");
  for (const url of ["/api/keys", "/api/webhooks", "/api/usage", "/api/settings/integrations"]) {
    assert.equal((await app.inject({ url, headers: a.h })).statusCode, 404, url);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/compile", headers: a.h, payload: { question: "kilns", region_id: "x" } })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/edition" })).json().featureMode, "disaster");
  const b = await signup(full, "flag@x.example");
  assert.equal((await full.inject({ url: "/api/keys", headers: b.h })).statusCode, 200);
  assert.equal((await full.inject({ url: "/api/usage", headers: b.h })).statusCode, 200);
  assert.equal(isHidden("disaster", "GET", "/api/queries/abc/trace"), false, "trace/replay endpoints stay reachable");
  assert.equal(isHidden("disaster", "POST", "/api/detections"), true);
});

// ---------------------------------------------------------------- roles
test("roles: self-chosen citizen/volunteer, authority only by allow-list, the role is in the JWT and re-checked", async () => {
  const bad = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "sneaky@x.example", password: "password123", role: "authority" } });
  assert.equal(bad.statusCode, 400, "authority cannot be self-assigned at sign-up");
  const v = await signup(app, "vol@x.example", { role: "volunteer", ward: "Ward 4" });
  assert.equal(v.user.role, "volunteer");
  assert.equal(JSON.parse(Buffer.from(v.token.split(".")[1], "base64url").toString()).role, "volunteer");
  assert.equal((await app.inject({ method: "PATCH", url: "/api/profile", headers: v.h, payload: { role: "authority" } })).statusCode, 400);
  const boss = { h: A1 };
  assert.equal((await app.inject({ url: "/api/auth/me", headers: A1 })).json().role, "authority");
  assert.equal((await app.inject({ url: "/api/admin/users", headers: v.h })).statusCode, 403);
  const people = (await app.inject({ url: "/api/admin/users?role=volunteer", headers: boss.h })).json();
  assert.ok(people.some((p: any) => p.email === "vol@x.example" && p.ward === "Ward 4"));
  // an allow-listed authority grants authority, then removes it: the old token loses access at once
  const c = await signup(app, "officer@x.example");
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/users/${c.user.id}/role`, headers: boss.h, payload: { role: "authority" } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/matches", headers: c.h })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/users/${v.user.id}/role`, headers: c.h, payload: { role: "authority" } })).statusCode, 403,
    "a granted (not allow-listed) authority cannot grant roles");
  await app.inject({ method: "POST", url: `/api/admin/users/${c.user.id}/role`, headers: boss.h, payload: { role: "citizen" } });
  assert.equal((await app.inject({ url: "/api/matches", headers: c.h })).statusCode, 403, "demotion applies to the existing token");
});

// ---------------------------------------------------------------- requests and SOS
test("request lifecycle: citizen creates, only authorities triage, citizens see only their own", async () => {
  const cit = await signup(app, "cit1@x.example");
  const other = await signup(app, "cit2@x.example");
  const boss = A1;
  const r = await app.inject({ method: "POST", url: "/api/requests", headers: cit.h, payload: { type: "food_water", description: "No drinking water for 3 days", severity: 3,
    peopleAffected: 6, lat: 26.32, lng: 91.0, originalText: "তিন দিন ধৰি খোৱা পানী নাই", originalLanguage: "as", summaryEn: "No drinking water for three days" } });
  assert.equal(r.statusCode, 201, r.body);
  const req = r.json();
  assert.equal(req.originalText, "তিন দিন ধৰি খোৱা পানী নাই", "the original text is kept next to the summary");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/requests/${req.id}`, headers: cit.h, payload: { status: "resolved" } })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/requests/${req.id}`, headers: other.h })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/requests", headers: other.h })).json().length, 0);
  const t = await app.inject({ method: "PATCH", url: `/api/requests/${req.id}`, headers: boss, payload: { status: "verified", priority: 2 } });
  assert.equal(t.json().status, "verified");
  const list = (await app.inject({ url: "/api/requests?sort=priority", headers: boss })).json();
  assert.ok(list.find((x: any) => x.id === req.id).confidence.score >= 0);
  const notes = (await app.inject({ url: "/api/notifications", headers: boss })).json();
  assert.ok(notes.some((n: any) => n.title.includes("high-severity")), "authorities are notified about high-severity requests");
  assert.ok((await app.inject({ url: "/api/notifications", headers: cit.h })).json().some((n: any) => n.title.includes("verified")));
});

test("SOS: idempotent by client id, flags location and repeats, 60-second cancel, 3 per 10 minutes", async () => {
  const s = await signup(app, "sos@x.example", { ward: "Ward 9" });
  const send = (clientId: string, loc = true) => app.inject({ method: "POST", url: "/api/requests", headers: s.h,
    payload: { source: "sos", clientId, ...(loc ? { lat: 26.3, lng: 91.01, accuracyM: 12 } : {}) } });
  const a = await send("client-aaaa-1");
  assert.equal(a.statusCode, 201);
  assert.equal(a.json().severity, 4);
  const again = await send("client-aaaa-1");
  assert.equal(again.statusCode, 200, "a retry returns the same SOS");
  assert.equal(again.json().id, a.json().id);
  const b = await send("client-bbbb-2", false);
  assert.ok(b.json().flags.includes("location_missing") && b.json().flags.includes("repeated"));
  assert.equal(b.json().area, "Ward 9", "falls back to the profile's area");
  const cancel = await app.inject({ method: "POST", url: `/api/requests/${b.json().id}/cancel`, headers: s.h, payload: { reason: "pocket" } });
  assert.equal(cancel.json().status, "cancelled");
  assert.ok(cancel.json().flags.includes("possible_accidental"));
  await send("client-cccc-3");
  assert.equal((await send("client-dddd-4")).statusCode, 429, "the fourth new SOS in 10 minutes is refused");
  assert.equal((await send("client-aaaa-1")).statusCode, 200, "retries still succeed");
  assert.equal((await app.inject({ method: "POST", url: "/api/requests", headers: s.h, payload: { source: "sos" } })).statusCode, 400, "needs a client id");
  // after 60 s the reporter can no longer cancel
  const store = (app as any).roles.store as Store;
  const rec = await store.getRecord<HelpRequest>("request", a.json().id);
  await store.putRecord("request", { ...rec!, createdAt: new Date(Date.now() - 61_000).toISOString() });
  assert.equal((await app.inject({ method: "POST", url: `/api/requests/${a.json().id}/cancel`, headers: s.h })).statusCode, 409);
  const notes = (await app.inject({ url: "/api/notifications", headers: A2 })).json();
  assert.ok(notes.some((n: any) => n.level === "critical" && n.title.startsWith("SOS")));
});

// ---------------------------------------------------------------- offers, matches, tasks
test("offer matched to a request creates a delivery task that a volunteer claims and completes", async () => {
  const cit = await signup(app, "needy@x.example");
  const giver = await signup(app, "boatman@x.example");
  const vol = await signup(app, "helper@x.example", { role: "volunteer" });
  const boss = A1;
  const req = (await app.inject({ method: "POST", url: "/api/requests", headers: cit.h, payload: { type: "rescue", description: "Stuck on roof", lat: 26.31, lng: 91.0, peopleAffected: 4, severity: 4 } })).json();
  const near = (await app.inject({ method: "POST", url: "/api/offers", headers: giver.h, payload: { type: "boat", quantity: 6, unit: "seats", lat: 26.312, lng: 91.002 } })).json();
  await app.inject({ method: "POST", url: "/api/offers", headers: giver.h, payload: { type: "food", quantity: 50, lat: 26.9, lng: 91.9 } });
  assert.equal((await app.inject({ url: "/api/offers", headers: giver.h })).json().length, 2);
  const sug = (await app.inject({ url: `/api/matches/suggest?requestId=${req.id}`, headers: boss })).json();
  assert.equal(sug[0].offer.id, near.id, "the nearby boat ranks first for a rescue");
  const m = (await app.inject({ method: "POST", url: "/api/matches", headers: boss, payload: { requestId: req.id, offerId: near.id } })).json();
  assert.ok(m.taskId);
  assert.equal((await app.inject({ method: "POST", url: "/api/matches", headers: boss, payload: { requestId: req.id, offerId: near.id } })).statusCode, 409);
  assert.equal((await app.inject({ url: "/api/tasks", headers: cit.h })).statusCode, 403, "citizens have no task board");
  assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${m.taskId}/complete`, headers: vol.h })).statusCode, 409, "claim first");
  assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${m.taskId}/claim`, headers: vol.h })).json().status, "claimed");
  assert.equal((await app.inject({ url: `/api/requests/${req.id}`, headers: cit.h })).json().status, "in_progress");
  const done = await app.inject({ method: "POST", url: `/api/tasks/${m.taskId}/complete`, headers: vol.h, payload: { note: "4 people moved to the school" } });
  assert.equal(done.json().status, "done");
});

// ---------------------------------------------------------------- official updates
test("official updates need a second authority before they are published", async () => {
  const a1 = A1, a2 = A2;
  const cit = await signup(app, "reader@x.example");
  assert.equal((await app.inject({ method: "POST", url: "/api/updates", headers: cit.h, payload: { title: "Fake", body: "Nope" } })).statusCode, 403);
  const u = (await app.inject({ method: "POST", url: "/api/updates", headers: a1, payload: { title: "Relief camp open", body: "School at Barpeta Road is open as a shelter.", severity: "advisory" } })).json();
  assert.equal(u.status, "pending_approval");
  assert.equal((await app.inject({ url: "/api/updates", headers: cit.h })).json().length, 0, "not visible before approval");
  assert.equal((await app.inject({ method: "POST", url: `/api/updates/${u.id}/approve`, headers: a1 })).statusCode, 409, "the author cannot approve");
  const ok = (await app.inject({ method: "POST", url: `/api/updates/${u.id}/approve`, headers: a2 })).json();
  assert.equal(ok.status, "published");
  assert.match(ok.delivery.note, /no email recipients|SMTP/);
  assert.equal((await app.inject({ url: "/api/updates", headers: cit.h })).json()[0].id, u.id);
  const log = (await app.inject({ url: "/api/audit", headers: a1 })).json();
  assert.ok(log.some((e: any) => e.action === "update.approve") && log.some((e: any) => e.action === "update.draft"), "authorities share one audit log");
});

// ---------------------------------------------------------------- intake and vision fallbacks
test("intake and vision fall back cleanly without a model, and validate model output strictly", async () => {
  const none = llmConfig("INTAKE", {});
  assert.equal(none.provider, "none");
  const r = await runIntake("पानी घर में घुस गया है", "hi", none);
  assert.equal(r.ok, false);
  const keyless = await runIntake("help", "en", llmConfig("INTAKE", { INTAKE_PROVIDER: "anthropic" }));
  assert.equal(keyless.ok, false);
  const v = await analysePhoto({ mime: "image/jpeg", base64: "" }, llmConfig("VISION", {}));
  assert.equal(v.ok, false);
  const good = validateIntake({ type: "Food Water", severity: 7, people_affected: "5", needs: ["water", ""], summary_en: "Family needs water", confidence: 3 });
  assert.deepEqual([good?.type, good?.severity, good?.people_affected, good?.needs, good?.confidence], ["food_water", 2, 5, ["water"], 1]);
  assert.equal(validateIntake({ type: "alien", summary_en: "x" }), null);
  assert.equal(validateIntake({ type: "rescue" }), null, "a summary is required");
  assert.equal(validateVision({ category: "clogged drain", severity: 3, confidence: 0.7, description: "Leaves block the drain" })?.category, "clogged_drain");
  assert.equal(validateVision({ category: "car" }), null);
  assert.deepEqual(extractJson('Sure! ```json\n{"a":1}\n```'), { a: 1 });
  const s = await signup(app, "intake@x.example");
  const res = await app.inject({ method: "POST", url: "/api/intake", headers: s.h, payload: { text: "Water entered our house", language: "en" } });
  assert.equal(res.json().ok, false, "no INTAKE_PROVIDER in tests: the citizen picks the type by hand");
});

// ---------------------------------------------------------------- images, Drain Watch
const seg = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
function jpegWithExif() {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\0\x01\x01")), seg(0xe1, Buffer.from("Exif\0\0GPS 26.3N 91.0E SECRET-DEVICE")),
    seg(0xfe, Buffer.from("comment by someone")), seg(0xdb, Buffer.alloc(10, 1)), Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x11, 0x22, 0x33]), Buffer.from([0xff, 0xd9])]);
}

test("photos: the real type is sniffed and EXIF, comments and PNG text are removed", () => {
  const j = jpegWithExif();
  const clean = stripJpeg(j);
  assert.equal(sniffImage(clean), "image/jpeg");
  assert.ok(!clean.includes(Buffer.from("SECRET-DEVICE")) && !clean.includes(Buffer.from("comment by")));
  assert.ok(clean.includes(Buffer.from("JFIF")) && clean.subarray(-2).equals(Buffer.from([0xff, 0xd9])));
  const chunk = (type: string, data: Buffer) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, "ascii"); data.copy(b, 8); return b; };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", Buffer.alloc(13)), chunk("tEXt", Buffer.from("Author\0Me")),
    chunk("eXIf", Buffer.from("gps")), chunk("IDAT", Buffer.alloc(4)), chunk("IEND", Buffer.alloc(0))]);
  const p = stripPng(png);
  assert.ok(!p.includes(Buffer.from("Author")) && p.includes(Buffer.from("IDAT")) && p.includes(Buffer.from("IEND")));
  assert.equal(cleanImage(`data:image/png;base64,${Buffer.from("not an image").toString("base64")}`).ok, false, "a fake MIME type is refused");
  assert.equal(cleanImage("%%%").ok, false);
});

test("Drain Watch: stored without metadata, private, PDF, needs a category without AI, merges duplicates within 30 m", async () => {
  const s = await signup(app, "drain@x.example", { ward: "Ward 12" });
  const other = await signup(app, "nosy@x.example");
  const photo = `data:image/jpeg;base64,${jpegWithExif().toString("base64")}`;
  const noCat = await app.inject({ method: "POST", url: "/api/drain", headers: s.h, payload: { photos: [photo], lat: 26.3, lng: 91.0 } });
  assert.equal(noCat.statusCode, 422, "no vision model: the citizen must choose the category");
  const r = await app.inject({ method: "POST", url: "/api/drain", headers: s.h, payload: { photos: [photo, photo], lat: 26.3, lng: 91.0, category: "open_sewer", clientId: "drain-client-1" } });
  assert.equal(r.statusCode, 201, r.body);
  const req = r.json().request;
  assert.equal(req.source, "drain_watch");
  assert.equal(req.drain.forwarded.to, "ward-office@city.example");
  assert.equal(req.drain.forwarded.status, "not_configured", "no SMTP in tests");
  const files = readdirSync(join(uploads, "drain", req.id));
  assert.equal(files.length, 2);
  assert.ok(!readFileSync(join(uploads, "drain", req.id, files[0])).includes(Buffer.from("SECRET-DEVICE")));
  assert.equal((await app.inject({ url: `/api/drain/${req.id}/photos/${files[0]}?token=${s.token}` })).statusCode, 200, "the reporter can view it");
  assert.equal((await app.inject({ url: `/api/drain/${req.id}/photos/${files[0]}`, headers: other.h })).statusCode, 404, "other citizens cannot");
  assert.equal((await app.inject({ url: `/api/drain/${req.id}/photos/..%2F..%2Fsecret.jpg`, headers: s.h })).statusCode, 404);
  const pdf = await app.inject({ url: `/api/drain/${req.id}/report.pdf`, headers: s.h });
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.equal(pdf.rawPayload.subarray(0, 4).toString(), "%PDF");
  // 15 m away, same category, someone else: a +1 confirmation, not a new report
  const dup = await app.inject({ method: "POST", url: "/api/drain", headers: other.h, payload: { photos: [photo], lat: 26.30013, lng: 91.0, category: "open_sewer" } });
  assert.equal(dup.statusCode, 200);
  assert.equal(dup.json().merged, true);
  assert.equal(dup.json().request.id, req.id);
  const diff = await app.inject({ method: "POST", url: "/api/drain", headers: other.h, payload: { photos: [photo], lat: 26.30013, lng: 91.0, category: "garbage_in_drain" } });
  assert.equal(diff.json().merged, false, "a different category is a separate report");
  const big = "A".repeat(11_400_000);
  assert.equal((await app.inject({ method: "POST", url: "/api/drain", headers: s.h, payload: { photos: [`data:image/jpeg;base64,${big}`], lat: 26.3, lng: 91.0, category: "other" } })).statusCode, 400);
});

// ---------------------------------------------------------------- hazard, observations and Maun
test("hazard layer relays per-source freshness; observation requests are labelled SIMULATED", async () => {
  const boss = A1;
  assert.equal((await app.inject({ url: "/api/hazard?bbox=1,2,3", headers: boss })).statusCode, 400);
  const g = (await app.inject({ url: "/api/hazard?bbox=90.9,26.2,91.0,26.3&cell=0.05", headers: boss })).json();
  assert.equal(g.sources.find((s: any) => s.id === "imerg").state, "not_configured");
  const o = (await app.inject({ method: "POST", url: "/api/observations", headers: boss, payload: { cellIds: ["c000_000"], priority: "high" } })).json();
  assert.equal(o.simulated, true);
  assert.match(o.note, /SIMULATED/);
  const cit = await signup(app, "obs@x.example");
  assert.equal((await app.inject({ method: "POST", url: "/api/observations", headers: cit.h, payload: { cellIds: ["c000_000"] } })).statusCode, 403);
});

test("Maun run: cells get reports and hazard, field-check tasks are created, results flow to the engine, outsiders refused", async () => {
  const boss = A1;
  const vol = await signup(app, "checker@x.example", { role: "volunteer" });
  computeCalls = [];
  const run = await app.inject({ method: "POST", url: "/api/maun/runs", headers: boss, payload: { name: "Barpeta test", bbox: "90.95,26.25,91.05,26.35", cellDeg: 0.025, waveSize: 3 } });
  assert.equal(run.statusCode, 201, run.body);
  const id = run.json().id;
  assert.equal(run.json().cellCount, 16);
  assert.ok(computeCalls[0].cells.some((c: any) => c.hazard === 0.8), "hazard from the hazard layer");
  assert.ok(computeCalls[0].cells.some((c: any) => c.reported > 0), "existing requests are counted per cell");
  const tasks = (await app.inject({ url: `/api/tasks?runId=${id}`, headers: vol.h })).json();
  assert.equal(tasks.length, 3);
  assert.ok(tasks.every((t: any) => t.type === "field_check"));
  // a volunteer cannot enter a result for a cell whose task they have not claimed
  assert.equal((await app.inject({ method: "POST", url: `/api/maun/runs/${id}/results`, headers: vol.h, payload: { cellId: tasks[0].cellId, households: 2 } })).statusCode, 403);
  await app.inject({ method: "POST", url: `/api/tasks/${tasks[0].id}/claim`, headers: vol.h });
  assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${tasks[0].id}/complete`, headers: vol.h, payload: {} })).statusCode, 400, "a count or unreachable is required");
  assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${tasks[0].id}/complete`, headers: vol.h, payload: { result: { households: 4 } } })).json().status, "done");
  await app.inject({ method: "POST", url: `/api/tasks/${tasks[1].id}/claim`, headers: vol.h });
  assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${tasks[1].id}/complete`, headers: vol.h, payload: { unreachable: true } })).json().status, "unreachable");
  const outsider = computeCalls[0].cells[10].id;
  assert.equal((await app.inject({ method: "POST", url: `/api/maun/runs/${id}/results`, headers: boss, payload: { cellId: outsider, households: 9 } })).statusCode, 409,
    "a cell that was not selected cannot be checked");
  await app.inject({ method: "POST", url: `/api/maun/runs/${id}/results`, headers: boss, payload: { cellId: tasks[2].cellId, households: 0 } });
  const last = computeCalls.at(-1);
  assert.deepEqual(last.results[tasks[1].cellId], { unreachable: true });
  assert.equal(last.looks, 3, "every entered result is a look for alpha spending");
  const detail = (await app.inject({ url: `/api/maun/runs/${id}`, headers: boss })).json();
  assert.equal(detail.last.status, "estimating");
  assert.ok(detail.observationIds.length >= 1, "a finished wave asks for sharper observation where the range is widest");
  const sz = (await app.inject({ url: "/api/maun/silent-zones", headers: boss })).json();
  assert.equal(sz.zones.length, 1);
  assert.equal((await app.inject({ url: "/api/maun/runs", headers: vol.h })).statusCode, 403);
  const w2 = await app.inject({ method: "POST", url: `/api/maun/runs/${id}/waves`, headers: boss, payload: { size: 3 } });
  assert.equal(w2.statusCode, 200);
  assert.equal((await app.inject({ url: `/api/tasks?runId=${id}&status=open`, headers: boss })).json().length, 3);
});

// ---------------------------------------------------------------- small pure helpers
test("helpers: ward emails, grid ids match the engine, report counting, confidence", () => {
  assert.deepEqual(parseWardEmails("Ward 4:a@x.org, bad, Ward 7 : b@y.org"), { "ward 4": "a@x.org", "ward 7": "b@y.org" });
  const g = makeGrid([90, 26, 90.1, 26.05], 0.05);
  assert.deepEqual(g.map((c) => c.id), ["c000_000", "c000_001"]);
  const mk = (id: string, owner: string, lat: number, hoursAgo: number, status = "new") => ({ id, ownerId: owner, lat, lng: 90.01, status, flags: [], createdAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString() }) as unknown as HelpRequest;
  const reqs = [mk("a", "u1", 26.01, 1), mk("b", "u2", 26.0101, 30), mk("c", "u3", 26.01, 1, "cancelled")];
  const counts = countReports(g, reqs);
  assert.deepEqual(counts.get("c000_000"), { reported: 2, reported_recent: 1, reported_earlier: 1 });
  const conf = confidenceOf(reqs[0], reqs, () => 0.9);
  assert.ok(conf.score > 0 && conf.score <= 1 && conf.factors.corroboration === 0, "the other report is 29 h away: no corroboration");
  assert.equal(confidenceOf(reqs[0], [...reqs, mk("d", "u4", 26.0102, 2)], () => null).factors.hazard, null);
});
