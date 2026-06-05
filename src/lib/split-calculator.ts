/**
 * Split calculator.
 *
 * Given a total in paise + a split mode + per-user input, produce the
 * concrete `ExpenseShare` rows (each with `amountPaise`, `shares`,
 * `basisPoints`) that the engine will consume. Guarantees: sum of share
 * amounts === total. Rounding remainder, where present, is absorbed by the
 * leading participants (deterministic by userId order).
 */

import { splitEqualPaise } from "./money";
import { BadRequestError } from "./errors";

export type SplitMode =
  | "EQUAL"
  | "EXACT"
  | "PERCENTAGE"
  | "SHARES"
  | "CONSTRAINT";

export type ShareDraft = {
  userId: string;
  amountPaise: number;
  shares: number;
  basisPoints: number | null;
};

type EqualInput = { mode: "EQUAL"; totalPaise: number; userIds: string[] };
type ExactInput = {
  mode: "EXACT";
  totalPaise: number;
  shares: { userId: string; amountPaise: number }[];
};
type PercentageInput = {
  mode: "PERCENTAGE";
  totalPaise: number;
  shares: { userId: string; basisPoints: number }[]; // 5000 = 50.00%
};
type SharesInput = {
  mode: "SHARES";
  totalPaise: number;
  shares: { userId: string; shares: number }[];
};

/**
 * Tag-based "dietary" split. Each item has tags; each participant has
 * optional allow/deny tag lists. An item goes to every participant whose
 * constraints permit it, split equally; sum is preserved with the same
 * remainder-distribution trick used elsewhere.
 *
 * `commonItemsPaise` (tax, tips, service charge) is *not* tag-filtered —
 * it's distributed proportionally over each participant's item subtotal.
 */
type ConstraintInput = {
  mode: "CONSTRAINT";
  totalPaise: number;
  items: { name?: string; totalPaise: number; tags: string[] }[];
  participants: { userId: string; allow?: string[]; deny?: string[] }[];
  commonItemsPaise?: number;
};

export type SplitInput =
  | EqualInput
  | ExactInput
  | PercentageInput
  | SharesInput
  | ConstraintInput;

export function calculateShares(input: SplitInput): ShareDraft[] {
  if (input.totalPaise <= 0 || !Number.isInteger(input.totalPaise)) {
    throw new BadRequestError("Total must be a positive integer in paise");
  }

  switch (input.mode) {
    case "EQUAL":
      return splitEqual(input.totalPaise, input.userIds);
    case "EXACT":
      return splitExact(input.totalPaise, input.shares);
    case "PERCENTAGE":
      return splitPercentage(input.totalPaise, input.shares);
    case "SHARES":
      return splitShares(input.totalPaise, input.shares);
    case "CONSTRAINT":
      return splitConstraint(input);
  }
}

function dedupeAndSort<T extends { userId: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.userId)) {
      throw new BadRequestError(`Duplicate userId in shares: ${r.userId}`);
    }
    seen.add(r.userId);
  }
  return [...rows].sort((a, b) => a.userId.localeCompare(b.userId));
}

function splitEqual(totalPaise: number, userIds: string[]): ShareDraft[] {
  if (userIds.length === 0) {
    throw new BadRequestError("EQUAL split needs at least one userId");
  }
  const sorted = [...new Set(userIds)].sort();
  if (sorted.length !== userIds.length) {
    throw new BadRequestError("EQUAL split userIds must be unique");
  }
  const chunks = splitEqualPaise(totalPaise, sorted.length);
  return sorted.map((userId, i) => ({
    userId,
    amountPaise: chunks[i]!,
    shares: 1,
    basisPoints: null,
  }));
}

function splitExact(
  totalPaise: number,
  shares: { userId: string; amountPaise: number }[],
): ShareDraft[] {
  if (shares.length === 0) {
    throw new BadRequestError("EXACT split needs at least one share");
  }
  const sorted = dedupeAndSort(shares);
  let sum = 0;
  for (const s of sorted) {
    if (!Number.isInteger(s.amountPaise) || s.amountPaise < 0) {
      throw new BadRequestError(
        `Share for ${s.userId} must be a non-negative integer paise`,
      );
    }
    sum += s.amountPaise;
  }
  if (sum !== totalPaise) {
    throw new BadRequestError(
      `EXACT shares sum to ${sum} but total is ${totalPaise}`,
    );
  }
  return sorted.map((s) => ({
    userId: s.userId,
    amountPaise: s.amountPaise,
    shares: 1,
    basisPoints: null,
  }));
}

function splitPercentage(
  totalPaise: number,
  shares: { userId: string; basisPoints: number }[],
): ShareDraft[] {
  if (shares.length === 0) {
    throw new BadRequestError("PERCENTAGE split needs at least one share");
  }
  const sorted = dedupeAndSort(shares);
  let bpSum = 0;
  for (const s of sorted) {
    if (!Number.isInteger(s.basisPoints) || s.basisPoints < 0) {
      throw new BadRequestError(
        `basisPoints for ${s.userId} must be a non-negative integer`,
      );
    }
    bpSum += s.basisPoints;
  }
  if (bpSum !== 10_000) {
    throw new BadRequestError(
      `PERCENTAGE shares sum to ${bpSum} bp; expected 10000 (=100%)`,
    );
  }
  // Compute integer paise per share, distribute remainder to leading rows
  // so the total matches exactly.
  const raw = sorted.map((s) =>
    Math.floor((totalPaise * s.basisPoints) / 10_000),
  );
  let remainder = totalPaise - raw.reduce((a, b) => a + b, 0);
  return sorted.map((s, i) => {
    const add = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder--;
    return {
      userId: s.userId,
      amountPaise: raw[i]! + add,
      shares: 1,
      basisPoints: s.basisPoints,
    };
  });
}

/**
 * Constraint (dietary/category) split.
 *
 * Algorithm:
 *  1. For each item, decide which participants are *eligible* (tags satisfy
 *     allow if present; never violate deny). Split the item's paise equally
 *     across eligible participants; distribute the remainder to leading
 *     userIds (sorted) so the sum stays exact.
 *  2. Each participant's "subtotal" is the sum of item slices they got.
 *  3. Distribute `commonItemsPaise` (tax + tips + service) proportionally
 *     over subtotals; remainder absorbed by leading userIds.
 *  4. Validate the totals match what the caller asked for.
 */
function splitConstraint(input: ConstraintInput): ShareDraft[] {
  if (input.participants.length === 0) {
    throw new BadRequestError("CONSTRAINT split needs at least one participant");
  }
  const sortedParticipants = [...input.participants].sort((a, b) =>
    a.userId.localeCompare(b.userId),
  );
  const ids = sortedParticipants.map((p) => p.userId);
  if (new Set(ids).size !== ids.length) {
    throw new BadRequestError("CONSTRAINT participants must be unique");
  }

  const eligible = (
    p: { allow?: string[]; deny?: string[] },
    itemTags: string[],
  ): boolean => {
    if (p.deny && p.deny.some((t) => itemTags.includes(t))) return false;
    if (!p.allow || p.allow.length === 0) return true;
    return p.allow.some((t) => itemTags.includes(t));
  };

  const subtotals = new Map<string, number>();
  for (const id of ids) subtotals.set(id, 0);
  let itemSum = 0;

  for (const item of input.items) {
    if (!Number.isInteger(item.totalPaise) || item.totalPaise < 0) {
      throw new BadRequestError(
        `Item ${item.name ?? "?"} totalPaise must be a non-negative integer`,
      );
    }
    const consumers = sortedParticipants.filter((p) => eligible(p, item.tags));
    if (consumers.length === 0) {
      throw new BadRequestError(
        `Item ${item.name ?? "?"} has tags [${item.tags.join(",")}] but no participant is eligible`,
      );
    }
    const chunks = splitProportionalPaise(
      item.totalPaise,
      consumers.map(() => 1),
    );
    consumers.forEach((p, i) => {
      subtotals.set(p.userId, (subtotals.get(p.userId) ?? 0) + chunks[i]!);
    });
    itemSum += item.totalPaise;
  }

  const common = input.commonItemsPaise ?? 0;
  if (common < 0 || !Number.isInteger(common)) {
    throw new BadRequestError("commonItemsPaise must be a non-negative integer");
  }
  if (itemSum + common !== input.totalPaise) {
    throw new BadRequestError(
      `CONSTRAINT split inconsistent: items sum (${itemSum}) + common (${common}) != totalPaise (${input.totalPaise})`,
    );
  }

  // Distribute common charges over per-person subtotals. If subtotals sum
  // to zero (degenerate — no items), split common equally.
  const subtotalArr = ids.map((id) => subtotals.get(id) ?? 0);
  const subtotalSum = subtotalArr.reduce((s, n) => s + n, 0);
  let commonChunks: number[];
  if (common === 0) {
    commonChunks = ids.map(() => 0);
  } else if (subtotalSum === 0) {
    commonChunks = splitProportionalPaise(common, ids.map(() => 1));
  } else {
    commonChunks = splitProportionalPaise(common, subtotalArr);
  }

  return ids.map((userId, i) => ({
    userId,
    amountPaise: subtotalArr[i]! + commonChunks[i]!,
    shares: 1,
    basisPoints: null,
  }));
}

/**
 * Split `totalPaise` proportionally by `weights`. sum(parts) === total even
 * when the proportion doesn't divide cleanly. Remainder is absorbed by the
 * leading indices.
 */
function splitProportionalPaise(totalPaise: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => Math.floor((totalPaise * w) / sum));
  let remainder = totalPaise - raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => {
    const add = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder--;
    return r + add;
  });
}

export const __test__ = { splitProportionalPaise };

function splitShares(
  totalPaise: number,
  shares: { userId: string; shares: number }[],
): ShareDraft[] {
  if (shares.length === 0) {
    throw new BadRequestError("SHARES split needs at least one share");
  }
  const sorted = dedupeAndSort(shares);
  let unitSum = 0;
  for (const s of sorted) {
    if (!Number.isInteger(s.shares) || s.shares <= 0) {
      throw new BadRequestError(
        `share units for ${s.userId} must be a positive integer`,
      );
    }
    unitSum += s.shares;
  }
  // Same remainder-distribution trick as percentage mode.
  const raw = sorted.map((s) => Math.floor((totalPaise * s.shares) / unitSum));
  let remainder = totalPaise - raw.reduce((a, b) => a + b, 0);
  return sorted.map((s, i) => {
    const add = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder--;
    return {
      userId: s.userId,
      amountPaise: raw[i]! + add,
      shares: s.shares,
      basisPoints: null,
    };
  });
}
