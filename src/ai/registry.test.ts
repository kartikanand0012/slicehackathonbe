import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { getReceiptExtractor, resetReceiptExtractorCache } from "./registry";

/**
 * Every test starts from a fresh, fully-unconfigured registry state so the
 * provider picked is purely a function of what the test sets. We clear *all*
 * provider-credential env vars in beforeEach and restore them in afterEach
 * so the suite doesn't leak state into other test files.
 */
const PROVIDER_ENV_KEYS = [
  "AI_PROVIDER_PRIORITY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const;

describe("getReceiptExtractor", () => {
  const ORIGINAL: Partial<Record<(typeof PROVIDER_ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    resetReceiptExtractorCache();
    for (const k of PROVIDER_ENV_KEYS) {
      if (k in process.env) ORIGINAL[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of PROVIDER_ENV_KEYS) {
      if (ORIGINAL[k] !== undefined) process.env[k] = ORIGINAL[k];
      else delete process.env[k];
    }
    resetReceiptExtractorCache();
  });

  test("falls back to mock when no provider is configured", () => {
    expect(getReceiptExtractor().name).toBe("mock");
  });

  test("picks openai when its key is set (no other providers configured)", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(getReceiptExtractor().name).toBe("openai");
  });

  test("picks anthropic when its key is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(getReceiptExtractor().name).toBe("anthropic");
  });

  test("honours AI_PROVIDER_PRIORITY ordering", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.AI_PROVIDER_PRIORITY = "mock,openai";
    expect(getReceiptExtractor().name).toBe("mock");
  });

  test("caches the picked provider across calls", () => {
    const a = getReceiptExtractor();
    const b = getReceiptExtractor();
    expect(a).toBe(b);
  });
});
