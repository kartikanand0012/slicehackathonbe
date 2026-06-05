/**
 * Money utilities for SliceSplit.
 *
 * All amounts are stored as Int paise (1 INR = 100 paise) to avoid
 * floating-point drift. These helpers are the only place where paise
 * touches floats — keep them small and well-tested.
 */

export const PAISE_PER_RUPEE = 100;

export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) {
    throw new RangeError(`rupeesToPaise: non-finite input ${rupees}`);
  }
  return Math.round(rupees * PAISE_PER_RUPEE);
}

export function paiseToRupees(paise: number): number {
  return paise / PAISE_PER_RUPEE;
}

export function formatRupees(paise: number): string {
  const rupees = paiseToRupees(paise);
  return rupees.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Split `totalPaise` into `parts` near-equal integer chunks. The remainder
 * is distributed one paise at a time to the leading chunks so the parts
 * always sum exactly to totalPaise.
 *
 *   splitEqualPaise(1000, 3) -> [334, 333, 333]
 *   splitEqualPaise(1001, 3) -> [334, 334, 333]
 */
export function splitEqualPaise(totalPaise: number, parts: number): number[] {
  if (!Number.isInteger(totalPaise) || !Number.isInteger(parts) || parts <= 0) {
    throw new RangeError(
      `splitEqualPaise: invalid inputs total=${totalPaise} parts=${parts}`,
    );
  }
  const base = Math.floor(totalPaise / parts);
  const remainder = totalPaise - base * parts;
  return Array.from({ length: parts }, (_, i) => (i < remainder ? base + 1 : base));
}
