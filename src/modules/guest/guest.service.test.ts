import { describe, test, expect } from "vitest";
import { __test__ } from "./guest.service";

const { splitProportionalPaise } = __test__;

describe("splitProportionalPaise", () => {
  test("splits in exact proportion when divisible", () => {
    expect(splitProportionalPaise(1000, [1, 1])).toEqual([500, 500]);
    expect(splitProportionalPaise(900, [1, 2])).toEqual([300, 600]);
  });

  test("distributes remainder so the chunks always sum to the total", () => {
    for (const total of [101, 1001, 12345, 99_999]) {
      for (const weights of [[1, 1, 1], [1, 2, 3], [2, 3, 5, 7]]) {
        const chunks = splitProportionalPaise(total, weights);
        expect(chunks).toHaveLength(weights.length);
        expect(chunks.reduce((s, c) => s + c, 0)).toBe(total);
      }
    }
  });

  test("returns all zeros when weights sum to zero", () => {
    expect(splitProportionalPaise(1000, [0, 0])).toEqual([0, 0]);
  });
});
