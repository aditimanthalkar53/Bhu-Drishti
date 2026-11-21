import { DRAIN_CATEGORIES, type DrainCategory } from "./disaster.js";
import { chatJson, llmConfig, notReady, type Image, type LlmConfig } from "./llm.js";

/**
 * Drain Watch photo analysis with any multimodal model (VISION_PROVIDER / VISION_API_KEY / VISION_MODEL; for Ollama a
 * vision model such as qwen2.5vl or llava). The result is only a suggestion shown as "AI suggestion": the citizen's own
 * category wins, and with no model the citizen chooses the category by hand.
 */
export interface VisionResult { category: DrainCategory; severity: 1 | 2 | 3 | 4; confidence: number; description: string }
export type VisionOutcome = { ok: true; provider: string; result: VisionResult } | { ok: false; provider: string; reason: string };

export function validateVision(x: unknown): VisionResult | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const category = String(o.category ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (!(DRAIN_CATEGORIES as readonly string[]).includes(category)) return null;
  const s = Math.round(Number(o.severity));
  const c = Number(o.confidence);
  return {
    category: category as DrainCategory,
    severity: (s >= 1 && s <= 4 ? s : 2) as 1 | 2 | 3 | 4,
    confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5,
    description: typeof o.description === "string" ? o.description.trim().slice(0, 400) : "",
  };
}

const SYSTEM = `You classify a citizen's photo of urban drainage for a municipal response team.
Reply with ONE JSON object and nothing else:
{"category": one of ${DRAIN_CATEGORIES.map((c) => `"${c}"`).join(", ")} ("not_a_drain" if the photo shows no drain, sewer or standing water),
 "severity": 1-4 (4 = immediate danger e.g. open manhole on a road or flooding entering homes, 1 = minor),
 "confidence": 0-1,
 "description": one short factual sentence about what is visible. Do not describe or identify people.}`;

export async function analysePhoto(img: Image, cfg: LlmConfig = llmConfig("VISION")): Promise<VisionOutcome> {
  const why = notReady(cfg);
  if (why) return { ok: false, provider: cfg.provider, reason: why };
  try {
    const result = validateVision(await chatJson(cfg, SYSTEM, "Classify this photo.", [img]));
    return result ? { ok: true, provider: `${cfg.provider}:${cfg.model}`, result } : { ok: false, provider: cfg.provider, reason: "the model reply did not pass validation" };
  } catch (e) {
    return { ok: false, provider: cfg.provider, reason: (e as Error).message };
  }
}
