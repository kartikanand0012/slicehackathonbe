import { describe, test, expect } from "vitest";
import { __test__ } from "./disputes.service";

const { decideAutoResolve } = __test__;

const baseExp = {
  splitMode: "EXACT" as const,
  amountPaise: 10_000,
  shares: [
    { userId: "alice", amountPaise: 4_000 },
    { userId: "bob", amountPaise: 6_000 },
  ],
};

describe("decideAutoResolve", () => {
  test("escalates when no payload supplied", () => {
    const d = decideAutoResolve(baseExp, "alice", undefined);
    expect(d.auto).toBe(false);
    expect(d.reason).toMatch(/structured/i);
  });

  test("auto-resolves a small paiseDelta within 10% of own share", () => {
    // Alice's share is 4000; 10% = 400. Asking for 300 back → auto-resolve.
    const d = decideAutoResolve(baseExp, "alice", { paiseDelta: 300 });
    expect(d.auto).toBe(true);
  });

  test("escalates a paiseDelta larger than 10%", () => {
    const d = decideAutoResolve(baseExp, "alice", { paiseDelta: 1_500 });
    expect(d.auto).toBe(false);
    expect(d.reason).toMatch(/too large/i);
  });

  test("escalates an itemNames dispute on a non-ITEM/CONSTRAINT split", () => {
    const d = decideAutoResolve(baseExp, "alice", { itemNames: ["dessert"] });
    expect(d.auto).toBe(false);
    expect(d.reason).toMatch(/cannot auto-resolve/i);
  });

  test("does not auto-resolve a zero or negative delta", () => {
    const d = decideAutoResolve(baseExp, "alice", { paiseDelta: 0 });
    expect(d.auto).toBe(false);
  });

  test("escalates if the raiser has no share to scale against", () => {
    const d = decideAutoResolve(
      { ...baseExp, shares: [{ userId: "bob", amountPaise: 10_000 }] },
      "alice",
      { paiseDelta: 100 },
    );
    expect(d.auto).toBe(false);
  });
});
