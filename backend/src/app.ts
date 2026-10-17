import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify from "fastify";
import { authRoutes, registerAuth } from "./auth.js";
import type { Config } from "./config.js";
import { EngineClient } from "./engine-client.js";
import { featureRoutes } from "./features.js";
import { MonitorScheduler } from "./monitors.js";
import { appRoutes } from "./routes.js";
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";
import type { Store } from "./store/types.js";

export async function buildApp(config: Config, opts: { store?: Store; logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { redact: ["req.headers.authorization", "req.headers[\"x-api-key\"]", "req.query.token"] },
  });
  const store = opts.store ?? (config.databaseUrl ? new PostgresStore(config.databaseUrl) : new MemoryStore());
  await store.init();

  await app.register(cors, { origin: config.corsOrigin, credentials: true, methods: ["GET", "POST", "PATCH", "DELETE"] });
  await app.register(jwt, { secret: config.jwtSecret });
  registerAuth(app, store);
  authRoutes(app, store, { allowGuest: config.allowGuest });
  const engine = new EngineClient(config.engineUrl);
  appRoutes(app, store, engine);
  const scheduler = new MonitorScheduler(store, engine, app.log, { publicUrl: config.publicUrl });
  featureRoutes(app, store, engine, scheduler, { publicUrl: config.publicUrl, allowPrivateWebhooks: config.allowPrivateWebhooks });
  if (config.scheduler) {
    scheduler.start();
    app.addHook("onClose", async () => scheduler.stop());
  }
  app.decorate("scheduler", scheduler);

  app.log.info(`store=${store.constructor.name} engine=${config.engineUrl} scheduler=${config.scheduler}`);
  return app;
}
