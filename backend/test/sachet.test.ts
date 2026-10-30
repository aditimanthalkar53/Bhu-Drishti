import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { parseFeed, SachetService } from "../src/sachet.js";

const CAP = `<?xml version="1.0"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>TEST-1</identifier><sender>test@example.org</sender><sent>2026-10-20T08:00:00+05:30</sent>
  <info><language>en-IN</language><category>Met</category><event>Heavy Rain</event><urgency>Expected</urgency>
    <severity>Severe</severity><certainty>Likely</certainty><effective>2026-10-20T09:00:00+05:30</effective>
    <expires>2026-10-21T09:00:00+05:30</expires><senderName>Test Authority</senderName>
    <headline>Heavy rain &amp; flooding</headline><description>Rain &lt;b&gt;expected&lt;/b&gt;.</description>
    <instruction>Stay indoors.</instruction><web>https://example.org/a/1</web>
    <area><areaDesc>Barpeta</areaDesc></area><area><areaDesc>Nalbari</areaDesc></area></info>
</alert>`;
const RSS = `<rss><channel>
  <item><title>Cyclone warning</title><link>https://example.org/c/1</link><guid>g-1</guid><pubDate>Tue, 20 Oct 2026 03:00:00 GMT</pubDate><description><![CDATA[<p>Coast</p>]]></description></item>
  <item><title>Cyclone warning</title><link>https://example.org/c/1</link><guid>g-1</guid></item>
  <item><title>Flood</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

test("parses CAP 1.2 with all provided fields", () => {
  const [a] = parseFeed(CAP);
  assert.equal(a.sourceId, "TEST-1");
  assert.equal(a.title, "Heavy rain & flooding");
  assert.equal(a.severity, "Severe");
  assert.equal(a.areaDesc, "Barpeta; Nalbari");
  assert.equal(a.expires, "2026-10-21T03:30:00.000Z");
  assert.equal(a.description, "Rain expected .");
  assert.equal(a.link, "https://example.org/a/1");
});

test("parses RSS, de-duplicates by identifier, drops unsafe links, leaves absent fields null", () => {
  const list = parseFeed(RSS);
  assert.equal(list.length, 2);
  const c = list.find((x) => x.sourceId === "g-1")!;
  assert.equal(c.severity, null);
  assert.equal(c.description, "Coast");
  assert.equal(list.find((x) => x.title === "Flood")!.link, null);
});

// the shape SACHET really serves: prefixed tags, self-closing empties, one <info> per language
const capFile = (status = "Actual", msgType = "Update") => `<cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
<cap:identifier>IN-1_29</cap:identifier><cap:sender>Maharashtra-SDMA</cap:sender><cap:sent>2026-10-30T22:45:53+05:30</cap:sent>
<cap:status>${status}</cap:status><cap:msgType>${msgType}</cap:msgType><cap:restriction/>
<cap:info><cap:language>en-IN</cap:language><cap:category>Met</cap:category><cap:event>Light Rain</cap:event>
<cap:severity>Moderate</cap:severity><cap:urgency>Expected</cap:urgency><cap:certainty>Likely</cap:certainty>
<cap:expires>2026-10-31T01:00:00+05:30</cap:expires><cap:headline>Light rain over Pune</cap:headline><cap:description/>
<cap:instruction>Please follow SDMA guidelines.</cap:instruction>
<cap:area><cap:areaDesc>Pune,Thane districts of Maharashtra</cap:areaDesc></cap:area></cap:info>
<cap:info><cap:language>MR</cap:language><cap:category>Met</cap:category><cap:event>Light Rain</cap:event><cap:headline>पुणे</cap:headline></cap:info>
</cap:alert>`;

test("parses prefixed CAP as SACHET serves it: English info, empty tags stay null", () => {
  const [a] = parseFeed(capFile());
  assert.equal(a.title, "Light rain over Pune");
  assert.equal(a.severity, "Moderate");
  assert.equal(a.areaDesc, "Pune,Thane districts of Maharashtra");
  assert.equal(a.description, null);
  assert.equal(a.msgType, "Update");
  assert.equal(a.detailed, true);
});

test("CAP documents that are not Actual are never shown", () => {
  for (const s of ["Test", "Exercise", "Draft", "System"]) assert.deepEqual(parseFeed(capFile(s)), [], s);
});

test("RSS items are filled in from their CAP files", async () => {
  const f = Fastify();
  const got: Record<string, number> = {};
  const offHost: string[] = [];
  let failing = true;
  f.get("/rss", async (req, reply) => {
    const base = `http://${req.headers.host}/cap`;
    const item = (id: string, link: string) => `<item><title>RSS ${id}</title><link>${link}</link><guid>${id}</guid><category>Met</category><pubDate>Fri, 30 Oct 2026 17:15:55 GMT</pubDate></item>`;
    return reply.type("application/xml").send(`<rss><channel>${item("ok", `${base}?id=ok`)}${item("drill", `${base}?id=drill`)}${item("flaky", `${base}?id=flaky`)}${item("html", `${base}?id=html`)}${item("off", "http://off-host.invalid/cap")}</channel></rss>`);
  });
  f.get<{ Querystring: { id: string } }>("/cap", async (req, reply) => {
    const id = req.query.id;
    got[id] = (got[id] ?? 0) + 1;
    if (id === "drill") return reply.type("application/xml").send(capFile("Exercise"));
    if (id === "html") return reply.type("text/html").send("<html>maintenance</html>");
    if (id === "flaky" && failing) return reply.code(503).send("busy");
    return reply.type("application/xml").send(capFile());
  });
  await f.listen({ port: 0, host: "127.0.0.1" });
  try {
    const url = `http://127.0.0.1:${(f.server.address() as { port: number }).port}/rss`;
    const realFetch = fetch;
    const svc = new SachetService({ feedUrl: url, cacheMs: 0, fetchImpl: ((u: string, init: RequestInit) => {
      if (String(u).includes("off-host")) offHost.push(String(u));
      return realFetch(u, init);
    }) as typeof fetch });

    let r = await svc.get();
    assert.equal(r.state, "live");
    const byId = (id: string) => r.alerts.find((a) => a.sourceId === id);
    assert.equal(byId("drill"), undefined, "an Exercise message is dropped");
    assert.equal(byId("ok")!.severity, "Moderate");
    assert.equal(byId("ok")!.title, "Light rain over Pune");
    assert.ok(byId("ok")!.link!.includes("/cap?id=ok"), "falls back to the RSS link when the file has no <web>");
    assert.equal(byId("flaky")!.detailed, false, "a failed file keeps the RSS fields");
    assert.equal(byId("flaky")!.title, "RSS flaky");
    assert.equal(byId("html")!.detailed, false, "a non-CAP answer keeps the RSS fields");
    assert.equal(byId("off")!.detailed, false);
    assert.deepEqual(offHost, [], "links off the feed's host are not followed");

    failing = false;
    r = await svc.get(true);
    assert.equal(byId("flaky")!.detailed, true, "the failed file is retried");
    assert.equal(got.ok, 1, "a finished file is not fetched again");
    assert.equal(got.drill, 1);

    const off = await new SachetService({ feedUrl: url, capMax: 0, cacheMs: 0 }).get();
    assert.ok(off.alerts.every((a) => !a.detailed), "capMax 0 reads RSS only");
    assert.equal(off.alerts.length, 5);
    const one = await new SachetService({ feedUrl: url, capMax: 1, cacheMs: 0 }).get();
    assert.equal(one.alerts.filter((a) => a.detailed).length, 1, "capMax limits files per refresh");
  } finally {
    await f.close();
  }
});

test("non-feed input yields no alerts", () => {
  assert.deepEqual(parseFeed("<html>hi</html>"), []);
  assert.deepEqual(parseFeed(""), []);
});

let feed: FastifyInstance;
let mode: "cap" | "rss" | "500" | "junk" | "hang" = "cap";
let hits = 0;
let app: Awaited<ReturnType<typeof buildApp>>;
let noFeedApp: Awaited<ReturnType<typeof buildApp>>;
let H: Record<string, string>;
let H2: Record<string, string>;

before(async () => {
  feed = Fastify();
  feed.get("/feed", async (_req, reply) => {
    hits++;
    if (mode === "500") return reply.code(500).send("boom");
    if (mode === "junk") return reply.type("text/html").send("<html>login</html>");
    if (mode === "hang") await new Promise((r) => setTimeout(r, 3000));
    return reply.type("application/xml").send(mode === "cap" ? CAP : RSS);
  });
  await feed.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(feed.server.address() as { port: number }).port}/feed`;
  const cfg = () => loadConfig({ JWT_SECRET: "test", ALLOW_GUEST: "true", SQLITE_PATH: ":memory:", MONITOR_SCHEDULER: "false" } as any);
  app = await buildApp(cfg(), { logger: false, sachet: new SachetService({ feedUrl: url, cacheMs: 0, timeoutMs: 1000 }) });
  noFeedApp = await buildApp(cfg(), { logger: false, sachet: new SachetService({ feedUrl: "" }) });
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "s@example.org", password: "password123", name: "S" } });
  H = { authorization: `Bearer ${reg.json().token}` };
  const reg2 = await noFeedApp.inject({ method: "POST", url: "/api/auth/register", payload: { email: "s@example.org", password: "password123", name: "S" } });
  H2 = { authorization: `Bearer ${reg2.json().token}` };
});

after(async () => { await app.close(); await noFeedApp.close(); await feed.close(); });

test("requires sign-in", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/sachet/alerts" })).statusCode, 401);
});

test("no feed configured: honest empty state, no alerts, portal link", async () => {
  const r = (await noFeedApp.inject({ method: "GET", url: "/api/sachet/alerts", headers: H2 })).json();
  assert.equal(r.state, "not_configured");
  assert.deepEqual(r.alerts, []);
  assert.match(r.portalUrl, /sachet\.ndma\.gov\.in/);
});

test("live feed, then failure modes degrade safely", async () => {
  mode = "cap";
  let r = (await app.inject({ method: "GET", url: "/api/sachet/alerts?refresh=1", headers: H })).json();
  assert.equal(r.state, "live");
  assert.equal(r.alerts.length, 1);
  assert.ok(r.fetchedAt);

  mode = "500";
  r = (await app.inject({ method: "GET", url: "/api/sachet/alerts?refresh=1", headers: H })).json();
  assert.equal(r.state, "unavailable");
  assert.match(r.error, /HTTP 500/);
  assert.equal(r.alerts.length, 1, "last good data is kept, flagged unavailable");

  mode = "junk";
  r = (await app.inject({ method: "GET", url: "/api/sachet/alerts?refresh=1", headers: H })).json();
  assert.equal(r.state, "unavailable");

  mode = "hang";
  r = (await app.inject({ method: "GET", url: "/api/sachet/alerts?refresh=1", headers: H })).json();
  assert.equal(r.state, "unavailable");
  assert.match(r.error, /in time/);
});

test("caching avoids refetching within the window", async () => {
  mode = "cap";
  const svc = new SachetService({ feedUrl: `http://127.0.0.1:${(feed.server.address() as { port: number }).port}/feed`, cacheMs: 60_000 });
  const before = hits;
  await svc.get(); await svc.get();
  assert.equal(hits - before, 1);
});

test("email copy: 503 without SMTP, 404 for unknown alert", async () => {
  mode = "cap";
  const list = (await app.inject({ method: "GET", url: "/api/sachet/alerts?refresh=1", headers: H })).json();
  const none = await app.inject({ method: "POST", url: `/api/sachet/alerts/${list.alerts[0].id}/email`, headers: H });
  assert.equal(none.statusCode, 503);   // test environment has no SMTP credentials
});
