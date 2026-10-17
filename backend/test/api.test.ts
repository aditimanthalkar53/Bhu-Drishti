import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/** Minimal fake of the Python engine so the API can be tested in isolation. */
async function fakeEngine(): Promise<FastifyInstance> {
  const f = Fastify();
  const jobs = new Map<string, any>();
  f.get("/health", async () => ({ ok: true, provider: "fake" }));
  f.get("/regions", async () => [{ id: "r1", name: "Region 1", bbox: [0, 0, 1, 1] }]);
  f.post("/compile", async (req: any) => ({ compile: { ir: { question: req.body.question } }, plan: { ok: true } }));
  f.post("/queries", async (req: any, reply) => {
    if (req.body.question.includes("penguin")) return reply.code(422).send({ detail: "unknown target" });
    const id = `job${jobs.size + 1}`;
    jobs.set(id, { id, status: "done", result: { answer: "42% flooded", estimate: { value: 42, lo: 40, hi: 44 } } });
    return reply.code(201).send({ id, compile: {}, plan: { ok: true } });
  });
  f.get("/queries/:id", async (req: any, reply) => jobs.get(req.params.id) ?? reply.code(404).send({ detail: "no job" }));
  f.get("/queries/:id/evidence", async () => ({ type: "FeatureCollection", features: [] }));
  f.get("/queries/:id/events", async (_req, reply) => {
    reply.header("content-type", "text/event-stream");
    return reply.send(
      'event: plan\ndata: {"type":"plan"}\n\n' +
        'event: result\ndata: {"type":"result","answer":"42% flooded","estimate":{"value":42},"stop_reason":"precision_met"}\n\n' +
        "event: end\ndata: {}\n\n",
    );
  });
  await f.listen({ port: 0, host: "127.0.0.1" });
  return f;
}

let engine: FastifyInstance;
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  engine = await fakeEngine();
  const addr = engine.server.address() as { port: number };
  app = await buildApp(loadConfig({ ENGINE_URL: `http://127.0.0.1:${addr.port}`, JWT_SECRET: "test" } as any), { logger: false });
});

after(async () => {
  await app.close();
  await engine.close();
});

async function guest() {
  const r = await app.inject({ method: "POST", url: "/api/auth/guest" });
  assert.equal(r.statusCode, 201);
  return r.json().token as string;
}

test("health reports engine status", async () => {
  const r = await app.inject({ url: "/api/health" });
  assert.equal(r.json().engine.ok, true);
});

test("protected routes require auth", async () => {
  assert.equal((await app.inject({ url: "/api/projects" })).statusCode, 401);
});

test("register, login, me", async () => {
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "a@b.co", password: "password123", name: "Ana" } });
  assert.equal(reg.statusCode, 201);
  const dup = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "a@b.co", password: "password123" } });
  assert.equal(dup.statusCode, 409);
  const bad = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@b.co", password: "nope" } });
  assert.equal(bad.statusCode, 401);
  const ok = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "A@b.co", password: "password123" } });
  const me = await app.inject({ url: "/api/auth/me", headers: { authorization: `Bearer ${ok.json().token}` } });
  assert.equal(me.json().name, "Ana");
});

test("query session lifecycle with SSE relay persisting the result", async () => {
  const token = await guest();
  const h = { authorization: `Bearer ${token}` };
  const [project] = (await app.inject({ url: "/api/projects", headers: h })).json();
  assert.ok(project, "guest gets a default project");

  const start = await app.inject({ method: "POST", url: `/api/projects/${project.id}/queries`, headers: h, payload: { question: "flood share?", region_id: "r1" } });
  assert.equal(start.statusCode, 201);
  const id = start.json().session.id;

  const ev = await app.inject({ url: `/api/queries/${id}/events?token=${token}` });
  assert.match(ev.body, /event: result/);

  const list = (await app.inject({ url: `/api/projects/${project.id}/queries`, headers: h })).json();
  assert.equal(list[0].answer, "42% flooded");
  assert.equal(list[0].status, "done");

  const ev2 = await app.inject({ url: `/api/queries/${id}/evidence`, headers: h });
  assert.equal(ev2.json().type, "FeatureCollection");
});

test("engine validation errors are passed through", async () => {
  const token = await guest();
  const h = { authorization: `Bearer ${token}` };
  const [project] = (await app.inject({ url: "/api/projects", headers: h })).json();
  const r = await app.inject({ method: "POST", url: `/api/projects/${project.id}/queries`, headers: h, payload: { question: "count penguins", region_id: "r1" } });
  assert.equal(r.statusCode, 422);
});

test("users cannot read each other's queries", async () => {
  const t1 = await guest();
  const t2 = await guest();
  const [p1] = (await app.inject({ url: "/api/projects", headers: { authorization: `Bearer ${t1}` } })).json();
  const s = (await app.inject({ method: "POST", url: `/api/projects/${p1.id}/queries`, headers: { authorization: `Bearer ${t1}` }, payload: { question: "flood share?", region_id: "r1" } })).json();
  const r = await app.inject({ url: `/api/queries/${s.session.id}`, headers: { authorization: `Bearer ${t2}` } });
  assert.equal(r.statusCode, 404);
});

test("API keys authenticate programmatic access", async () => {
  const token = await guest();
  const k = await app.inject({ method: "POST", url: "/api/keys", headers: { authorization: `Bearer ${token}` }, payload: { label: "script" } });
  assert.equal(k.statusCode, 201);
  const r = await app.inject({ url: "/api/projects", headers: { "x-api-key": k.json().key } });
  assert.equal(r.statusCode, 200);
  const listed = (await app.inject({ url: "/api/keys", headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(listed[0].hash, undefined, "key hash never leaves the server");
});
