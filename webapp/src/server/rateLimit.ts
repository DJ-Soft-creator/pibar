// Dependency-free in-memory sliding-window rate limiter (per key, e.g. client IP).
// Used for the unauthenticated /api/login endpoint: max 10 attempts per minute per IP.

export interface RateLimiterOptions {
  /** Max attempts within the window (default 10). */
  limit?: number;
  /** Window size in ms (default 60_000). */
  windowMs?: number;
  /** Clock injection for tests (default Date.now). */
  now?: () => number;
}

export interface RateLimiter {
  /** true = attempt allowed, false = limit exceeded (respond 429). */
  allow(key: string): boolean;
}

export function createLoginRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
  const limit = opts.limit ?? 10;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();

  return {
    allow(key: string): boolean {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((ts) => t - ts < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      // Opportunistic cleanup so the map cannot grow without bound.
      if (hits.size > 1000) {
        for (const [k, timestamps] of hits) {
          const alive = timestamps.filter((ts) => t - ts < windowMs);
          if (alive.length === 0) hits.delete(k);
          else hits.set(k, alive);
        }
      }
      return true;
    },
  };
}
