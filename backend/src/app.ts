import { constants as zlibConstants } from "node:zlib";
import compress from "@fastify/compress";
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
import { SqliteStore } from "./store/sqlite.js";
import { setAutoEmail } from "./delivery.js";
import type { Store } from "./store/types.js";
import { webRoutes } from "./web.js";

export async function buildApp(config: Config, opts: { store?: Store; logger?: boolean } = {}) {
  const app = Fastify({
    trustProxy: config.trustProxy as boolean,   // a hop count is supported at runtime; the type overloads omit it
    bodyLimit: 5 * 1024 * 1024,   // GeoJSON / KML area uploads
    logger: opts.logger === false ? false : { redact: ["req.headers.authorization", "req.headers[\"x-api-key\"]", "req.query.token"] },
  });
  const store = opts.store ?? (config.databaseUrl ? new PostgresStore(config.databaseUrl)
    : config.sqlitePath === "memory" ? new MemoryStore() : new SqliteStore(config.sqlitePath));
  await store.init();
  if (store instanceof SqliteStore) app.addHook("onClose", async () => store.close());

  // API responses (map GeoJSON can be several MB) go out compressed. Brotli at a low quality keeps the CPU cost
  // small on shared hardware. Live progress streams are hijacked raw responses, so they are never buffered here.
  await app.register(compress, { threshold: 1024, encodings: ["br", "gzip"], brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } } });
  await app.register(cors, { origin: config.corsOrigin, credentials: true, methods: ["GET", "POST", "PATCH", "DELETE"] });
  await app.register(jwt, { secret: config.jwtSecret });
  registerAuth(app, store, { allowGuest: config.allowGuest });
  authRoutes(app, store, { allowGuest: config.allowGuest, appUrl: config.appUrl });
  const engine = new EngineClient(config.engineUrl);
  appRoutes(app, store, engine, { maxConcurrentRuns: config.maxConcurrentRuns });
  const scheduler = new MonitorScheduler(store, engine, app.log, { publicUrl: config.publicUrl });
  featureRoutes(app, store, engine, scheduler, { publicUrl: config.publicUrl, allowPrivateWebhooks: config.allowPrivateWebhooks });
  setAutoEmail(config.reportAutoEmail);
  if (config.scheduler) {
    scheduler.start();
    app.addHook("onClose", async () => scheduler.stop());
  }
  app.decorate("scheduler", scheduler);
  if (config.staticDir) await webRoutes(app, config.staticDir, config.frameAncestors);

  app.log.info(`store=${store.constructor.name} engine=${config.engineUrl} scheduler=${config.scheduler} ` +
    `guest=${config.allowGuest} autoEmail=${config.reportAutoEmail.length} address(es)`);
  return app;
}
