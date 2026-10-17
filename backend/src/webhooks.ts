import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Webhook, WebhookEvent } from "./domain.js";
import type { Store } from "./store/types.js";

/**
 * Outgoing webhooks (consumed by n8n or any automation tool).
 *
 * Every POST carries:
 *   x-bhudrishti-event:     the event name
 *   x-bhudrishti-delivery:  a unique id (receivers should de-duplicate on it)
 *   x-bhudrishti-timestamp: unix seconds
 *   x-bhudrishti-signature: "sha256=" + HMAC_SHA256(secret, `${timestamp}.${body}`)
 * Receivers verify the signature and reject timestamps older than 5 minutes.
 */
export function sign(secret: string, timestamp: number, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function newSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export function isAllowedUrl(raw: string, allowPrivate: boolean): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (allowPrivate) return true;
  if (u.protocol !== "https:") return false;
  const h = u.hostname;
  return !(/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith(".internal"));
}

export async function deliver(hook: Webhook, event: WebhookEvent, payload: unknown, timeoutMs = 10_000) {
  const body = JSON.stringify({ event, created_at: new Date().toISOString(), data: payload });
  const ts = Math.floor(Date.now() / 1000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(hook.url, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "content-type": "application/json",
        "x-bhudrishti-event": event,
        "x-bhudrishti-delivery": randomUUID(),
        "x-bhudrishti-timestamp": String(ts),
        "x-bhudrishti-signature": sign(hook.secret, ts, body),
      },
      body,
    });
    return { status: r.status, error: r.ok ? null : `HTTP ${r.status}` };
  } catch (e) {
    return { status: 0, error: (e as Error).name === "AbortError" ? "timeout" : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Send ``event`` to every active webhook of ``ownerId`` subscribed to it; records the outcome on the hook. */
export async function emit(store: Store, ownerId: string, event: WebhookEvent, payload: unknown): Promise<number> {
  const hooks = (await store.listRecords<Webhook>("webhook", ownerId)).filter((h) => h.active && h.events.includes(event));
  await Promise.all(hooks.map(async (h) => {
    let res = await deliver(h, event, payload);
    if (res.status === 0 || res.status >= 500) res = await deliver(h, event, payload); // one retry for transient failures
    await store.putRecord("webhook", { ...h, lastStatus: res.status, lastError: res.error, lastDeliveredAt: new Date().toISOString() });
  }));
  return hooks.length;
}
