import type { RequestHandler } from "express";
import { checkRateLimit } from "@/lib/rate-limit";
import { RateLimitedError } from "@/lib/errors";

/**
 * Per-IP+route rate limit. Builds the key from req.ip plus a tag so different
 * endpoints don't share buckets.
 */
export const rateLimit =
  (tag: string, max: number, windowMs: number): RequestHandler =>
  (req, res, next) => {
    const ip = req.ip ?? "unknown";
    const key = `${tag}:${ip}`;
    const result = checkRateLimit(key, max, windowMs);
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", Math.ceil(result.retryAfterMs / 1000));
      throw new RateLimitedError("Too many requests", result.retryAfterMs);
    }
    next();
  };
