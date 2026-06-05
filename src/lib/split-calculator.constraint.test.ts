import { describe, test, expect } from "vitest";
import { calculateShares, __test__ } from "./split-calculator";

const { splitProportionalPaise } = __test__;

describe("splitProportionalPaise", () => {
  test("sums to total even with awkward weights", () => {
    for (const total of [100, 101, 1001, 12345, 99_999]) {
      for (const weights of [[1, 2, 3], [1, 1, 1, 1, 1, 1, 1]]) {
        expect(
          splitProportionalPaise(total, weights).reduce((s, n) => s + n, 0),
        ).toBe(total);
      }
    }
  });

  test("zero weights yields zeros", () => {
    expect(splitProportionalPaise(1000, [0, 0])).toEqual([0, 0]);
  });
});

describe("calculateShares — CONSTRAINT mode", () => {
  test("Mohit-veg scenario splits only veg items to Mohit", () => {
    const rows = calculateShares({
      mode: "CONSTRAINT",
      totalPaise: 97_175,
      items: [
        { name: "Veg Pizza", totalPaise: 45_000, tags: ["veg", "main"] },
        { name: "Chicken Tikka", totalPaise: 28_500, tags: ["non-veg", "main"] },
        { name: "Iced Latte", totalPaise: 11_000, tags: ["veg", "beverage"] },
      ],
      participants: [
        { userId: "kartik" },
        { userId: "sukant" },
        { userId: "mohit", allow: ["veg", "beverage"] },
      ],
      commonItemsPaise: 12_675,
    });

    const sum = rows.reduce((s, r) => s + r.amountPaise, 0);
    expect(sum).toBe(97_175);

    const byId = Object.fromEntries(rows.map((r) => [r.userId, r.amountPaise]));
    // Veg pizza (45k) split among 3 → 15k each
    // Chicken tikka (28.5k) split among kartik+sukant → 14250 each
    // Iced latte (11k) split among 3 → ~3666/3667 each
    // Then common 12675 distributed proportional to subtotal.
    // Mohit should pay less than Kartik / Sukant.
    expect(byId.mohit).toBeLessThan(byId.kartik!);
    expect(byId.mohit).toBeLessThan(byId.sukant!);
    // Kartik vs Sukant: each item contributes up to 1 paise of asymmetry from
    // remainder distribution. With 3 items + a common-charge step, the gap
    // can be a few paise — well inside "fair" for a ~₹972 bill.
    expect(Math.abs(byId.kartik! - byId.sukant!)).toBeLessThanOrEqual(4);
  });

  test("deny lists exclude items with matching tags", () => {
    const rows = calculateShares({
      mode: "CONSTRAINT",
      totalPaise: 1000,
      items: [
        { totalPaise: 600, tags: ["alcohol"] },
        { totalPaise: 400, tags: ["veg"] },
      ],
      participants: [
        { userId: "a", deny: ["alcohol"] },
        { userId: "b" },
      ],
    });
    const byId = Object.fromEntries(rows.map((r) => [r.userId, r.amountPaise]));
    // a pays only for veg (200), b pays for veg (200) + all alcohol (600)
    expect(byId.a).toBe(200);
    expect(byId.b).toBe(800);
  });

  test("rejects when an item has no eligible participant", () => {
    expect(() =>
      calculateShares({
        mode: "CONSTRAINT",
        totalPaise: 500,
        items: [{ totalPaise: 500, tags: ["non-veg"] }],
        participants: [{ userId: "a", allow: ["veg"] }],
      }),
    ).toThrow(/no participant is eligible/);
  });

  test("rejects when items+common don't equal totalPaise", () => {
    expect(() =>
      calculateShares({
        mode: "CONSTRAINT",
        totalPaise: 1000,
        items: [{ totalPaise: 500, tags: ["veg"] }],
        participants: [{ userId: "a" }],
        commonItemsPaise: 200, // 500 + 200 != 1000
      }),
    ).toThrow(/inconsistent/);
  });

  test("rejects duplicate participants", () => {
    expect(() =>
      calculateShares({
        mode: "CONSTRAINT",
        totalPaise: 100,
        items: [{ totalPaise: 100, tags: ["veg"] }],
        participants: [{ userId: "a" }, { userId: "a" }],
      }),
    ).toThrow(/unique/);
  });

  test("empty allow list means no restriction (treat as unconstrained)", () => {
    const rows = calculateShares({
      mode: "CONSTRAINT",
      totalPaise: 600,
      items: [{ totalPaise: 600, tags: ["non-veg"] }],
      participants: [
        { userId: "a", allow: [] },
        { userId: "b" },
      ],
    });
    const sum = rows.reduce((s, r) => s + r.amountPaise, 0);
    expect(sum).toBe(600);
  });
});
