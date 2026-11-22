import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import PDFDocument from "pdfkit";
import { audit } from "./delivery.js";
import { DRAIN_CATEGORIES, haversineM, notifyAuthorities, now, validLatLng, type DrainCategory, type DrainInfo, type HelpRequest } from "./disaster.js";
import { sendMail, smtpConfigured } from "./email.js";
import { cleanImage, extFor, type ImageMime } from "./images.js";
import { RateLimiter } from "./ratelimit.js";
import { pdfText } from "./report.js";
import { guard, type Profile } from "./roles.js";
import type { Store } from "./store/types.js";
import { analysePhoto } from "./vision.js";

/**
 * Drain Watch: a citizen photographs an open sewer, clogged or overflowing drain or waterlogging. Up to 3 photos,
 * metadata stripped, stored under <uploads>/drain/<request id>/ and served only to the reporter and authorities.
 * Every report notifies the authorities in the app, and a one-page PDF is emailed to the ward authority (DRAIN_WARD_EMAILS
 * for the reporter's ward, else DRAIN_AUTHORITY_EMAIL, else the authority accounts' own addresses).
 * Unique keys: one report per spot per day (latitude/longitude rounded to 4 decimals, about 11 m) and one per photo per day
 * (SHA-256 of the cleaned image). A report that hits either key stores no photos; it only counts as a confirmation.
 * A report within 30 m of an open one of the same category from the last 7 days is merged into it as "+1 confirmation".
 */
export const DUPLICATE_RADIUS_M = 30;
export const DUPLICATE_WINDOW_MS = 7 * 86400_000;
const CITIZEN_CATEGORIES = DRAIN_CATEGORIES.filter((c) => c !== "not_a_drain");
const DEFAULT_SEVERITY: Record<DrainCategory, 1 | 2 | 3 | 4> = {
  open_sewer: 3, overflowing_drain: 3, waterlogging: 3, clogged_drain: 2, garbage_in_drain: 2, other: 2, not_a_drain: 1,
};
export const LABEL: Record<DrainCategory, string> = {
  open_sewer: "Open sewer / manhole", clogged_drain: "Clogged drain", overflowing_drain: "Overflowing drain", waterlogging: "Waterlogging",
  garbage_in_drain: "Garbage in drain", other: "Other drainage problem", not_a_drain: "Not a drain",
};

const drainLimiter = new RateLimiter(10, 60 * 60_000);
const analyseLimiter = new RateLimiter(20, 10 * 60_000);
const SAFE_ID = /^req-[a-z0-9-]+$/;
const SAFE_FILE = /^[a-z0-9-]+\.(jpg|png|webp)$/;
// RFC 2606 / 6761 reserved names and the demo accounts' domain: mail to these can never be delivered
const UNDELIVERABLE = /\.(demo|test|example|invalid|localhost)$/i;

type DrainKey = { id: string; ownerId: string; requestId: string; createdAt: string };
/** The calendar day in India, so "the same date" means what the citizen sees on their phone. */
export const dayOf = (t = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(t);
export const spotKey = (day: string, lat: number, lng: number) => `spot:${day}:${lat.toFixed(4)}:${lng.toFixed(4)}`;
export const photoKey = (day: string, data: Buffer) => `photo:${day}:${createHash("sha256").update(data).digest("hex")}`;

export interface DrainOptions { uploadsDir: string; appUrl: string; authorityEmail: string | null; wardEmails: Record<string, string> }

export function drainRoutes(app: FastifyInstance, store: Store, opts: DrainOptions) {
  const roles = app.roles;
  const dirOf = (id: string) => join(opts.uploadsDir, "drain", id);

  async function savePhotos(id: string, photos: { mime: ImageMime; data: Buffer }[], prefix: string): Promise<string[]> {
    await mkdir(dirOf(id), { recursive: true });
    const names: string[] = [];
    for (let i = 0; i < photos.length; i++) {
      const name = `${prefix}${i + 1}.${extFor(photos[i].mime)}`;
      await writeFile(join(dirOf(id), name), photos[i].data);
      names.push(name);
    }
    return names;
  }

  /** Who gets the emailed report: the ward's address, else DRAIN_AUTHORITY_EMAIL, else every authority account's own email. */
  async function recipients(ward: string | null | undefined): Promise<string | null> {
    const configured = (ward && opts.wardEmails[ward.toLowerCase()]) || opts.authorityEmail;
    if (configured) return configured;
    const emails = new Set<string>();
    for (const id of await roles.authorityIds()) {
      const e = (await store.userById(id))?.email?.trim().toLowerCase();
      if (e && !UNDELIVERABLE.test(e)) emails.add(e);
    }
    return emails.size ? [...emails].join(", ") : null;
  }

  /** Suggest a category for one photo before the citizen sends it. */
  app.post<{ Body: { photo: string } }>("/api/drain/analyze", {
    ...guard(app), bodyLimit: 12 * 1024 * 1024,
    schema: { body: { type: "object", required: ["photo"], properties: { photo: { type: "string", maxLength: 11_500_000 } } } },
  }, async (req, reply) => {
    if (!analyseLimiter.check(`va:${req.userId}`)) return reply.code(429).send({ error: "too many photos analysed — choose the category yourself" });
    const img = cleanImage(req.body.photo);
    if (!img.ok) return reply.code(400).send({ error: img.error });
    return analysePhoto({ mime: img.mime, base64: img.data.toString("base64") });
  });

  app.post<{ Body: { photos: string[]; lat: number; lng: number; accuracyM?: number | null; category?: DrainCategory; description?: string; clientId?: string } }>("/api/drain", {
    ...guard(app), bodyLimit: 36 * 1024 * 1024,
    schema: { body: { type: "object", required: ["photos", "lat", "lng"], properties: {
      photos: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", maxLength: 11_500_000 } },
      lat: { type: "number" }, lng: { type: "number" }, accuracyM: { type: ["number", "null"] },
      category: { type: "string", enum: CITIZEN_CATEGORIES }, description: { type: "string", maxLength: 1000 },
      clientId: { type: "string", minLength: 8, maxLength: 64 } } } },
  }, async (req, reply) => {
    const uid = req.userId!;
    const b = req.body;
    if (!validLatLng(b.lat, b.lng)) return reply.code(400).send({ error: "a location is needed: allow location access or place the pin" });
    const id = b.clientId ? `req-${createHash("sha256").update(`${uid}:drain:${b.clientId}`).digest("hex").slice(0, 20)}` : `req-${randomUUID()}`;
    const existing = await store.getRecord<HelpRequest>("request", id);
    if (existing) return reply.code(200).send({ request: existing, merged: false, duplicate: true });
    if (!drainLimiter.check(`drain:${uid}`)) return reply.code(429).send({ error: "10 Drain Watch reports per hour is the limit — thank you for reporting" });

    const photos: { mime: ImageMime; data: Buffer }[] = [];
    for (const p of b.photos) {
      const c = cleanImage(p);
      if (!c.ok) return reply.code(400).send({ error: c.error });
      photos.push({ mime: c.mime, data: c.data });
    }

    // unique keys: same spot or same photo on the same day → no new report and no photos stored
    const day = dayOf();
    const keys = [spotKey(day, b.lat, b.lng), ...photos.map((p) => photoKey(day, p.data))];
    for (const k of keys) {
      const hit = await store.getRecord<DrainKey>("drain_key", k);
      const base = hit && await store.getRecord<HelpRequest>("request", hit.requestId);
      if (!base?.drain) continue;
      const reporters = new Set([base.ownerId, ...base.drain.confirmations.map((c) => c.by)]);
      let cur = base;
      if (!reporters.has(uid)) {   // another citizen: count the confirmation, keep no photos
        cur = { ...base, updatedAt: now(), flags: [...new Set([...base.flags, "confirmed_by_others"])],
          drain: { ...base.drain, confirmations: [...base.drain.confirmations, { at: now(), by: uid, photos: [] }] },
          history: [...base.history, { at: now(), by: uid, action: "confirmed", detail: { duplicate: k.split(":")[0] } }] };
        await store.putRecord("request", cur);
      }
      const reason = k.startsWith("spot:") ? "this spot was already reported today" : "this photo was already sent today";
      return reply.code(200).send({ request: cur, merged: true, duplicate: true, reason, confirmations: cur.drain!.confirmations.length + 1 });
    }
    const claimKeys = (requestId: string) => Promise.all(keys.map((k) => store.putRecord<DrainKey>("drain_key", { id: k, ownerId: uid, requestId, createdAt: now() })));

    // category: the citizen's choice wins; otherwise the model's suggestion; otherwise ask the citizen
    // A local vision model can take minutes on a CPU. When the citizen has chosen the category, the report is saved at
    // once and the AI suggestion is added in the background; only without a category does the report wait for it.
    let vision: DrainInfo["vision"] = null, visionError: string | null = null;
    if (!b.category) {
      const v = await analysePhoto({ mime: photos[0].mime, base64: photos[0].data.toString("base64") });
      if (v.ok) vision = { provider: v.provider, ...v.result };
      else visionError = v.reason;
    }
    let category: DrainCategory, categorySource: DrainInfo["categorySource"];
    if (b.category) { category = b.category; categorySource = "citizen"; }
    else if (vision && vision.category !== "not_a_drain") { category = vision.category; categorySource = "ai"; }
    else return reply.code(422).send({ error: vision ? "The photo does not look like a drain problem. Choose a category if it is one." : "Choose a category for the photo.", vision, visionError });

    const profile = await roles.profile((await store.userById(uid))!);

    // +1 confirmation of an open report nearby
    const open = (await store.listRecords<HelpRequest>("request")).filter((r) => r.source === "drain_watch" && r.drain?.category === category &&
      r.status !== "resolved" && r.status !== "cancelled" && Date.now() - Date.parse(r.createdAt) < DUPLICATE_WINDOW_MS &&
      r.lat != null && haversineM(r.lat, r.lng!, b.lat, b.lng) <= DUPLICATE_RADIUS_M);
    if (open.length) {
      const base = open.sort((x, y) => haversineM(x.lat!, x.lng!, b.lat, b.lng) - haversineM(y.lat!, y.lng!, b.lat, b.lng))[0];
      const n = base.drain!.confirmations.length + 1;
      const names = await savePhotos(base.id, photos, `c${n}-`);
      const next: HelpRequest = { ...base, updatedAt: now(), flags: [...new Set([...base.flags, "confirmed_by_others"])],
        drain: { ...base.drain!, confirmations: [...base.drain!.confirmations, { at: now(), by: uid, photos: names }] },
        history: [...base.history, { at: now(), by: uid, action: "confirmed", detail: { photos: names.length } }] };
      await store.putRecord("request", next);
      await claimKeys(base.id);
      await audit(store, uid, uid, "drain.confirm", `request:${base.id}`, { confirmations: n }, profile.displayName);
      await notifyAuthorities(store, roles, `Drain Watch: ${LABEL[category]} confirmed again (${n + 1} reports)`,
        `From ${profile.displayName} at ${b.lat.toFixed(5)}, ${b.lng.toFixed(5)}: added to the open report within ${DUPLICATE_RADIUS_M} m`, "info", `/app/requests?open=${base.id}`);
      return reply.code(200).send({ request: next, merged: true, confirmations: n + 1 });
    }

    const severity = (categorySource === "ai" && vision ? vision.severity : DEFAULT_SEVERITY[category]) as HelpRequest["severity"];
    const names = await savePhotos(id, photos, "p");
    const to = await recipients(profile.ward);
    const r: HelpRequest = {
      id, ownerId: uid, createdAt: now(), type: category === "waterlogging" ? "waterlogging" : "drain_or_sewer",
      description: (b.description ?? "").trim().slice(0, 1000) || `${LABEL[category]} reported with Drain Watch`,
      originalText: null, originalLanguage: null, summaryEn: vision?.description || null, needs: [],
      lat: b.lat, lng: b.lng, accuracyM: typeof b.accuracyM === "number" ? Math.round(b.accuracyM) : null, locationAt: now(),
      area: profile.ward ?? null, severity, peopleAffected: null, contact: profile.phone ?? null, source: "drain_watch", status: "new",
      priority: null, assigneeId: null, offerIds: [], flags: [], clientId: b.clientId ?? null, reporterName: profile.displayName, intake: null,
      drain: { category, categorySource, photos: names, vision, visionError, confirmations: [],
        forwarded: { to: to ?? null, status: !to || !smtpConfigured() ? "not_configured" : "pending", at: null } },
      history: [{ at: now(), by: uid, action: "created", detail: { source: "drain_watch", category } }],
    };
    await store.putRecord("request", r);
    await claimKeys(id);
    await audit(store, uid, uid, "request.create", `request:${id}`, { source: "drain_watch", category, severity }, profile.displayName);
    await notifyAuthorities(store, roles, `Drain Watch: ${LABEL[category]}`, `From ${profile.displayName} at ${r.area ?? "location"} ${b.lat.toFixed(5)}, ${b.lng.toFixed(5)}`,
      severity >= 3 ? "warning" : "info", `/app/requests?open=${id}`);
    if (r.drain!.forwarded.status === "pending") void forward(r.id);
    if (b.category) void suggestLater(r.id, photos[0]);
    return reply.code(201).send({ request: r, merged: false });
  });

  /** Attach the model's suggestion to a saved report (the citizen's category stays). Never throws. */
  async function suggestLater(id: string, photo: { mime: ImageMime; data: Buffer }) {
    try {
      const v = await analysePhoto({ mime: photo.mime, base64: photo.data.toString("base64") });
      const cur = await store.getRecord<HelpRequest>("request", id);
      if (!cur?.drain) return;
      await store.putRecord("request", { ...cur, summaryEn: cur.summaryEn ?? (v.ok ? v.result.description || null : null),
        drain: { ...cur.drain, vision: v.ok ? { provider: v.provider, ...v.result } : null, visionError: v.ok ? null : v.reason } });
    } catch { /* the suggestion is optional */ }
  }

  async function forward(id: string) {
    const r = await store.getRecord<HelpRequest>("request", id);
    if (!r?.drain?.forwarded.to) return;
    let status: DrainInfo["forwarded"]["status"] = "sent", error: string | null = null;
    try {
      const pdf = await drainPdf(r, opts.uploadsDir, opts.appUrl);
      await sendMail({
        to: r.drain.forwarded.to, subject: `Drain Watch: ${LABEL[r.drain.category]} at ${r.lat!.toFixed(5)}, ${r.lng!.toFixed(5)}`,
        text: `A citizen reported a drainage problem through Drain Watch on the Maun platform.\n\nCategory: ${LABEL[r.drain.category]}\nSeverity: ${r.severity}/4\n` +
          `Location: ${r.lat}, ${r.lng} (https://maps.google.com/?q=${r.lat},${r.lng})\nWard: ${r.area ?? "not given"}\n\n${r.description}\n\n` +
          `The one-page report with photos is attached. This is an unverified citizen report, forwarded automatically.\n${opts.appUrl}/app/requests?open=${r.id}`,
        attachments: [{ filename: `drain-watch-${r.id}.pdf`, content: pdf, contentType: "application/pdf" }],
      });
    } catch (e) {
      status = "failed";
      error = (e as Error).message;
    }
    const cur = (await store.getRecord<HelpRequest>("request", id))!;
    await store.putRecord("request", { ...cur, drain: { ...cur.drain!, forwarded: { ...cur.drain!.forwarded, status, at: now(), error } } });
    await audit(store, r.ownerId, "system", "drain.forward", `request:${id}`, { to: r.drain.forwarded.to, status, error });
  }

  const canSee = async (r: HelpRequest, userId: string) => r.ownerId === userId || (await roles.roleOfId(userId)) === "authority";

  app.get<{ Params: { id: string; file: string } }>("/api/drain/:id/photos/:file", guard(app), async (req, reply) => {
    const { id, file } = req.params;
    if (!SAFE_ID.test(id) || !SAFE_FILE.test(file)) return reply.code(404).send({ error: "not found" });
    const r = await store.getRecord<HelpRequest>("request", id);
    if (!r?.drain || !(await canSee(r, req.userId!))) return reply.code(404).send({ error: "not found" });
    try {
      const data = await readFile(join(dirOf(id), file));
      const type = file.endsWith(".png") ? "image/png" : file.endsWith(".webp") ? "image/webp" : "image/jpeg";
      return reply.header("cache-control", "private, max-age=3600").type(type).send(data);
    } catch {
      return reply.code(404).send({ error: "photo not found" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/drain/:id/report.pdf", guard(app), async (req, reply) => {
    const r = await store.getRecord<HelpRequest>("request", req.params.id);
    if (!r?.drain || !(await canSee(r, req.userId!))) return reply.code(404).send({ error: "not found" });
    const pdf = await drainPdf(r, opts.uploadsDir, opts.appUrl);
    return reply.type("application/pdf").header("content-disposition", `inline; filename="drain-watch-${r.id}.pdf"`).send(pdf);
  });

  app.post<{ Params: { id: string } }>("/api/drain/:id/forward", guard(app, "authority"), async (req, reply) => {
    const r = await store.getRecord<HelpRequest>("request", req.params.id);
    if (!r?.drain) return reply.code(404).send({ error: "not found" });
    const to = r.drain.forwarded.to ?? await recipients(r.area);
    if (!to) return reply.code(409).send({ error: "no authority email: set DRAIN_AUTHORITY_EMAIL, or give an authority account a real email address" });
    if (!smtpConfigured()) return reply.code(503).send({ error: "SMTP is not configured" });
    if (!r.drain.forwarded.to) await store.putRecord("request", { ...r, drain: { ...r.drain, forwarded: { ...r.drain.forwarded, to } } });
    await forward(r.id);
    return store.getRecord("request", r.id);
  });
}

/** One page: what, where, when, photos, AI suggestion (labelled), confirmations. */
export async function drainPdf(r: HelpRequest, uploadsDir: string, appUrl: string): Promise<Buffer> {
  const d = r.drain!;
  const imgs: Buffer[] = [];
  for (const f of d.photos.filter((f) => !f.endsWith(".webp")).slice(0, 3)) {
    try { imgs.push(await readFile(join(uploadsDir, "drain", r.id, f))); } catch { /* missing file: skip */ }
  }
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 42, info: { Title: pdfText(`Drain Watch report ${r.id}`), Author: "Maun" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const P = (t: string, o: Record<string, unknown> = {}) => doc.font("Helvetica").fontSize(10).fillColor("black").text(pdfText(t), o);
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#0b3d2e").text("Drain Watch report");
    doc.font("Helvetica").fontSize(10).fillColor("#555").text(pdfText(`Citizen report via the Maun platform · ${new Date(r.createdAt).toUTCString()} · ${r.id}`));
    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fontSize(13).fillColor("black").text(pdfText(`${LABEL[d.category]} · severity ${r.severity}/4`));
    doc.moveDown(0.3);
    P(`Location: ${r.lat?.toFixed(6)}, ${r.lng?.toFixed(6)}${r.accuracyM ? ` (GPS accuracy about ${r.accuracyM} m)` : ""}`);
    P(`Map: https://maps.google.com/?q=${r.lat},${r.lng}`, { link: `https://maps.google.com/?q=${r.lat},${r.lng}`, underline: true });
    P(`Ward / area: ${r.area ?? "not given"}`);
    P(`Category chosen by: ${d.categorySource === "citizen" ? "the citizen" : "AI suggestion (not verified)"}`);
    if (d.confirmations.length) P(`Confirmed by ${d.confirmations.length} more report(s) within ${DUPLICATE_RADIUS_M} m.`);
    doc.moveDown(0.4);
    P(`Description: ${r.description}`);
    if (d.vision) P(`AI suggestion (${d.vision.provider}, confidence ${Math.round(d.vision.confidence * 100)}%): ${LABEL[d.vision.category]}. ${d.vision.description}`, { oblique: true });
    doc.moveDown(0.6);
    const w = (doc.page.width - 84 - 16) / 3;
    const y = doc.y;
    imgs.forEach((img, i) => {
      try { doc.image(img, 42 + i * (w + 8), y, { fit: [w, 220] }); } catch { /* unreadable image: skip */ }
    });
    doc.y = y + (imgs.length ? 230 : 0);
    doc.font("Helvetica").fontSize(8).fillColor("#666").text(pdfText(
      `Unverified citizen report. Photo metadata (including device GPS) was removed before storage; the location is the one the reporter's device shared. ` +
      `Open in Maun: ${appUrl}/app/requests?open=${r.id}`), 42, doc.page.height - 80, { width: doc.page.width - 84 });
    doc.end();
  });
}
