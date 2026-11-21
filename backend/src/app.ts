import { constants as zlibConstants } from "node:zlib";
import compress from "@fastify/compress";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify from "fastify";
import { authRoutes, registerAuth } from "./auth.js";
import type { Config } from "./config.js";
import { EngineClient } from "./engine-client.js";
import { detectionRoutes } from "./detections.js";
import { featureRoutes } from "./features.js";
import { MonitorScheduler } from "./monitors.js";
import { appRoutes } from "./routes.js";
import { twinRoutes } from "./twins.js";
import { SachetService, sachetRoutes } from "./sachet.js";
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";
import { SqliteStore } from "./store/sqlite.js";
import { setAutoEmail } from "./delivery.js";
import type { Store } from "./store/types.js";
import { webRoutes } from "./web.js";
import { coordRoutes } from "./coord.js";
import { drainRoutes } from "./drain.js";
import { registerFeatureFlags } from "./featureFlags.js";
import { hazardRoutes } from "./hazard/index.js";
import { intakeRoutes } from "./intake.js";
import { maunRoutes } from "./maun.js";
import { profileRoutes, Roles } from "./roles.js";

export async function buildApp(config: Config, opts: { store?: Store; logger?: boolean; sachet?: SachetService } = {}) {
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
  // FEATURE_MODE=disaster (default) answers 404 on the features hidden in this edition; "full" restores them
  registerFeatureFlags(app, config.featureMode);
  app.decorate("roles", new Roles(store, config.authorityEmails));
  registerAuth(app, store, { allowGuest: config.allowGuest });
  authRoutes(app, store, { allowGuest: config.allowGuest, appUrl: config.appUrl });
  profileRoutes(app, store);
  const engine = new EngineClient(config.engineUrl);
  // disaster coordination: requests, offers, official updates, tasks, local-language intake, Drain Watch, hazard, Maun
  coordRoutes(app, store, engine, { appUrl: config.appUrl });
  intakeRoutes(app);
  drainRoutes(app, store, { uploadsDir: config.uploadsDir, appUrl: config.appUrl, authorityEmail: config.drainAuthorityEmail, wardEmails: config.drainWardEmails });
  hazardRoutes(app, store, engine);
  maunRoutes(app, store, engine);
  app.get("/api/edition", async () => ({ featureMode: config.featureMode }));
  appRoutes(app, store, engine, { maxConcurrentRuns: config.maxConcurrentRuns });
  detectionRoutes(app, store, engine, { maxConcurrentRuns: config.maxConcurrentRuns });
  twinRoutes(app, store, engine);
  sachetRoutes(app, store, opts.sachet);
  const scheduler = new MonitorScheduler(store, engine, app.log, { publicUrl: config.publicUrl, secret: config.jwtSecret, appUrl: config.appUrl });
  featureRoutes(app, store, engine, scheduler, { publicUrl: config.publicUrl, appUrl: config.appUrl, secret: config.jwtSecret, allowPrivateWebhooks: config.allowPrivateWebhooks,
    featureMode: config.featureMode });
  setAutoEmail(config.reportAutoEmail);
  if (config.scheduler) {
    scheduler.start();
    app.addHook("onClose", async () => scheduler.stop());
  }
  app.decorate("scheduler", scheduler);
  if (config.staticDir) await webRoutes(app, config.staticDir, config.frameAncestors);

  app.log.info(`store=${store.constructor.name} engine=${config.engineUrl} scheduler=${config.scheduler} ` +
    `guest=${config.allowGuest} autoEmail=${config.reportAutoEmail.length} address(es) mode=${config.featureMode} authorities=${config.authorityEmails.length}`);
  return app;
}
