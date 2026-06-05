/**
 * UPI deep-link generator.
 *
 * Produces a `upi://pay?...` URI that any UPI-enabled app on the user's phone
 * (PhonePe, GPay, Paytm, Slice, BHIM, etc.) will handle.
 *
 * Spec reference: NPCI common UPI URL spec — `pa`, `pn`, `am`, `cu`, `tn`, `tr`.
 *
 * Amount on the wire is in rupees with 2 decimal places, even though we store
 * paise everywhere internally — convert at the boundary.
 */

import { paiseToRupees } from "./money";

export type UpiIntentInput = {
  payeeVpa: string;       // e.g. "alice@okhdfc"
  payeeName: string;      // human-readable
  amountPaise: number;    // converted to rupees on the wire
  note?: string;          // shows up as the transaction note
  transactionRef?: string;// our internal id for reconciliation
};

const VPA_REGEX = /^[\w.\-]+@[\w]+$/;

export function isValidVpa(vpa: string): boolean {
  return VPA_REGEX.test(vpa);
}

export function buildUpiIntent(input: UpiIntentInput): string {
  if (!isValidVpa(input.payeeVpa)) {
    throw new RangeError(`Invalid UPI handle: ${input.payeeVpa}`);
  }
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new RangeError(`Invalid amountPaise: ${input.amountPaise}`);
  }

  const params = new URLSearchParams();
  params.set("pa", input.payeeVpa);
  params.set("pn", input.payeeName);
  params.set("am", paiseToRupees(input.amountPaise).toFixed(2));
  params.set("cu", "INR");
  if (input.note) params.set("tn", input.note);
  if (input.transactionRef) params.set("tr", input.transactionRef);

  return `upi://pay?${params.toString()}`;
}
