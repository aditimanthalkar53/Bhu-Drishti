import type { FastifyInstance } from "fastify";
import { REQUEST_TYPES, type RequestType } from "./disaster.js";
import { chatJson, llmConfig, notReady, type LlmConfig } from "./llm.js";
import { RateLimiter } from "./ratelimit.js";
import { guard } from "./roles.js";

/**
 * Local-language intake: a citizen describes the situation in their own words (English, Hindi, Kannada or Assamese);
 * a language model turns it into a structured draft that the citizen confirms or edits before anything is sent.
 * Configured by INTAKE_PROVIDER / INTAKE_API_KEY / INTAKE_MODEL. Without a model (or when it fails) the original text
 * is still sent and the citizen picks the type by hand. The original text is always kept next to the English summary.
 */
export const INTAKE_LANGUAGES: Record<string, string> = { en: "English", hi: "Hindi", kn: "Kannada", as: "Assamese" };

export interface IntakeDraft {
  type: RequestType;
  severity: 1 | 2 | 3 | 4;
  people_affected: number | null;
  needs: string[];
  location_hint: string;
  summary_en: string;
  summary_local: string;
  confidence: number;
}

export type IntakeResult = { ok: true; provider: string; draft: IntakeDraft } | { ok: false; provider: string; reason: string };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Strictly validate and normalise a model reply; null when it is unusable. */
export function validateIntake(x: unknown): IntakeDraft | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const type = String(o.type ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (!(REQUEST_TYPES as readonly string[]).includes(type)) return null;
  const sevN = Math.round(Number(o.severity));
  const summary = str(o.summary_en, 600);
  if (!summary) return null;
  const pa = o.people_affected == null ? null : Math.round(Number(o.people_affected));
  const conf = Number(o.confidence);
  return {
    type: type as RequestType,
    severity: (sevN >= 1 && sevN <= 4 ? sevN : 2) as 1 | 2 | 3 | 4,
    people_affected: pa != null && Number.isFinite(pa) && pa >= 0 && pa <= 100000 ? pa : null,
    needs: Array.isArray(o.needs) ? o.needs.map((n) => str(n, 60)).filter(Boolean).slice(0, 10) : [],
    location_hint: str(o.location_hint, 200),
    summary_en: summary,
    summary_local: str(o.summary_local, 600) || summary,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
  };
}

const SYSTEM = `You turn a disaster victim's own words into a structured help request for an emergency coordination team.
Reply with ONE JSON object and nothing else:
{"type": one of ${REQUEST_TYPES.map((t) => `"${t}"`).join(", ")},
 "severity": 1-4 (4 = life in danger now, 3 = urgent, 2 = needs help today, 1 = can wait),
 "people_affected": integer or null if not stated,
 "needs": short English phrases (e.g. "drinking water", "insulin"),
 "location_hint": any place, landmark or address mentioned (in English), "" if none,
 "summary_en": 1-2 sentence English summary, faithful to the text, no invented facts,
 "summary_local": the same summary in the citizen's language,
 "confidence": 0-1, how sure you are about type and severity}
Never invent people, places or needs that are not in the text.`;

export async function runIntake(text: string, language: string, cfg: LlmConfig = llmConfig("INTAKE")): Promise<IntakeResult> {
  const why = notReady(cfg);
  if (why) return { ok: false, provider: cfg.provider, reason: why };
  const lang = INTAKE_LANGUAGES[language] ?? "the same language as the text";
  try {
    const raw = await chatJson(cfg, SYSTEM, `Citizen's language: ${lang}.\nText:\n"""${text.slice(0, 3000)}"""`);
    const draft = validateIntake(raw);
    if (!draft) return { ok: false, provider: cfg.provider, reason: "the model reply did not pass validation" };
    return { ok: true, provider: `${cfg.provider}:${cfg.model}`, draft };
  } catch (e) {
    return { ok: false, provider: cfg.provider, reason: (e as Error).message };
  }
}

const intakeLimiter = new RateLimiter(20, 10 * 60_000);

export function intakeRoutes(app: FastifyInstance) {
  app.get("/api/intake/status", guard(app), async () => {
    const cfg = llmConfig("INTAKE");
    return { provider: cfg.provider, model: cfg.model, ready: notReady(cfg) === null, reason: notReady(cfg), languages: INTAKE_LANGUAGES };
  });

  app.post<{ Body: { text: string; language?: string } }>("/api/intake", {
    ...guard(app),
    schema: { body: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 3, maxLength: 4000 }, language: { type: "string", maxLength: 10 } } } },
  }, async (req, reply) => {
    if (!intakeLimiter.check(`intake:${req.userId}`)) return reply.code(429).send({ error: "too many drafts — wait a few minutes, or send the text as it is" });
    return runIntake(req.body.text, req.body.language ?? "en");
  });
}
