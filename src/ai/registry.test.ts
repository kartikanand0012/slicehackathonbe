import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { getReceiptExtractor, resetReceiptExtractorCache } from "./registry";

describe("getReceiptExtractor", () => {
  const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
  const ORIGINAL_PRI = process.env.AI_PROVIDER_PRIORITY;

  beforeEach(() => {
    resetReceiptExtractorCache();
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_PROVIDER_PRIORITY;
  });

  afterEach(() => {
    if (ORIGINAL_KEY) process.env.OPENAI_API_KEY = ORIGINAL_KEY;
    if (ORIGINAL_PRI) process.env.AI_PROVIDER_PRIORITY = ORIGINAL_PRI;
  });

  test("falls back to mock when no provider is configured", () => {
    expect(getReceiptExtractor().name).toBe("mock");
  });

  test("picks openai when its key is set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(getReceiptExtractor().name).toBe("openai");
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
