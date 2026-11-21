/**
 * npm run seed:demo   (from backend/, with the engine running for the Maun part)
 *
 * Seeds a DEMO data set into the configured database: 2 authorities (a bulletin needs two), 2 volunteers, 3 citizens,
 * requests (SOS, Assamese and Hindi in the citizens' own words), offers, Drain Watch reports, one approved bulletin and a
 * SIMULATED Maun run with one wave of simulated field checks done and the next wave waiting for volunteers.
 * Everything seeded is labelled as demo / SIMULATED. Run it once; it stops if the demo accounts already exist.
 */
import { deflateSync } from "node:zlib";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { HelpRequest } from "../src/disaster.js";
import { EngineClient } from "../src/engine-client.js";
import { computeAndStore, countReports, createTasks, makeGrid, recordFieldCheck, type MaunCell, type MaunRun } from "../src/maun.js";
import type { Profile } from "../src/roles.js";
import { MemoryStore } from "../src/store/memory.js";
import { PostgresStore } from "../src/store/postgres.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type { Store } from "../src/store/types.js";

const PASSWORD = "maun-demo-2026";
const BBOX: [number, number, number, number] = [90.85, 26.25, 91.15, 26.55];   // around Barpeta town, Assam

const config = loadConfig({ ...process.env, MONITOR_SCHEDULER: "false" });
const store: Store = config.databaseUrl ? new PostgresStore(config.databaseUrl) : config.sqlitePath === "memory" ? new MemoryStore() : new SqliteStore(config.sqlitePath);
const app = await buildApp(config, { store, logger: false });
let ipN = 0;
const call = async (method: string, url: string, token: string | null, payload?: unknown) => {
  const r = await app.inject({ method: method as any, url, payload: payload as any, remoteAddress: `10.77.0.${++ipN % 250}`,
    headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (r.statusCode >= 400) throw new Error(`${method} ${url} -> ${r.statusCode} ${r.body.slice(0, 200)}`);
  return r.json();
};

/** A small solid-colour PNG (a stand-in "photo": the demo has no real photos). */
function demoPng(r: number, g: number, b: number, w = 96, h = 72): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const shade = (x + y) % 16 < 8 ? 1 : 0.85; rows[o] = r * shade; rows[o + 1] = g * shade; rows[o + 2] = b * shade; }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function account(email: string, name: string, role: "citizen" | "volunteer" | "authority", ward: string, language = "en", extra: Partial<Profile> = {}) {
  const r = await call("POST", "/api/auth/register", null, { email, password: PASSWORD, name, role: role === "authority" ? "citizen" : role, ward, language });
  const p = (await store.getRecord<Profile>("profile", r.user.id))!;
  // authority is never self-assigned: the seed grants it the way an administrator would, and says so
  await store.putRecord("profile", { ...p, ...extra, role, grantedBy: role === "authority" ? "seed:demo" : null, displayName: name });
  const login = await call("POST", "/api/auth/login", null, { email, password: PASSWORD });
  return { id: r.user.id as string, token: login.token as string };
}

const DEMO = "(DEMO DATA)";
try {
  if (await store.userByEmail("control-room@maun.demo")) {
    console.log("Demo data is already seeded (control-room@maun.demo exists). Nothing changed.");
    process.exit(0);
  }
  console.log("Seeding DEMO data (all labelled demo / SIMULATED)…");
  const a1 = await account("control-room@maun.demo", "Demo · District Control Room", "authority", "Barpeta");
  const a2 = await account("deputy@maun.demo", "Demo · Deputy Commissioner's office", "authority", "Barpeta");
  const v1 = await account("volunteer1@maun.demo", "Demo · Rina (volunteer)", "volunteer", "Ward 3", "as", { skills: ["first aid", "swimming"], resources: ["country boat"] });
  const v2 = await account("volunteer2@maun.demo", "Demo · Imran (volunteer)", "volunteer", "Ward 7", "hi", { skills: ["driving"], resources: ["tractor"] });
  const c1 = await account("citizen1@maun.demo", "Demo · Hiren", "citizen", "Ward 3", "as");
  const c2 = await account("citizen2@maun.demo", "Demo · Sunita", "citizen", "Ward 7", "hi");
  const c3 = await account("citizen3@maun.demo", "Demo · Ali", "citizen", "Ward 9", "en");

  const req = (t: string, body: Record<string, unknown>) => call("POST", "/api/requests", t, { ...body, clientId: `demo-${Math.random().toString(36).slice(2, 12)}` });
  await req(c1.token, { source: "sos", lat: 26.3301, lng: 91.0102, accuracyM: 18 });
  await req(c1.token, { source: "local_language", type: "food_water", severity: 3, peopleAffected: 7, lat: 26.3332, lng: 91.0071, originalLanguage: "as",
    originalText: "আমাৰ ঘৰত তিনি দিন ধৰি খোৱা পানী নাই, সাতজন মানুহ আছো।", summaryEn: `No drinking water for three days, seven people in the house. ${DEMO}`,
    description: `আমাৰ ঘৰত তিনি দিন ধৰি খোৱা পানী নাই ${DEMO}`, needs: ["drinking water"] });
  await req(c2.token, { source: "local_language", type: "medical", severity: 4, peopleAffected: 1, lat: 26.3105, lng: 90.9811, originalLanguage: "hi",
    originalText: "मेरी माँ को इंसुलिन चाहिए, घर के चारों ओर पानी भरा है।", summaryEn: `Mother needs insulin; the house is surrounded by water. ${DEMO}`,
    description: `मेरी माँ को इंसुलिन चाहिए ${DEMO}`, needs: ["insulin"] });
  await req(c3.token, { source: "form", type: "road_blocked", severity: 2, lat: 26.3521, lng: 91.0402, description: `Tree fallen across the road to the school. ${DEMO}` });
  await req(c3.token, { source: "form", type: "shelter", severity: 3, peopleAffected: 12, lat: 26.2905, lng: 91.0611, description: `Twelve people need a dry place tonight. ${DEMO}` });

  await call("POST", "/api/offers", c3.token, { type: "boat", quantity: 6, unit: "seats", description: `Country boat with oarsman ${DEMO}`, lat: 26.3254, lng: 91.0051 });
  await call("POST", "/api/offers", v2.token, { type: "vehicle", quantity: 1, unit: "tractor", description: `Tractor with trailer ${DEMO}`, lat: 26.3101, lng: 90.9901 });
  await call("POST", "/api/offers", c2.token, { type: "food", quantity: 40, unit: "meals", description: `Cooked meals from the community kitchen ${DEMO}`, lat: 26.3201, lng: 91.0201 });

  await call("POST", "/api/drain", c1.token, { photos: [demoPng(90, 80, 60)], lat: 26.3227, lng: 91.0155, category: "overflowing_drain", description: `Drain overflowing into the lane ${DEMO}` });
  await call("POST", "/api/drain", c2.token, { photos: [demoPng(60, 70, 90)], lat: 26.3228, lng: 91.0156, category: "overflowing_drain", description: `Same drain, still overflowing ${DEMO}` });
  await call("POST", "/api/drain", c3.token, { photos: [demoPng(40, 40, 40)], lat: 26.3402, lng: 90.9905, category: "open_sewer", description: `Open manhole on the main road ${DEMO}` });

  const u = await call("POST", "/api/updates", a1.token, { title: "[DEMO] Relief camp open at Barpeta Government HS School", severity: "advisory", area: "Barpeta town, wards 1-9",
    body: "DEMO DATA. The school hall is open as a relief camp with drinking water and a medical desk. Bring medicines and documents." });
  await call("POST", `/api/updates/${u.id}/approve`, a2.token);

  // ---- SIMULATED Maun run
  const engine = new EngineClient(config.engineUrl);
  try {
    await engine.get("/health");
  } catch {
    console.log(`Engine not reachable at ${config.engineUrl}: skipped the SIMULATED Maun run. Start the engine and run the seed again on a fresh database.`);
    throw new Error("__done__");
  }
  const cellDeg = 0.025;
  const base = makeGrid(BBOX, cellDeg);
  const counts = countReports(base, await store.listRecords<HelpRequest>("request"));
  // SIMULATED flood: a river running north-south near 91.0 E; hazard falls with distance from it
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const flood = (lat: number, lng: number) => Math.max(0, Math.min(1, 1.1 * Math.exp(-Math.abs(lng - (91.0 + 0.03 * Math.sin((lat - 26.25) * 20))) * 111 / 5) + (rnd() - 0.5) * 0.12));
  const cells: MaunCell[] = base.map((c) => {
    const lat = (c.bbox[1] + c.bbox[3]) / 2, lng = (c.bbox[0] + c.bbox[2]) / 2;
    return { ...c, hazard: Math.round(flood(lat, lng) * 1000) / 1000, population: null, ...counts.get(c.id)!, area: `${lat >= 26.4 ? "North" : "South"}-${lng >= 91.0 ? "east" : "west"}` };
  });
  const run: MaunRun = { id: `maun-demo-${Date.now().toString(36)}`, ownerId: a1.id, createdAt: new Date().toISOString(), name: "Barpeta demo (SIMULATED)", bbox: BBOX, cellDeg,
    seed: 2026, conf: 0.95, waveSize: 30, cells, waves: [], results: {}, resultMeta: {}, looks: 0, hazardSources: [], simulated: true, observationIds: [], createdBy: a1.id, last: null,
    notes: ["SIMULATED: hazard scores come from a generated flood field, and the first wave's field checks are simulated counts. Nothing here describes a real event.",
      "Population: placeholder of 400 people per km².", "Reported need counts each demo request in a cell as one household."] };
  await computeAndStore(store, engine, run, run.waveSize);
  await createTasks(store, run, run.waves[0].cells, a1.id);
  const hh = (c: MaunCell) => (400 * c.area_km2) / 4.5;
  const wave1 = run.waves[0].cells;
  for (const [i, cid] of wave1.entries()) {
    const c = cells.find((x) => x.id === cid)!;
    const task = (await store.listRecords<any>("task")).find((t) => t.runId === run.id && t.cellId === cid)!;
    // one cell is unreachable: it stays in the sample (never swapped) and widens the range
    const result = i === wave1.length - 1 ? { unreachable: true as const } : { households: Math.round(hh(c) * 0.25 * c.hazard ** 1.3 * (0.7 + rnd() * 0.6)) };
    await recordFieldCheck(store, engine, { id: task.id, runId: run.id, cellId: cid, claimedBy: i % 2 ? v1.id : v2.id }, result, i % 2 ? v1.id : v2.id);
    await store.putRecord("task", { ...task, status: "unreachable" in result ? "unreachable" : "done", claimedBy: i % 2 ? v1.id : v2.id,
      claimedByName: i % 2 ? "Demo · Rina (volunteer)" : "Demo · Imran (volunteer)", completedAt: new Date().toISOString(),
      result: "unreachable" in result ? null : { households: result.households, simulated: true }, note: "SIMULATED field check (demo)" });
  }
  const fresh = (await store.getRecord<MaunRun>("maun_run", run.id))!;
  await computeAndStore(store, engine, fresh, fresh.waveSize);
  await createTasks(store, fresh, fresh.waves.at(-1)!.cells, a1.id);
  const o = fresh.last?.overall;
  console.log(`SIMULATED Maun run: ${cells.length} cells, ${fresh.last?.checks_done} simulated checks, ` +
    (o ? `estimate ${Math.round(o.estimate)} households (95% range ${Math.round(o.lo)}-${Math.round(o.hi)}), reported ${o.reported}. ` : "collecting. ") +
    `Wave 2 (${fresh.waves.at(-1)!.cells.length} field checks) is waiting for volunteers.`);
} catch (e) {
  if ((e as Error).message !== "__done__") { console.error(e); process.exitCode = 1; }
} finally {
  await app.close();
}
console.log(`\nDemo accounts (password: ${PASSWORD}):
  authority  control-room@maun.demo, deputy@maun.demo
  volunteer  volunteer1@maun.demo, volunteer2@maun.demo
  citizen    citizen1@maun.demo, citizen2@maun.demo, citizen3@maun.demo`);
