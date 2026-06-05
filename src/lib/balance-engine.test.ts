import { describe, test, expect } from "vitest";
import {
  computeBalances,
  simplifyDebts,
  settleUp,
  type MemberBalance,
} from "./balance-engine";

// ── simplifyDebts ───────────────────────────────────────────

describe("simplifyDebts", () => {
  test("returns empty array when all balances are zero", () => {
    const balances: MemberBalance[] = [
      { userId: "a", paidPaise: 10000, owesPaise: 10000, netPaise: 0 },
      { userId: "b", paidPaise: 5000, owesPaise: 5000, netPaise: 0 },
    ];
    expect(simplifyDebts(balances)).toEqual([]);
  });

  test("simple two-person debt", () => {
    const balances: MemberBalance[] = [
      { userId: "alice", paidPaise: 100000, owesPaise: 50000, netPaise: 50000 },
      { userId: "bob", paidPaise: 0, owesPaise: 50000, netPaise: -50000 },
    ];
    expect(simplifyDebts(balances)).toEqual([
      { fromUserId: "bob", toUserId: "alice", amountPaise: 50000 },
    ]);
  });

  test("three-person debt simplifies correctly", () => {
    const balances: MemberBalance[] = [
      { userId: "alice", paidPaise: 900000, owesPaise: 300000, netPaise: 600000 },
      { userId: "bob", paidPaise: 0, owesPaise: 300000, netPaise: -300000 },
      { userId: "charlie", paidPaise: 0, owesPaise: 300000, netPaise: -300000 },
    ];
    const transfers = simplifyDebts(balances);
    expect(transfers).toHaveLength(2);
    expect(transfers.reduce((s, t) => s + t.amountPaise, 0)).toBe(600000);
    for (const t of transfers) {
      expect(t.toUserId).toBe("alice");
      expect(t.amountPaise).toBe(300000);
    }
  });

  test("chain A→B, B→C collapses to A→C", () => {
    const balances: MemberBalance[] = [
      { userId: "a", paidPaise: 0, owesPaise: 10000, netPaise: -10000 },
      { userId: "b", paidPaise: 10000, owesPaise: 10000, netPaise: 0 },
      { userId: "c", paidPaise: 10000, owesPaise: 0, netPaise: 10000 },
    ];
    expect(simplifyDebts(balances)).toEqual([
      { fromUserId: "a", toUserId: "c", amountPaise: 10000 },
    ]);
  });

  test("output is deterministic when amounts tie", () => {
    const balances: MemberBalance[] = [
      { userId: "zoe", paidPaise: 0, owesPaise: 0, netPaise: 5000 },
      { userId: "amy", paidPaise: 0, owesPaise: 0, netPaise: 5000 },
      { userId: "bob", paidPaise: 0, owesPaise: 0, netPaise: -5000 },
      { userId: "carl", paidPaise: 0, owesPaise: 0, netPaise: -5000 },
    ];
    const a = simplifyDebts(balances);
    const b = simplifyDebts([...balances].reverse());
    expect(a).toEqual(b);
  });

  test("at most N-1 transfers for N non-zero members", () => {
    const balances: MemberBalance[] = [
      { userId: "c1", paidPaise: 0, owesPaise: 0, netPaise: 10000 },
      { userId: "c2", paidPaise: 0, owesPaise: 0, netPaise: 20000 },
      { userId: "c3", paidPaise: 0, owesPaise: 0, netPaise: 5000 },
      { userId: "d1", paidPaise: 0, owesPaise: 0, netPaise: -15000 },
      { userId: "d2", paidPaise: 0, owesPaise: 0, netPaise: -12000 },
      { userId: "d3", paidPaise: 0, owesPaise: 0, netPaise: -8000 },
    ];
    expect(simplifyDebts(balances).length).toBeLessThanOrEqual(5);
  });

  test("handles empty input", () => {
    expect(simplifyDebts([])).toEqual([]);
  });
});

// ── computeBalances ─────────────────────────────────────────

describe("computeBalances", () => {
  test("single expense split equally between two people", () => {
    const balances = computeBalances(
      [
        {
          paidById: "alice",
          shares: [
            { userId: "alice", amountPaise: 50000 },
            { userId: "bob", amountPaise: 50000 },
          ],
        },
      ],
      [],
    );
    const alice = balances.find((b) => b.userId === "alice")!;
    const bob = balances.find((b) => b.userId === "bob")!;
    expect(alice).toMatchObject({ paidPaise: 100000, owesPaise: 50000, netPaise: 50000 });
    expect(bob).toMatchObject({ paidPaise: 0, owesPaise: 50000, netPaise: -50000 });
  });

  test("settlements reduce debts", () => {
    const balances = computeBalances(
      [
        {
          paidById: "alice",
          shares: [
            { userId: "alice", amountPaise: 50000 },
            { userId: "bob", amountPaise: 50000 },
          ],
        },
      ],
      [{ fromId: "bob", toId: "alice", amountPaise: 30000 }],
    );
    expect(balances.find((b) => b.userId === "alice")!.netPaise).toBe(20000);
    expect(balances.find((b) => b.userId === "bob")!.netPaise).toBe(-20000);
  });

  test("full settlement zeroes out balances", () => {
    const balances = computeBalances(
      [
        {
          paidById: "alice",
          shares: [
            { userId: "alice", amountPaise: 50000 },
            { userId: "bob", amountPaise: 50000 },
          ],
        },
      ],
      [{ fromId: "bob", toId: "alice", amountPaise: 50000 }],
    );
    expect(balances.every((b) => b.netPaise === 0)).toBe(true);
  });

  test("net balances always sum to zero", () => {
    const balances = computeBalances(
      [
        {
          paidById: "a",
          shares: [
            { userId: "a", amountPaise: 2849 },
            { userId: "b", amountPaise: 2849 },
            { userId: "c", amountPaise: 2849 },
          ],
        },
        {
          paidById: "b",
          shares: [
            { userId: "a", amountPaise: 4100 },
            { userId: "b", amountPaise: 4100 },
            { userId: "c", amountPaise: 4100 },
          ],
        },
        {
          paidById: "c",
          shares: [
            { userId: "a", amountPaise: 4750 },
            { userId: "b", amountPaise: 4750 },
            { userId: "c", amountPaise: 4750 },
          ],
        },
      ],
      [],
    );
    expect(balances.reduce((s, b) => s + b.netPaise, 0)).toBe(0);
  });

  test("empty input yields empty result", () => {
    expect(computeBalances([], [])).toEqual([]);
  });

  test("settlement-only flow", () => {
    const balances = computeBalances(
      [],
      [{ fromId: "bob", toId: "alice", amountPaise: 50000 }],
    );
    expect(balances.find((b) => b.userId === "alice")!.netPaise).toBe(-50000);
    expect(balances.find((b) => b.userId === "bob")!.netPaise).toBe(50000);
  });

  test("output is sorted by userId", () => {
    const balances = computeBalances(
      [
        {
          paidById: "zoe",
          shares: [
            { userId: "alice", amountPaise: 1000 },
            { userId: "zoe", amountPaise: 1000 },
          ],
        },
      ],
      [],
    );
    expect(balances.map((b) => b.userId)).toEqual(["alice", "zoe"]);
  });
});

// ── settleUp integration ────────────────────────────────────

describe("settleUp", () => {
  test("realistic apartment scenario reproduces expected transfers", () => {
    const { balances, transfers } = settleUp(
      [
        {
          paidById: "alice",
          shares: [
            { userId: "alice", amountPaise: 2849 },
            { userId: "bob", amountPaise: 2849 },
            { userId: "charlie", amountPaise: 2849 },
          ],
        },
        {
          paidById: "bob",
          shares: [
            { userId: "alice", amountPaise: 4100 },
            { userId: "bob", amountPaise: 4100 },
            { userId: "charlie", amountPaise: 4100 },
          ],
        },
        {
          paidById: "alice",
          shares: [
            { userId: "alice", amountPaise: 2667 },
            { userId: "bob", amountPaise: 2666 },
            { userId: "charlie", amountPaise: 2666 },
          ],
        },
        {
          paidById: "charlie",
          shares: [
            { userId: "alice", amountPaise: 4750 },
            { userId: "bob", amountPaise: 4750 },
            { userId: "charlie", amountPaise: 4750 },
          ],
        },
      ],
      [],
    );

    const alice = balances.find((b) => b.userId === "alice")!;
    expect(alice.netPaise).toBe(2180);
    expect(transfers).toHaveLength(2);
    expect(transfers.find((t) => t.fromUserId === "bob")!.amountPaise).toBe(2065);
    expect(transfers.find((t) => t.fromUserId === "charlie")!.amountPaise).toBe(115);
  });

  test("all-settled group produces no transfers", () => {
    const { transfers } = settleUp(
      [
        {
          paidById: "alice",
          shares: [
            { userId: "alice", amountPaise: 10000 },
            { userId: "bob", amountPaise: 10000 },
          ],
        },
      ],
      [{ fromId: "bob", toId: "alice", amountPaise: 10000 }],
    );
    expect(transfers).toEqual([]);
  });
});
