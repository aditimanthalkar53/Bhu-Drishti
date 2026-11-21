import type { FastifyInstance } from "fastify";
import { REQUEST_TYPES, type RequestType } from "./disaster.js";
import { EngineError, type EngineClient } from "./engine-client.js";
import { chatJson, llmConfig, notReady, type LlmConfig } from "./llm.js";
import { RateLimiter } from "./ratelimit.js";
import { guard } from "./roles.js";

/**
 * Local-language intake: a citizen describes the situation in their own words, in any language; nobody has to say
 * which one. A language model detects the language and turns the text into a structured draft that the citizen
 * confirms or edits before anything is sent. Without a model the language is read from the script the text is written
 * in (detectLanguage). Configured by INTAKE_PROVIDER / INTAKE_API_KEY / INTAKE_MODEL. Without a model (or when it fails)
 * the original text is still sent and the citizen picks the type by hand. The original text is always kept next to the
 * English summary.
 */
export const INTAKE_LANGUAGES: Record<string, string> = { en: "English", hi: "Hindi", kn: "Kannada", as: "Assamese", bn: "Bengali" };

/**
 * Best guess from the writing system alone, used when no model is available. Devanagari is taken as Hindi and Latin as
 * English (romanised Hindi also lands here; the model, when present, tells them apart). Bengali script is Assamese only
 * when it uses the letters Assamese has and Bengali does not (ৰ, ৱ). "und" when the text has no letters we recognise.
 */
export function detectLanguage(text: string): string {
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const scripts: [string, number][] = [
    ["hi", count(/[ऀ-ॿ]/g)],
    ["kn", count(/[ಀ-೿]/g)],
    [/[ৰৱ]/.test(text) ? "as" : "bn", count(/[ঀ-৿]/g)],
    ["en", count(/[A-Za-z]/g)],
  ];
  const [code, n] = scripts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return n > 0 ? code : "und";
}

export interface IntakeDraft {
  /** language the citizen wrote in, as detected (ISO 639 code, e.g. "hi"); "und" when it could not be told */
  language: string;
  type: RequestType;
  severity: 1 | 2 | 3 | 4;
  people_affected: number | null;
  needs: string[];
  location_hint: string;
  summary_en: string;
  summary_local: string;
  confidence: number;
}

/** `language` is always set: the model's answer when it has one, otherwise the script-based guess. */
export type IntakeResult =
  | { ok: true; provider: string; language: string; draft: IntakeDraft }
  | { ok: false; provider: string; language: string; reason: string };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Strictly validate and normalise a model reply; null when it is unusable. `fallbackLanguage` fills a missing or malformed language. */
export function validateIntake(x: unknown, fallbackLanguage = "und"): IntakeDraft | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const type = String(o.type ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (!(REQUEST_TYPES as readonly string[]).includes(type)) return null;
  const sevN = Math.round(Number(o.severity));
  const summary = str(o.summary_en, 600);
  if (!summary) return null;
  const pa = o.people_affected == null ? null : Math.round(Number(o.people_affected));
  const conf = Number(o.confidence);
  const lang = str(o.language, 10).toLowerCase();
  return {
    language: /^[a-z]{2,3}$/.test(lang) ? lang : fallbackLanguage,
    type: type as RequestType,
    severity: (sevN >= 1 && sevN <= 4 ? sevN : 2) as 1 | 2 | 3 | 4,
    people_affected: pa != null && Number.isFinite(pa) && pa >= 0 && pa <= 100000 ? pa : null,
    needs: Array.isArray(o.needs) ? o.needs.map((n) => str(n, 60)).filter(Boolean).slice(0, 10) : [],
    location_hint: str(o.location_hint, 200),
    summary_en: summary,
    // not asked of the model any more (writing Indic script back is slow on CPU); runIntake fills in the citizen's own words
    summary_local: str(o.summary_local, 600) || summary,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
  };
}

// Kept short on purpose: a local model on CPU reads ~55 tokens/s and cannot reuse this prefix between different
// messages, so every token here is paid on every request (the longer first version cost ~6 s per draft).
const SYSTEM = `Turn a disaster victim's message (any language or script) into JSON for an emergency team. Reply with only:
{"language":ISO 639-1 code of the message (romanised Hindi is "hi"),"type":${REQUEST_TYPES.join("|")},"severity":4 life in danger now|3 urgent|2 today|1 can wait,"people_affected":integer or null,"needs":[short English phrases],"location_hint":place named, in English, or "","summary_en":1-2 faithful English sentences,"confidence":0-1}
People trapped or stranded (on a roof, in water, in a vehicle, under debris) are "rescue", severity 4. Never invent facts.`;

/**
 * `language` is optional and only a hint (e.g. the language a voice recording was made in); the model decides from
 * the text itself. Pass nothing or "auto" to let it detect the language unaided.
 */
export async function runIntake(text: string, language?: string, cfg: LlmConfig = llmConfig("INTAKE")): Promise<IntakeResult> {
  const guess = detectLanguage(text);
  const why = notReady(cfg);
  if (why) return { ok: false, provider: cfg.provider, language: guess, reason: why };
  const hint = language && language !== "auto" && INTAKE_LANGUAGES[language]
    ? `It was dictated with speech recognition set to ${INTAKE_LANGUAGES[language]}, but trust the text itself.\n` : "";
  try {
    const raw = await chatJson(cfg, SYSTEM, `${hint}Text:\n"""${text.slice(0, 3000)}"""`);
    const draft = validateIntake(raw, guess);
    if (draft && !(raw as Record<string, unknown> | null)?.summary_local) draft.summary_local = text.trim().slice(0, 600);
    if (!draft) return { ok: false, provider: cfg.provider, language: guess, reason: "the model reply did not pass validation" };
    return { ok: true, provider: `${cfg.provider}:${cfg.model}`, language: draft.language, draft };
  } catch (e) {
    return { ok: false, provider: cfg.provider, language: guess, reason: (e as Error).message };
  }
}

// the page reads a message in the background whenever typing pauses, so allow more than one draft per message
const intakeLimiter = new RateLimiter(40, 10 * 60_000);
const speechLimiter = new RateLimiter(30, 10 * 60_000);

export interface Transcript { text: string; language: string; language_probability: number; duration_s: number; model: string; seconds: number }

/** A base64 recording (optionally a data: URL) as bytes; null when it is not plausible audio. */
export function audioBytes(s: string): Buffer | null {
  const m = /^data:(audio\/[\w.+-]+)(?:;[\w=.+-]+)*;base64,/.exec(s);
  if (s.startsWith("data:") && !m) return null;
  const b64 = m ? s.slice(m[0].length) : s;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, "base64");
  return buf.length >= 100 ? buf : null;
}

export function intakeRoutes(app: FastifyInstance, engine?: EngineClient) {
  // A local model is slow only the first time: loading it (~15 s) and reading the long system prompt (~5 s). Do both
  // once at startup, in the background, so the first citizen gets the warm path (~7 s on CPU instead of ~25 s).
  app.addHook("onReady", async () => {
    const cfg = llmConfig("INTAKE");
    if (cfg.provider !== "ollama" || process.env.INTAKE_WARMUP === "0") return;
    const t = Date.now();
    void runIntake("Water entered our house, 2 people need drinking water.", undefined, cfg).then((r) =>
      app.log.info(`intake model ${cfg.model} warmed up in ${((Date.now() - t) / 1000).toFixed(1)} s (${r.ok ? "ok" : r.reason})`));
  });

  /**
   * Voice messages: the browser records, our own engine transcribes with Whisper and detects the language.
   * Used instead of the browser's speech recognition, which fails in Edge and does not exist in Brave or Firefox.
   */
  app.post<{ Body: { audio: string; language?: string } }>("/api/speech", {
    ...guard(app), bodyLimit: 12 * 1024 * 1024,
    schema: { body: { type: "object", required: ["audio"], properties: { audio: { type: "string", maxLength: 11_500_000 }, language: { type: "string", pattern: "^[a-z]{2,3}$" } } } },
  }, async (req, reply) => {
    if (!engine) return reply.code(503).send({ error: "voice input is not available on this server" });
    if (!speechLimiter.check(`speech:${req.userId}`)) return reply.code(429).send({ error: "too many voice messages — wait a few minutes, or type instead" });
    const audio = audioBytes(req.body.audio);
    if (!audio) return reply.code(400).send({ error: "the recording could not be read" });
    try {
      const q = req.body.language ? `?language=${req.body.language}` : "";
      // the first message after the engine starts may also load the speech model, so allow a few minutes
      return await engine.json<Transcript>(`/speech/transcribe${q}`, { method: "POST", body: new Uint8Array(audio), headers: { "content-type": "application/octet-stream" } }, 300_000);
    } catch (e) {
      const status = e instanceof EngineError && e.status >= 400 && e.status < 600 ? e.status : 503;
      return reply.code(status === 503 || status === 422 ? status : 502).send({ error: `voice could not be turned into text: ${(e as Error).message}` });
    }
  });

  app.get("/api/intake/status", guard(app), async () => {
    const cfg = llmConfig("INTAKE");
    return { provider: cfg.provider, model: cfg.model, ready: notReady(cfg) === null, reason: notReady(cfg), languages: INTAKE_LANGUAGES };
  });

  app.post<{ Body: { text: string; language?: string } }>("/api/intake", {
    ...guard(app),
    schema: { body: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 3, maxLength: 4000 }, language: { type: "string", maxLength: 10 } } } },
  }, async (req, reply) => {
    if (!intakeLimiter.check(`intake:${req.userId}`)) return reply.code(429).send({ error: "too many drafts — wait a few minutes, or send the text as it is" });
    return runIntake(req.body.text, req.body.language);
  });
}
