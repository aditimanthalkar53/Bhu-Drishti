import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify from "fastify";
import { authRoutes, registerAuth } from "./auth.js";
import type { Config } from "./config.js";
import { EngineClient } from "./engine-client.js";
import { appRoutes } from "./routes.js";
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";
import type { Store } from "./store/types.js";

export async function buildApp(config: Config, opts: { store?: Store; logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? true });
  const store = opts.store ?? (config.databaseUrl ? new PostgresStore(config.databaseUrl) : new MemoryStore());
  await store.init();

  await app.register(cors, { origin: config.corsOrigin, credentials: true });
  await app.register(jwt, { secret: config.jwtSecret });
  registerAuth(app, store);
  authRoutes(app, store, { allowGuest: config.allowGuest });
  appRoutes(app, store, new EngineClient(config.engineUrl));

  app.log.info(`store=${store.constructor.name} engine=${config.engineUrl}`);
  return app;
}
