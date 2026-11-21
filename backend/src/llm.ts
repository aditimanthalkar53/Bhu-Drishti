/**
 * Provider-agnostic JSON calls to a language or vision model, configured per feature with
 * <PREFIX>_PROVIDER (ollama | openai | anthropic | none), <PREFIX>_API_KEY, <PREFIX>_MODEL and optional <PREFIX>_BASE_URL.
 * "openai" means any OpenAI-compatible chat-completions endpoint. Keys stay on the server; callers always have a
 * no-model fallback, so an unset or failing provider never blocks a citizen's report.
 */
export type LlmProvider = "ollama" | "openai" | "anthropic" | "none";

export interface LlmConfig { provider: LlmProvider; apiKey: string | null; model: string | null; baseUrl: string | null; timeoutMs: number }

export interface Image { mime: string; base64: string }

const DEFAULT_MODEL: Record<Exclude<LlmProvider, "none">, string> = {
  ollama: "qwen2.5:7b-instruct", openai: "gpt-4o-mini", anthropic: "claude-haiku-5-5",
};

export function llmConfig(prefix: "INTAKE" | "VISION", env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const p = (env[`${prefix}_PROVIDER`] ?? "none").toLowerCase();
  const provider: LlmProvider = p === "ollama" || p === "openai" || p === "anthropic" ? p : "none";
  return {
    provider,
    apiKey: env[`${prefix}_API_KEY`] || null,
    model: env[`${prefix}_MODEL`] || (provider === "none" ? null : DEFAULT_MODEL[provider]),
    baseUrl: (env[`${prefix}_BASE_URL`] || "").replace(/\/$/, "") || null,
    timeoutMs: Number(env[`${prefix}_TIMEOUT_MS`] ?? (provider === "ollama" ? 90_000 : 30_000)),
  };
}

/** Why the model cannot be used, or null when it is configured. */
export function notReady(cfg: LlmConfig): string | null {
  if (cfg.provider === "none") return "no model configured";
  if ((cfg.provider === "openai" || cfg.provider === "anthropic") && !cfg.apiKey) return `${cfg.provider} needs an API key`;
  return null;
}

/** Pull the first JSON object out of a model reply (some models wrap it in prose or code fences). */
export function extractJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
  throw new Error("model reply was not JSON");
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`model HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } catch (e) {
    throw new Error((e as Error).name === "AbortError" ? "model timed out" : (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export async function chatJson(cfg: LlmConfig, system: string, user: string, images: Image[] = []): Promise<unknown> {
  const why = notReady(cfg);
  if (why) throw new Error(why);
  const model = cfg.model!;
  if (cfg.provider === "ollama") {
    const r = await postJson(`${cfg.baseUrl ?? "http://127.0.0.1:11434"}/api/chat`, {}, {
      model, stream: false, format: "json", options: { temperature: 0 },
      messages: [{ role: "system", content: system }, { role: "user", content: user, ...(images.length ? { images: images.map((i) => i.base64) } : {}) }],
    }, cfg.timeoutMs);
    return extractJson(String(r?.message?.content ?? ""));
  }
  if (cfg.provider === "openai") {
    const content = images.length
      ? [{ type: "text", text: user }, ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.base64}` } }))]
      : user;
    const r = await postJson(`${cfg.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, { authorization: `Bearer ${cfg.apiKey}` }, {
      model, temperature: 0, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content }],
    }, cfg.timeoutMs);
    return extractJson(String(r?.choices?.[0]?.message?.content ?? ""));
  }
  const r = await postJson(`${cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, { "x-api-key": cfg.apiKey!, "anthropic-version": "2023-06-01" }, {
    model, max_tokens: 800, system,
    messages: [{ role: "user", content: [...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.base64 } })), { type: "text", text: user }] }],
  }, cfg.timeoutMs);
  const text = (r?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  return extractJson(text);
}
