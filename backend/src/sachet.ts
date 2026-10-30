import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sendMail, smtpConfigured } from "./email.js";
import type { Store } from "./store/types.js";

/**
 * SACHET (NDMA's CAP-based National Disaster Alert Portal) adapter.
 *
 * No SACHET API is documented publicly. SACHET advertises RSS/CAP subscription, so this adapter reads one
 * operator-configured feed URL (SACHET_FEED_URL) that serves RSS or CAP 1.2 XML. Nothing is hardcoded, scraped or
 * invented: with no URL configured the feature reports "not_configured" and shows no alerts.
 *
 * RSS items carry little beyond a headline, so each item's own CAP file is read for severity, area, validity and
 * instructions. Only links on the feed's own host are followed; a file that can't be read leaves the RSS fields as they are.
 */

export const SACHET_PORTAL_URL = "https://sachet.ndma.gov.in/";

export interface SachetAlert {
  /** stable id derived from the source identifier, so re-fetching never duplicates an alert */
  id: string;
  sourceId: string;
  title: string;
  event: string;
  category: string;
  severity: string | null;
  urgency: string | null;
  certainty: string | null;
  areaDesc: string | null;
  sender: string | null;
  issuedAt: string | null;
  effective: string | null;
  expires: string | null;
  description: string | null;
  instruction: string | null;
  link: string | null;
  /** CAP msgType: Alert, Update or Cancel */
  msgType: string | null;
  /** true once the fields come from a CAP document rather than only an RSS item */
  detailed: boolean;
}

export type SachetState = "not_configured" | "live" | "unavailable";
export interface SachetResult {
  state: SachetState;
  /** "live" only when the alerts were fetched from the configured official feed just now or within the cache window */
  alerts: SachetAlert[];
  fetchedAt: string | null;
  error: string | null;
  portalUrl: string;
  feedHost: string | null;
}

// ---------------------------------------------------------------- parsing
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
      if (e[0] === "#") {
        const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
      }
      return ENT[e.toLowerCase()] ?? "";
    });
}
/** Description fields in RSS often hold escaped HTML; keep readable text only. */
const plain = (s: string) => decode(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "i").exec(xml);
  const v = m ? plain(m[1]) : "";
  return v || null;
}
const blocks = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?(?<!/)>[\\s\\S]*?</(?:\\w+:)?${name}>`, "gi"))].map((m) => m[0]);
const hasElement = (xml: string, name: string) => new RegExp(`<(?:\\w+:)?${name}[\\s>]`, "i").test(xml);

function isoDate(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
const safeUrl = (s: string | null) => (s && /^https?:\/\//i.test(s) ? s : null);
const clip = (s: string | null, n: number) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s);
const mkId = (sourceId: string) => createHash("sha256").update(sourceId).digest("hex").slice(0, 24);

/** A CAP status other than Actual (Test, Exercise, System, Draft) must never be shown as a real warning. */
const notActual = (xml: string) => {
  const status = tag(xml, "status");
  return status !== null && status.toLowerCase() !== "actual";
};

/** CAP 1.2 <alert> documents (one or many). Takes the English <info> if present, else the first. */
function parseCap(xml: string): SachetAlert[] {
  const out: SachetAlert[] = [];
  for (const a of blocks(xml, "alert")) {
    if (notActual(a)) continue;
    const infos = blocks(a, "info");
    const info = infos.find((i) => /^en/i.test(tag(i, "language") ?? "")) ?? infos[0];
    if (!info) continue;
    const identifier = tag(a, "identifier");
    const sent = isoDate(tag(a, "sent"));
    const event = tag(info, "event") ?? "Alert";
    const sourceId = identifier ?? `${event}|${sent}|${tag(info, "areaDesc")}`;
    out.push({
      id: mkId(sourceId), sourceId, title: clip(tag(info, "headline") ?? event, 200)!, event,
      category: tag(info, "category") ?? "Other",
      severity: tag(info, "severity"), urgency: tag(info, "urgency"), certainty: tag(info, "certainty"),
      areaDesc: clip(blocks(info, "area").map((x) => tag(x, "areaDesc")).filter(Boolean).join("; ") || null, 600),
      sender: tag(info, "senderName") ?? tag(a, "sender"),
      issuedAt: sent, effective: isoDate(tag(info, "effective")) ?? sent, expires: isoDate(tag(info, "expires")),
      description: clip(tag(info, "description"), 3000), instruction: clip(tag(info, "instruction"), 3000),
      link: safeUrl(tag(info, "web")), msgType: tag(a, "msgType"), detailed: true,
    });
  }
  return out;
}

/** RSS items. Only the fields the feed actually provides are filled; the rest stay null (never guessed). */
function parseRss(xml: string): SachetAlert[] {
  return blocks(xml, "item").map((it) => {
    const title = clip(tag(it, "title") ?? "Alert", 200)!;
    const link = safeUrl(tag(it, "link"));
    const sourceId = tag(it, "guid") ?? link ?? title;
    const when = isoDate(tag(it, "pubDate"));
    return {
      id: mkId(sourceId), sourceId, title, event: title, category: tag(it, "category") ?? "Other",
      severity: null, urgency: null, certainty: null, areaDesc: null, sender: tag(it, "author"),
      issuedAt: when, effective: when, expires: null, description: clip(tag(it, "description"), 3000), instruction: null, link, msgType: null, detailed: false,
    };
  });
}

/** Exported for tests. Returns [] for anything that is not RSS or CAP. De-duplicates by source identifier. */
export function parseFeed(xml: string): SachetAlert[] {
  const list = hasElement(xml, "alert") && hasElement(xml, "info") ? parseCap(xml) : hasElement(xml, "item") ? parseRss(xml) : [];
  const seen = new Map<string, SachetAlert>();
  for (const a of list) if (!seen.has(a.id)) seen.set(a.id, a);
  return [...seen.values()].sort((x, y) => (y.issuedAt ?? "").localeCompare(x.issuedAt ?? ""));
}

// ---------------------------------------------------------------- fetching
export interface SachetOptions {
  feedUrl?: string;
  timeoutMs?: number;
  cacheMs?: number;
  fetchImpl?: typeof fetch;
  /** CAP files read per refresh; 0 = RSS fields only */
  capMax?: number;
  /** total time one refresh may spend on CAP files; whatever is left is picked up by the next refresh */
  capBudgetMs?: number;
}

const MAX_BYTES = 8 * 1024 * 1024;
const CAP_CONCURRENCY = 4;

/** The alert as its CAP file describes it, keeping the RSS item's identity and anything the file leaves out. */
const merge = (rss: SachetAlert, cap: SachetAlert): SachetAlert => ({
  ...cap, id: rss.id, sourceId: rss.sourceId, sender: cap.sender ?? rss.sender, link: cap.link ?? rss.link,
  issuedAt: cap.issuedAt ?? rss.issuedAt, effective: cap.effective ?? rss.effective, description: cap.description ?? rss.description,
});

export class SachetService {
  private cache: SachetResult | null = null;
  private cachedAt = 0;
  private inflight: Promise<SachetResult> | null = null;
  /** finished CAP lookups by alert id: the merged alert, or null for one that is not an Actual alert. Failures are not kept, so they retry. */
  private capCache = new Map<string, SachetAlert | null>();

  constructor(private o: SachetOptions = {}) {}

  private get capMax() { return this.o.capMax ?? Math.max(0, Number(process.env.SACHET_CAP_MAX ?? 100)); }
  private get capBudgetMs() { return this.o.capBudgetMs ?? 20_000; }

  private async fetchText(url: string, timeoutMs: number): Promise<string> {
    const res = await (this.o.fetchImpl ?? fetch)(url, {
      signal: AbortSignal.timeout(timeoutMs), redirect: "follow",
      headers: { accept: "application/rss+xml, application/xml, text/xml", "user-agent": "Bhu-Drishti/0.2 (+SACHET feed reader)" },
    });
    if (!res.ok) throw new Error(`the feed answered HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("the feed response is too large");
    return text;
  }

  /** Fills RSS alerts in from their CAP files, a few at a time. Any failure leaves that alert on its RSS fields. */
  private async enrich(alerts: SachetAlert[]): Promise<SachetAlert[]> {
    if (this.capMax <= 0) return alerts;
    const feedHost = new URL(this.feedUrl).host;
    const onFeedHost = (link: string | null) => { try { return !!link && new URL(link).host === feedHost; } catch { return false; } };
    const todo = alerts.filter((a) => !a.detailed && !this.capCache.has(a.id) && onFeedHost(a.link)).slice(0, this.capMax);
    const deadline = Date.now() + this.capBudgetMs;
    let next = 0;
    const worker = async () => {
      while (next < todo.length && Date.now() < deadline) {
        const a = todo[next++];
        try {
          const xml = await this.fetchText(a.link!, Math.min(this.timeoutMs, Math.max(1, deadline - Date.now())));
          const [cap] = parseCap(xml);
          if (cap) this.capCache.set(a.id, merge(a, cap));
          else if (hasElement(xml, "alert") && notActual(xml)) this.capCache.set(a.id, null);
        } catch { /* keeps the RSS fields; the next refresh tries again */ }
      }
    };
    await Promise.all(Array.from({ length: CAP_CONCURRENCY }, worker));
    const current = new Set(alerts.map((a) => a.id));
    for (const id of this.capCache.keys()) if (!current.has(id)) this.capCache.delete(id);
    return alerts.flatMap((a) => {
      const known = this.capCache.get(a.id);
      return known === null ? [] : [known ?? a];
    });
  }

  private get feedUrl() {
    const u = (this.o.feedUrl ?? process.env.SACHET_FEED_URL ?? "").trim();
    return /^https?:\/\//i.test(u) ? u : "";
  }
  private get cacheMs() { return this.o.cacheMs ?? Math.max(0, Number(process.env.SACHET_CACHE_SECONDS ?? 300)) * 1000; }
  private get timeoutMs() { return this.o.timeoutMs ?? Math.max(1000, Number(process.env.SACHET_TIMEOUT_MS ?? 10000)); }

  private base(state: SachetState, extra: Partial<SachetResult> = {}): SachetResult {
    let host: string | null = null;
    try { host = this.feedUrl ? new URL(this.feedUrl).host : null; } catch { /* invalid URL: reported as not configured */ }
    return { state, alerts: [], fetchedAt: null, error: null, portalUrl: SACHET_PORTAL_URL, feedHost: host, ...extra };
  }

  async get(force = false): Promise<SachetResult> {
    if (!this.feedUrl) return this.base("not_configured");
    if (!force && this.cache && Date.now() - this.cachedAt < this.cacheMs) return this.cache;
    this.inflight ??= this.load().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async find(id: string): Promise<SachetAlert | undefined> {
    return (await this.get()).alerts.find((a) => a.id === id);
  }

  private async load(): Promise<SachetResult> {
    try {
      const text = await this.fetchText(this.feedUrl, this.timeoutMs);
      const alerts = parseFeed(text);
      if (alerts.length === 0 && !hasElement(text, "rss") && !hasElement(text, "feed") && !hasElement(text, "alert")) throw new Error("the feed did not return valid RSS or CAP XML");
      this.cache = this.base("live", { alerts: await this.enrich(alerts), fetchedAt: new Date().toISOString() });
      this.cachedAt = Date.now();
      return this.cache;
    } catch (e) {
      const err = (e as Error).name === "TimeoutError" ? "the feed did not respond in time" : (e as Error).message;
      // an earlier good fetch is still shown, but flagged as stale rather than passed off as current
      if (this.cache) return { ...this.cache, state: "unavailable", error: `Could not refresh: ${err}. Showing the last successful fetch.` };
      return this.base("unavailable", { error: `SACHET feed unavailable: ${err}` });
    }
  }
}

// ---------------------------------------------------------------- routes
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function sachetRoutes(app: FastifyInstance, store: Store, service = new SachetService()) {
  const auth = { preHandler: app.authenticate };

  app.get<{ Querystring: { refresh?: string } }>("/api/sachet/alerts", auth, async (req) => service.get(req.query.refresh === "1"));

  /** Sends the signed-in user a copy of one alert at their own address, through the existing SMTP setup. */
  app.post<{ Params: { id: string } }>("/api/sachet/alerts/:id/email", auth, async (req, reply) => {
    if (!smtpConfigured()) return reply.code(503).send({ error: "Email is not configured (SMTP_USER / SMTP_PASS)." });
    const a = await service.find(req.params.id);
    if (!a) return reply.code(404).send({ error: "alert not found; it may have been withdrawn from the feed" });
    const user = await store.userById(req.userId!);
    if (!user?.email) return reply.code(400).send({ error: "your account has no email address" });
    const lines = [a.event, a.areaDesc && `Area: ${a.areaDesc}`, a.severity && `Severity: ${a.severity}`, a.issuedAt && `Issued: ${a.issuedAt}`,
      a.expires && `Valid until: ${a.expires}`, a.description, a.instruction && `Instructions: ${a.instruction}`,
      `Official source: ${a.link ?? SACHET_PORTAL_URL}`].filter(Boolean) as string[];
    const note = "This is a copy, sent at your request by Bhu-Drishti, of an alert published through NDMA's SACHET feed. Bhu-Drishti is not an official alerting authority and does not issue warnings; always follow the official source.";
    try {
      await sendMail({
        to: user.email, subject: `SACHET alert (copy) — ${a.title}`, text: `${lines.join("\n")}\n\n${note}`,
        html: `<p>${lines.map(esc).join("<br>")}</p><p style="color:#666;font-size:12px">${esc(note)}</p>`,
      });
    } catch (e) {
      return reply.code(502).send({ error: `Email could not be sent: ${(e as Error).message}` });
    }
    return { ok: true, to: user.email };
  });
}
