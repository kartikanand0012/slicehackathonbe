import { describe, test, expect } from "vitest";
import {
  formatINR,
  renderExplanationTemplate,
  renderExplanationNarrated,
  type ExpenseExplainInput,
} from "./explain-renderer";

const sample: ExpenseExplainInput = {
  title: "Dinner",
  splitMode: "CONSTRAINT",
  amountPaise: 97_175,
  paidByName: "Alice",
  audienceName: "Mohit",
  audienceShare: 17_000,
  shares: [
    { name: "Alice", amountPaise: 40_087 },
    { name: "Sukant", amountPaise: 40_088 },
    { name: "Mohit", amountPaise: 17_000 },
  ],
};

describe("formatINR", () => {
  test("renders paise with the ₹ symbol", () => {
    expect(formatINR(97_175)).toMatch(/₹\s?971\.75/);
    expect(formatINR(620)).toMatch(/₹\s?6\.20/);
    expect(formatINR(0)).toMatch(/₹\s?0\.00/);
  });
});

describe("renderExplanationTemplate", () => {
  test("always renders something deterministic", () => {
    const text = renderExplanationTemplate(sample);
    expect(text).toContain("Dinner");
    expect(text).toContain("Alice");
    expect(text).toContain("Mohit");
    expect(text).toContain("Your share");
  });

  test("omits 'Your share' when audience missing", () => {
    const text = renderExplanationTemplate({ ...sample, audienceName: undefined });
    expect(text).not.toContain("Your share");
  });
});

describe("renderExplanationNarrated", () => {
  test("falls back to template when mock provider is active", async () => {
    // Default test env has no real provider keys → registry picks mock → narrator falls back.
    const { text, source } = await renderExplanationNarrated(sample);
    expect(source).toBe("template");
    expect(text).toContain("Dinner");
  });
});
