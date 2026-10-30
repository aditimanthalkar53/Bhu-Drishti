// Live-data validation queries satellite catalogues before a run starts, so allow more than a few seconds.
const ENGINE_TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS ?? 120_000);

/** Thin client for the Python AEQE engine. */
export class EngineError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof body === "object" && body && "detail" in (body as object) ? JSON.stringify((body as { detail: unknown }).detail) : `engine HTTP ${status}`);
  }
}

export class EngineClient {
  constructor(private base: string) {}

  async json<T = unknown>(path: string, init: RequestInit = {}, timeoutMs = ENGINE_TIMEOUT_MS): Promise<T> {
    let res: Response;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      res = await fetch(this.base + path, {
        ...init,
        signal: init.signal ?? ac.signal,
        headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
      });
    } catch (e) {
      const msg = (e as Error).name === "AbortError" ? "engine request timed out" : (e as Error).message;
      throw new EngineError(503, { detail: `engine unreachable at ${this.base}: ${msg}` });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { detail: text.slice(0, 300) };
    }
    if (!res.ok) throw new EngineError(res.status, body);
    return body as T;
  }

  get<T = unknown>(path: string) {
    return this.json<T>(path);
  }

  post<T = unknown>(path: string, body?: unknown) {
    return this.json<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** Raw streaming request (SSE / file downloads). */
  raw(path: string, signal?: AbortSignal) {
    return fetch(this.base + path, { signal });
  }
}
