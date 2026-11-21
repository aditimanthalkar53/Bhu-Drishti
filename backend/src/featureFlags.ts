import type { FastifyInstance } from "fastify";

/**
 * FEATURE_MODE: "full" (default) serves every feature: the satellite product (AEQE questions, change detection, twins,
 * monitors, API keys, webhooks…) together with the Maun disaster-coordination features. "disaster" is an optional
 * slimmed edition: the routes below answer 404 there, and the code stays in place.
 */
export type FeatureMode = "disaster" | "full";

export const featureMode = (env: NodeJS.ProcessEnv = process.env): FeatureMode => (env.FEATURE_MODE === "disaster" ? "disaster" : "full");

/** [method or "*", path pattern] hidden in disaster mode. */
const HIDDEN: [string, RegExp][] = [
  ["*", /^\/api\/keys(\/|$)/],                      // API keys
  ["*", /^\/api\/webhooks(\/|$)/],                  // n8n / webhooks
  ["*", /^\/api\/usage$/],
  ["*", /^\/api\/settings\/integrations$/],
  // our own satellite-analysis workflows (flooded/burned cropland, new built-up, kilns): asking new questions and
  // starting new change detections. Existing results, traces, replay and exhaustive endpoints stay reachable.
  ["POST", /^\/api\/compile$/],
  ["POST", /^\/api\/projects\/[^/]+\/queries$/],
  ["POST", /^\/api\/detections$/],
];

export function isHidden(mode: FeatureMode, method: string, url: string): boolean {
  if (mode === "full") return false;
  const path = url.split("?")[0];
  return HIDDEN.some(([m, re]) => (m === "*" || m === method) && re.test(path));
}

export function registerFeatureFlags(app: FastifyInstance, mode: FeatureMode) {
  app.addHook("onRequest", async (req, reply) => {
    if (isHidden(mode, req.method, req.url)) return reply.code(404).send({ error: "not available in this edition", featureMode: mode });
  });
}
