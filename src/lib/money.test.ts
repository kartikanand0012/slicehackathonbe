import { describe, test, expect } from "vitest";
import {
  rupeesToPaise,
  paiseToRupees,
  formatRupees,
  splitEqualPaise,
} from "./money";

describe("rupeesToPaise", () => {
  test("converts rupees to paise as integer", () => {
    expect(rupeesToPaise(12.99)).toBe(1299);
    expect(rupeesToPaise(0)).toBe(0);
    expect(rupeesToPaise(1)).toBe(100);
  });

  test("rounds half-up to the nearest paise", () => {
    expect(rupeesToPaise(0.005)).toBe(1);
    expect(rupeesToPaise(0.014)).toBe(1);
  });

  test("throws on non-finite input", () => {
    expect(() => rupeesToPaise(Infinity)).toThrow(RangeError);
    expect(() => rupeesToPaise(NaN)).toThrow(RangeError);
  });
});

describe("paiseToRupees", () => {
  test("converts paise to rupees", () => {
    expect(paiseToRupees(1299)).toBe(12.99);
    expect(paiseToRupees(0)).toBe(0);
  });
});

describe("formatRupees", () => {
  test("formats with ₹ symbol and Indian grouping", () => {
    expect(formatRupees(100000)).toMatch(/₹\s?1,000\.00/);
    expect(formatRupees(1299)).toMatch(/₹\s?12\.99/);
  });
});

describe("splitEqualPaise", () => {
  test("evenly divides when there is no remainder", () => {
    expect(splitEqualPaise(900, 3)).toEqual([300, 300, 300]);
  });

  test("distributes remainder one paise at a time to leading chunks", () => {
    expect(splitEqualPaise(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEqualPaise(1001, 3)).toEqual([334, 334, 333]);
  });

  test("chunks always sum to the total", () => {
    for (const total of [1, 2, 99, 1000, 12345, 99999]) {
      for (const parts of [1, 2, 3, 5, 7, 13]) {
        const chunks = splitEqualPaise(total, parts);
        expect(chunks).toHaveLength(parts);
        expect(chunks.reduce((s, n) => s + n, 0)).toBe(total);
      }
    }
  });

  test("throws on bad inputs", () => {
    expect(() => splitEqualPaise(100, 0)).toThrow(RangeError);
    expect(() => splitEqualPaise(100, -1)).toThrow(RangeError);
    expect(() => splitEqualPaise(100.5, 2)).toThrow(RangeError);
  });
});
