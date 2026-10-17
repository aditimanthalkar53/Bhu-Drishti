/**
 * Sliding-window in-memory rate limiter.
 *
 * Suitable for a single-process deployment (MemoryStore / no Redis).
 * For multi-replica deployments, replace with a Redis-backed counter.
 */

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();

  constructor(
    /** Max requests allowed per window. */
    private limit: number,
    /** Window size in milliseconds. */
    private windowMs: number,
  ) {
    // Prune stale entries every 5 minutes so the Map doesn't grow unbounded.
    setInterval(() => this._prune(), 5 * 60_000).unref();
  }

  /** Returns true if the request is allowed, false if it must be rejected. */
  check(key: string): boolean {
    const now = Date.now();
    let w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    if (w.count >= this.limit) return false;
    w.count++;
    return true;
  }

  private _prune() {
    const now = Date.now();
    for (const [k, w] of this.windows) {
      if (now >= w.resetAt) this.windows.delete(k);
    }
  }
}

/** Rate limiters used across the application. */
export const authLimiter = new RateLimiter(10, 60_000);   // 10 auth requests / minute per IP
export const queryLimiter = new RateLimiter(20, 60_000);  // 20 query submissions / minute per user
