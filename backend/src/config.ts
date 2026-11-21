import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { featureMode, type FeatureMode } from "./featureFlags.js";

export interface Config {
  port: number;
  host: string;
  engineUrl: string;
  jwtSecret: string;
  databaseUrl?: string;
  /** SQLite file holding users (login), projects, sessions and records; used unless DATABASE_URL is set. */
  sqlitePath: string;
  corsOrigin: string[];
  allowGuest: boolean;
  /** Every generated report is also emailed here automatically (comma-separated list allowed). */
  reportAutoEmail: string[];
  /** Base URL other services (n8n) use to reach this API; goes into webhook payloads. */
  publicUrl: string;
  allowPrivateWebhooks: boolean;
  scheduler: boolean;
  /** false, or the number of reverse proxies in front of the API (e.g. 1 behind a hosting platform's proxy). */
  trustProxy: boolean | number;
  /** Live satellite runs a single user may have in flight at once. */
  maxConcurrentRuns: number;
  /** built website to serve from the API (single-container deploy); unset = API only */
  staticDir: string | null;
  /** extra sites allowed to embed the app in a frame (e.g. https://huggingface.co) */
  frameAncestors: string[];
  /** Public address of the website, used in password-reset links. */
  appUrl: string;
  /** "full" (default): every feature, satellite and coordination; "disaster": the slimmed coordination edition. */
  featureMode: FeatureMode;
  /** Accounts that are authorities. Authority is never self-assigned. */
  authorityEmails: string[];
  /** Drain Watch photos live here, served only to signed-in users. */
  uploadsDir: string;
  /** Default ward authority for Drain Watch reports, and optional "ward:email" overrides. */
  drainAuthorityEmail: string | null;
  drainWardEmails: Record<string, string>;
}

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const emailList = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(isEmail);

function uploadsDir(env: NodeJS.ProcessEnv, sqlitePath: string): string {
  if (env.UPLOADS_DIR) return env.UPLOADS_DIR;
  if (env.DATA_DIR) return join(env.DATA_DIR, "uploads");
  if (sqlitePath === ":memory:" || sqlitePath === "memory") return join(tmpdir(), "maun-uploads");
  return join(dirname(sqlitePath), "uploads");
}

/** "ward 4:a@x.org, Ward 7:b@y.org" → { "ward 4": "a@x.org", "ward 7": "b@y.org" } (keys lower-cased). */
export function parseWardEmails(v: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (v ?? "").split(",")) {
    const i = part.lastIndexOf(":");
    if (i <= 0) continue;
    const ward = part.slice(0, i).trim().toLowerCase(), email = part.slice(i + 1).trim().toLowerCase();
    if (ward && isEmail(email)) out[ward] = email;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = env.JWT_SECRET || "dev-only-change-me";
  if (env.NODE_ENV === "production" && (jwtSecret === "dev-only-change-me" || jwtSecret === "change-me-in-production" || jwtSecret.length < 32)) {
    throw new Error("JWT_SECRET must be set to a random secret of at least 32 characters in production (openssl rand -base64 48)");
  }
  const port = Number(env.PORT ?? 4000);
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    // Render's private-network service reference only yields "host:port", hence the second form
    engineUrl: (env.ENGINE_URL ?? (env.ENGINE_HOSTPORT ? `http://${env.ENGINE_HOSTPORT}` : "http://localhost:8000")).replace(/\/$/, ""),
    jwtSecret,
    databaseUrl: env.DATABASE_URL || undefined,
    sqlitePath: env.SQLITE_PATH || "./data/bhu-drishti.sqlite",
    corsOrigin: (env.CORS_ORIGIN ?? "http://localhost:5173").split(",").map((s) => s.trim()),
    // the application needs a real account; guest sessions exist only for automated tests
    allowGuest: (env.ALLOW_GUEST ?? "false") === "true",
    reportAutoEmail: (env.REPORT_AUTO_EMAIL ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)),
    publicUrl: (env.PUBLIC_API_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    allowPrivateWebhooks: (env.ALLOW_PRIVATE_WEBHOOKS ?? "false") === "true",
    scheduler: (env.MONITOR_SCHEDULER ?? "true") === "true",
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    maxConcurrentRuns: Math.max(1, Number(env.MAX_CONCURRENT_RUNS ?? 2)),
    staticDir: env.STATIC_DIR || null,
    frameAncestors: (env.FRAME_ANCESTORS ?? "").split(/[\s,]+/).filter(Boolean),
    appUrl: (env.PUBLIC_APP_URL ?? "http://localhost:8081").replace(/\/$/, ""),
    featureMode: featureMode(env),
    authorityEmails: emailList(env.AUTHORITY_EMAILS),
    uploadsDir: uploadsDir(env, env.SQLITE_PATH || "./data/bhu-drishti.sqlite"),
    drainAuthorityEmail: emailList(env.DRAIN_AUTHORITY_EMAIL)[0] ?? null,
    drainWardEmails: parseWardEmails(env.DRAIN_WARD_EMAILS),
  };
}

/** A hop count, never a blanket "trust everything": that would let clients forge X-Forwarded-For and dodge rate limits. */
function parseTrustProxy(v: string | undefined): boolean | number {
  if (!v || v === "false" || v === "0") return false;
  if (v === "true") return 1;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : false;
}
