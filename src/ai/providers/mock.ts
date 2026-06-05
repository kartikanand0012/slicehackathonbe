import type { AiHealth, ExtractInput, ReceiptExtractor } from "../types";

/**
 * Mock receipt extractor — always available, returns canned data. Used in
 * development and tests so a working demo doesn't require API keys.
 */
export class MockReceiptExtractor implements ReceiptExtractor {
  readonly name = "mock";

  isConfigured(): boolean {
    return true;
  }

  async health(): Promise<AiHealth> {
    return { ok: true, detail: "mock provider is always healthy" };
  }

  async extract(_input: ExtractInput): ReturnType<ReceiptExtractor["extract"]> {
    const extracted = {
      merchantName: "Cafe Bistro",
      occurredAt: new Date().toISOString(),
      currency: "INR" as const,
      subtotalPaise: 84_500,
      taxPaise: 4_225,
      tipPaise: 8_450,
      totalPaise: 97_175,
      items: [
        { name: "Veg Pizza", quantity: 1, unitPaise: 45_000, totalPaise: 45_000 },
        { name: "Pasta Arrabbiata", quantity: 1, unitPaise: 28_500, totalPaise: 28_500 },
        { name: "Iced Latte", quantity: 2, unitPaise: 5_500, totalPaise: 11_000 },
      ],
    };
    return { extracted, raw: { provider: "mock" } };
  }
}
