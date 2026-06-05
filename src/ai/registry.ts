import { logger } from "@/lib/logger";
import type { ReceiptExtractor } from "./types";
import { MockReceiptExtractor } from "./providers/mock";
import { OpenAiReceiptExtractor } from "./providers/openai";

/**
 * Provider registry.
 *
 * Selection rules:
 *   1. Build a list of all known providers in declared preference order.
 *   2. Honour `AI_PROVIDER_PRIORITY` if set (comma-separated names).
 *   3. The first provider that returns `true` from `isConfigured()` wins.
 *
 * `mock` is always at the tail so dev / tests always have a working provider.
 */

const ALL_PROVIDERS: Record<string, () => ReceiptExtractor> = {
  openai: () => new OpenAiReceiptExtractor(),
  mock: () => new MockReceiptExtractor(),
};

let cached: ReceiptExtractor | null = null;

export function listProviderNames(): string[] {
  return Object.keys(ALL_PROVIDERS);
}

function preferenceOrder(): string[] {
  const env = process.env.AI_PROVIDER_PRIORITY;
  if (!env) return ["openai", "mock"];
  return env
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s in ALL_PROVIDERS)
    .concat("mock"); // mock is always reachable as last-resort
}

export function getReceiptExtractor(): ReceiptExtractor {
  if (cached) return cached;
  for (const name of preferenceOrder()) {
    const factory = ALL_PROVIDERS[name];
    if (!factory) continue;
    const p = factory();
    if (p.isConfigured()) {
      logger.info({ provider: p.name }, "AI receipt extractor selected");
      cached = p;
      return p;
    }
  }
  // Unreachable: mock is always configured. But keep a sane fallback.
  cached = new MockReceiptExtractor();
  return cached;
}

/** Test hook — drop the cached provider so the next call re-picks. */
export function resetReceiptExtractorCache(): void {
  cached = null;
}
