/**
 * Tiny in-memory rate limiter. Fine for a single-instance backend; swap
 * for Redis when we scale out.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

export function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const b = buckets.get(key);

  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxAttempts - 1, retryAfterMs: 0 };
  }

  if (b.count >= maxAttempts) {
    return { allowed: false, remaining: 0, retryAfterMs: b.resetAt - now };
  }

  b.count++;
  return { allowed: true, remaining: maxAttempts - b.count, retryAfterMs: 0 };
}

/** Periodic GC to keep the map small. */
const GC_INTERVAL_MS = 60_000;
const gc = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (now > v.resetAt) buckets.delete(k);
  }
}, GC_INTERVAL_MS);
gc.unref?.();
