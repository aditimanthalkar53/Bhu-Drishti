const BASE = import.meta.env.VITE_API_URL ?? "";
const TOKEN_KEY = "bhudrishti.token";

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let token: string | null = readToken();

export function setToken(t: string | null) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) — keep the token in memory only */
  }
}

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(ApiError.describe(status, body));
  }
  static describe(status: number, body: any): string {
    const d = body?.detail ?? body?.error ?? body;
    if (typeof d === "string") return d;
    if (d?.message && d?.plan?.checks) {
      const failed = d.plan.checks.filter((c: any) => !c.ok && c.blocking).map((c: any) => `${c.name}: ${c.detail}`);
      return failed.length ? failed.join(" · ") : d.message;
    }
    if (body?.plan?.checks) {
      const failed = body.plan.checks.filter((c: any) => !c.ok && c.blocking).map((c: any) => `${c.name}: ${c.detail}`);
      if (failed.length) return `${body.error ?? "Not runnable"} — ${failed.join(" · ")}`;
    }
    if (Array.isArray(d)) return d.map((e: any) => e.msg ?? String(e)).join("; ");
    return `Request failed (${status})`;
  }
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const post = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const patch = <T = any>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export const del = <T = any>(path: string) => api<T>(path, { method: "DELETE" });

let sessionPromise: Promise<{ id: string; name: string; guest: boolean }> | null = null;

/** Make sure we hold a valid token; create a guest session if not. Single-flight. */
export function ensureSession(): Promise<{ id: string; name: string; guest: boolean }> {
  sessionPromise ??= createOrResumeSession().catch((e) => {
    sessionPromise = null;
    throw e;
  });
  return sessionPromise;
}

async function createOrResumeSession(): Promise<{ id: string; name: string; guest: boolean }> {
  if (token) {
    try {
      return await api("/api/auth/me");
    } catch {
      setToken(null);
    }
  }
  const r = await post<{ token: string; user: any }>("/api/auth/guest");
  setToken(r.token);
  return r.user;
}

/** URL usable in <a href> / EventSource (cannot send headers): the token travels as ?token=. */
export function authUrl(path: string) {
  const sep = path.includes("?") ? "&" : "?";
  return `${BASE}${path}${sep}token=${encodeURIComponent(token ?? "")}`;
}

export function eventsUrl(queryId: string) {
  return authUrl(`/api/queries/${queryId}/events`);
}

export function traceUrl(queryId: string) {
  return authUrl(`/api/queries/${queryId}/trace`);
}
