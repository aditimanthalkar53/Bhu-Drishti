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
  /** Behind nginx: take the client IP from X-Forwarded-For (only safe when the API port is not public). */
  /** false, or the number of reverse proxies in front of the API (1 = the web container, 2 = plus a TLS proxy). */
  trustProxy: boolean | number;
  /** Live satellite runs a single user may have in flight at once. */
  maxConcurrentRuns: number;
  /** Public address of the website, used in password-reset links. */
  appUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = env.JWT_SECRET ?? "dev-only-change-me";
  if (env.NODE_ENV === "production" && (jwtSecret === "dev-only-change-me" || jwtSecret === "change-me-in-production")) {
    throw new Error("JWT_SECRET must be set to a real secret in production");
  }
  const port = Number(env.PORT ?? 4000);
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    engineUrl: (env.ENGINE_URL ?? "http://localhost:8000").replace(/\/$/, ""),
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
    appUrl: (env.PUBLIC_APP_URL ?? "http://localhost:8081").replace(/\/$/, ""),
  };
}

/** A hop count, never a blanket "trust everything": that would let clients forge X-Forwarded-For and dodge rate limits. */
function parseTrustProxy(v: string | undefined): boolean | number {
  if (!v || v === "false" || v === "0") return false;
  if (v === "true") return 1;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : false;
}
