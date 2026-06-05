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

export type SplitMode = "EQUAL" | "EXACT" | "PERCENTAGE" | "SHARES";

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

export type SplitInput =
  | EqualInput
  | ExactInput
  | PercentageInput
  | SharesInput;

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
