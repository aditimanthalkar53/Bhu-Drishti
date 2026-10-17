export interface Config {
  port: number;
  host: string;
  engineUrl: string;
  jwtSecret: string;
  databaseUrl?: string;
  corsOrigin: string[];
  allowGuest: boolean;
  /** Base URL other services (n8n) use to reach this API; goes into webhook payloads. */
  publicUrl: string;
  allowPrivateWebhooks: boolean;
  scheduler: boolean;
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
    corsOrigin: (env.CORS_ORIGIN ?? "http://localhost:5173").split(",").map((s) => s.trim()),
    allowGuest: (env.ALLOW_GUEST ?? "true") === "true",
    publicUrl: (env.PUBLIC_API_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    allowPrivateWebhooks: (env.ALLOW_PRIVATE_WEBHOOKS ?? "false") === "true",
    scheduler: (env.MONITOR_SCHEDULER ?? "true") === "true",
  };
}
