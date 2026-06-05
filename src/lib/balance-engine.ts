/**
 * SliceSplit balance engine.
 *
 * Two pure functions:
 *   - computeBalances: turns expenses + settlements into per-member net positions
 *   - simplifyDebts:  produces a minimal set of transfers that settle the group
 *
 * All amounts are integer paise. No floats anywhere on the hot path.
 *
 * Ported from ShareTab's balance-calculator with the multi-currency path
 * removed (SliceSplit is INR-only) and a few defensive guards added.
 */

export type MemberBalance = {
  userId: string;
  paidPaise: number;
  owesPaise: number;
  netPaise: number;
};

export type SimplifiedTransfer = {
  fromUserId: string;
  toUserId: string;
  amountPaise: number;
};

export type ExpenseInput = {
  paidById: string;
  shares: { userId: string; amountPaise: number }[];
};

export type SettlementInput = {
  fromId: string;
  toId: string;
  amountPaise: number;
};

/**
 * Compute per-member balances from a list of expenses and settlements.
 *
 * Semantics:
 *   - For each expense, the payer's `paid` increases by sum(shares) and
 *     each share's user accumulates `owes`. (We trust shares to sum to
 *     the expense total; the caller validates this at the route boundary.)
 *   - A settlement is modelled as: `from` paid the group, `to` owed the group.
 *     Net effect: the debtor's net moves toward 0, creditor's net moves toward 0.
 *   - `net = paid - owes`. Positive net means owed money; negative means owes.
 *
 * Returns balances sorted by userId for deterministic output.
 */
export function computeBalances(
  expenses: ExpenseInput[],
  settlements: SettlementInput[],
): MemberBalance[] {
  const balances = new Map<string, MemberBalance>();

  const touch = (userId: string): MemberBalance => {
    let b = balances.get(userId);
    if (!b) {
      b = { userId, paidPaise: 0, owesPaise: 0, netPaise: 0 };
      balances.set(userId, b);
    }
    return b;
  };

  for (const exp of expenses) {
    const payer = touch(exp.paidById);
    let expenseTotal = 0;
    for (const share of exp.shares) {
      const member = touch(share.userId);
      member.owesPaise += share.amountPaise;
      expenseTotal += share.amountPaise;
    }
    payer.paidPaise += expenseTotal;
  }

  for (const s of settlements) {
    const from = touch(s.fromId);
    const to = touch(s.toId);
    from.paidPaise += s.amountPaise;
    to.owesPaise += s.amountPaise;
  }

  for (const b of balances.values()) {
    b.netPaise = b.paidPaise - b.owesPaise;
  }

  return Array.from(balances.values()).sort((a, b) =>
    a.userId.localeCompare(b.userId),
  );
}

/**
 * Greedy debt simplification: repeatedly match the largest creditor with
 * the largest debtor. For N members this produces at most N-1 transfers.
 *
 * Tie-broken by userId for deterministic output.
 */
export function simplifyDebts(balances: MemberBalance[]): SimplifiedTransfer[] {
  const creditors: { userId: string; remaining: number }[] = [];
  const debtors: { userId: string; remaining: number }[] = [];

  for (const b of balances) {
    if (b.netPaise > 0) creditors.push({ userId: b.userId, remaining: b.netPaise });
    else if (b.netPaise < 0)
      debtors.push({ userId: b.userId, remaining: -b.netPaise });
  }

  const byAmountDesc = (
    a: { userId: string; remaining: number },
    b: { userId: string; remaining: number },
  ) => b.remaining - a.remaining || a.userId.localeCompare(b.userId);

  creditors.sort(byAmountDesc);
  debtors.sort(byAmountDesc);

  const transfers: SimplifiedTransfer[] = [];
  let ci = 0;
  let di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci]!;
    const d = debtors[di]!;
    const amount = Math.min(c.remaining, d.remaining);
    if (amount > 0) {
      transfers.push({
        fromUserId: d.userId,
        toUserId: c.userId,
        amountPaise: amount,
      });
    }
    c.remaining -= amount;
    d.remaining -= amount;
    if (c.remaining === 0) ci++;
    if (d.remaining === 0) di++;
  }

  return transfers;
}

/**
 * Convenience: compute and simplify in one shot. Returns both the per-member
 * balances (useful for UI display) and the minimal transfer set (useful for
 * "settle up" suggestions).
 */
export function settleUp(
  expenses: ExpenseInput[],
  settlements: SettlementInput[],
): { balances: MemberBalance[]; transfers: SimplifiedTransfer[] } {
  const balances = computeBalances(expenses, settlements);
  const transfers = simplifyDebts(balances);
  return { balances, transfers };
}
