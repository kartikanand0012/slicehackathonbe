import { describe, test, expect } from "vitest";
import { calculateShares } from "./split-calculator";

describe("calculateShares — EQUAL", () => {
  test("evenly divides when divisible", () => {
    const rows = calculateShares({
      mode: "EQUAL",
      totalPaise: 9000,
      userIds: ["a", "b", "c"],
    });
    expect(rows.map((r) => r.amountPaise)).toEqual([3000, 3000, 3000]);
  });

  test("distributes remainder deterministically", () => {
    const rows = calculateShares({
      mode: "EQUAL",
      totalPaise: 1000,
      userIds: ["c", "a", "b"],
    });
    expect(rows.map((r) => r.userId)).toEqual(["a", "b", "c"]);
    expect(rows.map((r) => r.amountPaise)).toEqual([334, 333, 333]);
    expect(rows.reduce((s, r) => s + r.amountPaise, 0)).toBe(1000);
  });

  test("rejects duplicate userIds", () => {
    expect(() =>
      calculateShares({ mode: "EQUAL", totalPaise: 100, userIds: ["a", "a"] }),
    ).toThrow();
  });
});

describe("calculateShares — EXACT", () => {
  test("accepts shares that sum to total", () => {
    const rows = calculateShares({
      mode: "EXACT",
      totalPaise: 1000,
      shares: [
        { userId: "a", amountPaise: 600 },
        { userId: "b", amountPaise: 400 },
      ],
    });
    expect(rows.find((r) => r.userId === "a")!.amountPaise).toBe(600);
    expect(rows.find((r) => r.userId === "b")!.amountPaise).toBe(400);
  });

  test("rejects shares that don't sum to total", () => {
    expect(() =>
      calculateShares({
        mode: "EXACT",
        totalPaise: 1000,
        shares: [
          { userId: "a", amountPaise: 600 },
          { userId: "b", amountPaise: 399 },
        ],
      }),
    ).toThrow(/sum to/);
  });
});

describe("calculateShares — PERCENTAGE", () => {
  test("splits by basis points and absorbs rounding remainder", () => {
    const rows = calculateShares({
      mode: "PERCENTAGE",
      totalPaise: 1000,
      shares: [
        { userId: "a", basisPoints: 3333 },
        { userId: "b", basisPoints: 3333 },
        { userId: "c", basisPoints: 3334 },
      ],
    });
    expect(rows.reduce((s, r) => s + r.amountPaise, 0)).toBe(1000);
    expect(rows.every((r) => r.basisPoints !== null)).toBe(true);
  });

  test("rejects basis points that don't sum to 10000", () => {
    expect(() =>
      calculateShares({
        mode: "PERCENTAGE",
        totalPaise: 1000,
        shares: [
          { userId: "a", basisPoints: 4000 },
          { userId: "b", basisPoints: 4000 },
        ],
      }),
    ).toThrow(/10000/);
  });
});

describe("calculateShares — SHARES", () => {
  test("splits proportional to share units", () => {
    const rows = calculateShares({
      mode: "SHARES",
      totalPaise: 1200,
      shares: [
        { userId: "a", shares: 1 },
        { userId: "b", shares: 2 },
        { userId: "c", shares: 3 },
      ],
    });
    expect(rows.find((r) => r.userId === "a")!.amountPaise).toBe(200);
    expect(rows.find((r) => r.userId === "b")!.amountPaise).toBe(400);
    expect(rows.find((r) => r.userId === "c")!.amountPaise).toBe(600);
    expect(rows.reduce((s, r) => s + r.amountPaise, 0)).toBe(1200);
  });

  test("absorbs remainder when total doesn't divide evenly", () => {
    const rows = calculateShares({
      mode: "SHARES",
      totalPaise: 1000,
      shares: [
        { userId: "a", shares: 1 },
        { userId: "b", shares: 1 },
        { userId: "c", shares: 1 },
      ],
    });
    expect(rows.reduce((s, r) => s + r.amountPaise, 0)).toBe(1000);
  });

  test("rejects non-positive share units", () => {
    expect(() =>
      calculateShares({
        mode: "SHARES",
        totalPaise: 100,
        shares: [{ userId: "a", shares: 0 }],
      }),
    ).toThrow();
  });
});

describe("calculateShares — guardrails", () => {
  test("rejects zero or negative totals", () => {
    expect(() =>
      calculateShares({ mode: "EQUAL", totalPaise: 0, userIds: ["a"] }),
    ).toThrow();
    expect(() =>
      calculateShares({ mode: "EQUAL", totalPaise: -1, userIds: ["a"] }),
    ).toThrow();
  });
});
