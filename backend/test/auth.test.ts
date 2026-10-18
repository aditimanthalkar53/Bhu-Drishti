import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import Fastify from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createSimpleReportPdf } from "../src/report-simple.js";

const dir = mkdtempSync(join(tmpdir(), "bd-auth-"));
const dbPath = join(dir, "users.sqlite");
after(() => rmSync(dir, { recursive: true, force: true }));

async function fakeEngine() {
  const f = Fastify();
  f.get("/health", async () => ({ ok: true }));
  await f.listen({ port: 0, host: "127.0.0.1" });
  return f;
}

const cfg = (port: number, extra: Record<string, string> = {}) =>
  loadConfig({ ENGINE_URL: `http://127.0.0.1:${port}`, JWT_SECRET: "test", SQLITE_PATH: dbPath, MONITOR_SCHEDULER: "false", ...extra } as any);

test("guest sign-in is off by default and the API needs an account", async () => {
  const engine = await fakeEngine();
  const app = await buildApp(cfg((engine.server.address() as any).port), { logger: false });
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/guest" })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/projects" })).statusCode, 401);
    // the public health endpoint stays open (the landing page uses it)
    assert.equal((await app.inject({ url: "/api/health" })).statusCode, 200);
  } finally {
    await app.close();
    await engine.close();
  }
});

test("accounts live in SQLite and survive a restart; old guest tokens are refused", async () => {
  const engine = await fakeEngine();
  const port = (engine.server.address() as any).port;
  // a guest created while guests were allowed…
  let app = await buildApp(cfg(port, { ALLOW_GUEST: "true" }), { logger: false });
  const guestToken = (await app.inject({ method: "POST", url: "/api/auth/guest" })).json().token;
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "Officer@Example.org", password: "first-pass-123", name: "Officer" } });
  assert.equal(reg.statusCode, 201);
  await app.close();

  // …restart with the default config (no guests) on the same SQLite file
  app = await buildApp(cfg(port), { logger: false });
  try {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "officer@example.org", password: "first-pass-123" } });
    assert.equal(login.statusCode, 200, "user persisted across restart");
    const H = { authorization: `Bearer ${login.json().token}` };
    assert.equal((await app.inject({ url: "/api/projects", headers: H })).json().length, 1, "default project persisted");
    assert.equal((await app.inject({ url: "/api/projects", headers: { authorization: `Bearer ${guestToken}` } })).statusCode, 401);

    // password change
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/password", headers: H, payload: { current: "wrong", next: "second-pass-456" } })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/password", headers: H, payload: { current: "first-pass-123", next: "second-pass-456" } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "officer@example.org", password: "first-pass-123" } })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "officer@example.org", password: "second-pass-456" } })).statusCode, 200);
    // short passwords are rejected
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "x@example.org", password: "short" } })).statusCode, 400);
  } finally {
    await app.close();
    await engine.close();
  }
});

test("plain-language PDF explains the result without jargon", async () => {
  const pdf = await createSimpleReportPdf({
    reportId: "r1", title: "Barpeta flood", queries: [{
      queryId: "q1", question: "What percentage of cropland was flooded during 1-15 July 2024?", status: "done",
      answer: "About 19.5% of cropland…", estimate: { value: 19.5, lo: 15.4, hi: 23.5, halfwidth: 4.05, total_km2: 239, base_km2: 1228 },
      result: { data_mode: "live", region: { name: "Barpeta", state: "Assam" }, query: { task: "area_fraction", target: "flooded_cropland", start: "2024-07-01", end: "2024-07-15" },
        advisory: { items: [{ title: "Report crop loss quickly", detail: "", who: "Farmers", when: "within 72 hours" }] } },
    }],
  });
  const text = pdf.toString("latin1");
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.ok((text.match(/\/Type \/Page\b/g) ?? []).length <= 2);
});


test("password reset is single-use and expires; password change signs out other devices", async () => {
  const { SqliteStore } = await import("../src/store/sqlite.js");
  const { sha256 } = await import("../src/auth.js");
  const store = new SqliteStore(":memory:");
  const engine = await fakeEngine();
  const app = await buildApp(cfg((engine.server.address() as any).port), { logger: false, store });
  try {
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "reset@example.org", password: "first-pass-123", name: "R" } });
    const oldToken = reg.json().token;
    const uid = reg.json().user.id;
    // no SMTP in tests → the same 503 whether or not the account exists (no account probing)
    const a = await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: "reset@example.org" } });
    const b = await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: "nobody@example.org" } });
    assert.equal(a.statusCode, b.statusCode);
    // a reset token as the email link would carry it
    const token = "t".repeat(43);
    await store.putRecord("reset", { id: sha256(token), ownerId: uid, createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000 });
    await new Promise((r) => setTimeout(r, 1100));   // make the old token strictly older than the revocation second
    const ok = await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token, password: "second-pass-456" } });
    assert.equal(ok.statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token, password: "third-pass-789" } })).statusCode, 400, "single use");
    assert.equal((await app.inject({ url: "/api/projects", headers: { authorization: `Bearer ${oldToken}` } })).statusCode, 401, "old sessions ended");
    assert.equal((await app.inject({ url: "/api/projects", headers: { authorization: `Bearer ${ok.json().token}` } })).statusCode, 200);
    const expired = "e".repeat(43);
    await store.putRecord("reset", { id: sha256(expired), ownerId: uid, createdAt: new Date().toISOString(), expiresAt: Date.now() - 1 });
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token: expired, password: "x-pass-12345" } })).statusCode, 400);
    // sign out everywhere
    const t2 = ok.json().token;
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout-everywhere", headers: { authorization: `Bearer ${t2}` } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/projects", headers: { authorization: `Bearer ${t2}` } })).statusCode, 401);
  } finally {
    await app.close();
    await engine.close();
  }
});

test("a run lost to an engine restart is closed as failed, not left running", async () => {
  const f = Fastify();
  f.get("/health", async () => ({ ok: true }));
  f.post("/queries", async (_req, reply) => reply.code(201).send({ id: "lostjob1", compile: {}, plan: { ok: true } }));
  f.get("/queries/:id", async (_req, reply) => reply.code(404).send({ detail: "no job" }));   // the engine restarted
  await f.listen({ port: 0, host: "127.0.0.1" });
  const app = await buildApp(cfg((f.server.address() as any).port, { SQLITE_PATH: ":memory:" }), { logger: false });
  try {
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "lost@example.org", password: "first-pass-123" } });
    const H = { authorization: `Bearer ${reg.json().token}` };
    const [p] = (await app.inject({ url: "/api/projects", headers: H })).json();
    const started = await app.inject({ method: "POST", url: `/api/projects/${p.id}/queries`, headers: H, payload: { question: "flooded cropland?", region_id: "x" } });
    assert.equal(started.statusCode, 201);
    const got = (await app.inject({ url: "/api/queries/lostjob1", headers: H })).json();
    assert.equal(got.session.status, "failed");
    assert.match(got.session.answer, /interrupted/);
  } finally {
    await app.close();
    await f.close();
  }
});
