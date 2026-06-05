/**
 * AI provider registry. Two capabilities are independent — a provider can
 * implement either or both. Both selectors walk the same `AI_PROVIDER_PRIORITY`
 * list; mock is appended as a guaranteed fallback.
 */

import { logger } from "@/lib/logger";
import type { IntentParser, ReceiptExtractor } from "./types";
import { AnthropicProvider } from "./providers/anthropic";
import { BedrockProvider } from "./providers/bedrock";
import { MockProvider } from "./providers/mock";
import { OpenAiReceiptExtractor } from "./providers/openai";

type AnyProvider = ReceiptExtractor | IntentParser;

const ALL_PROVIDERS: Record<string, () => AnyProvider> = {
  bedrock: () => new BedrockProvider(),
  anthropic: () => new AnthropicProvider(),
  openai: () => new OpenAiReceiptExtractor(),
  mock: () => new MockProvider(),
};

let receiptCache: ReceiptExtractor | null = null;
let intentCache: IntentParser | null = null;

export function listProviderNames(): string[] {
  return Object.keys(ALL_PROVIDERS);
}

function preferenceOrder(): string[] {
  const env = process.env.AI_PROVIDER_PRIORITY;
  // Default reflects the proposal: Bedrock first, then direct Anthropic,
  // then OpenAI (legacy), then mock.
  const fallback = ["bedrock", "anthropic", "openai", "mock"];
  if (!env) return fallback;
  return env
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s in ALL_PROVIDERS)
    .concat("mock");
}

function isReceiptExtractor(p: AnyProvider): p is ReceiptExtractor {
  return typeof (p as ReceiptExtractor).extract === "function";
}

function isIntentParser(p: AnyProvider): p is IntentParser {
  return typeof (p as IntentParser).parseIntent === "function";
}

export function getReceiptExtractor(): ReceiptExtractor {
  if (receiptCache) return receiptCache;
  for (const name of preferenceOrder()) {
    const factory = ALL_PROVIDERS[name];
    if (!factory) continue;
    const p = factory();
    if (isReceiptExtractor(p) && p.isConfigured()) {
      logger.info({ provider: p.name }, "AI receipt extractor selected");
      receiptCache = p;
      return p;
    }
  }
  receiptCache = new MockProvider();
  return receiptCache;
}

export function getIntentParser(): IntentParser {
  if (intentCache) return intentCache;
  for (const name of preferenceOrder()) {
    const factory = ALL_PROVIDERS[name];
    if (!factory) continue;
    const p = factory();
    if (isIntentParser(p) && p.isConfigured()) {
      logger.info({ provider: p.name }, "AI intent parser selected");
      intentCache = p;
      return p;
    }
  }
  intentCache = new MockProvider();
  return intentCache;
}

/** Test hook — drop both caches so the next call re-picks. */
export function resetReceiptExtractorCache(): void {
  receiptCache = null;
  intentCache = null;
}
