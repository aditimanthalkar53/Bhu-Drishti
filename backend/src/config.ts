export interface Config {
  port: number;
  host: string;
  engineUrl: string;
  jwtSecret: string;
  databaseUrl?: string;
  corsOrigin: string[];
  allowGuest: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = env.JWT_SECRET ?? "dev-only-change-me";
  if (env.NODE_ENV === "production" && jwtSecret === "dev-only-change-me") {
    throw new Error("JWT_SECRET must be set in production");
  }
  return {
    port: Number(env.PORT ?? 4000),
    host: env.HOST ?? "0.0.0.0",
    engineUrl: (env.ENGINE_URL ?? "http://localhost:8000").replace(/\/$/, ""),
    jwtSecret,
    databaseUrl: env.DATABASE_URL || undefined,
    corsOrigin: (env.CORS_ORIGIN ?? "http://localhost:5173").split(",").map((s) => s.trim()),
    allowGuest: (env.ALLOW_GUEST ?? "true") === "true",
  };
}
