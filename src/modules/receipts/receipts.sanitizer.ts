/**
 * Sanitize raw AI provider output before it touches the database.
 *
 * Hard guarantees:
 *  - All money fields are non-negative integers.
 *  - `items[].totalPaise === quantity * unitPaise` (quantity coerced to >= 1).
 *  - `totalPaise >= sum(items.totalPaise)` — if the model under-reports the
 *    total we trust the line items.
 *  - Tags are filtered against a closed set so a hallucinated label can't
 *    break a downstream CONSTRAINT split.
 */

import { ALLOWED_TAGS, type ItemTag } from "@/ai/tools/definitions";
import type { ExtractedReceipt, ReceiptLineItem } from "@/ai/types";

const ALLOWED_TAG_SET = new Set<string>(ALLOWED_TAGS);

export type SanitizationResult = {
  receipt: ExtractedReceipt;
  warnings: string[];
};

export function sanitizeExtractedReceipt(raw: unknown): SanitizationResult {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Receipt extraction returned non-object payload");
  }
  const r = raw as Record<string, unknown>;
  const warnings: string[] = [];

  const items = sanitizeItems(r.items, warnings);
  const itemSum = items.reduce((s, it) => s + it.totalPaise, 0);

  const subtotal = pickNonNegInt(r.subtotalPaise);
  const tax = pickNonNegInt(r.taxPaise);
  const tip = pickNonNegInt(r.tipPaise);
  let total = pickNonNegInt(r.totalPaise) ?? 0;

  if (total < itemSum) {
    warnings.push(
      `totalPaise (${total}) was less than item sum (${itemSum}); promoting to item sum`,
    );
    total = itemSum + (tax ?? 0) + (tip ?? 0);
  }

  const occurredAt =
    typeof r.occurredAt === "string" && /\d{4}-\d{2}-\d{2}/.test(r.occurredAt)
      ? r.occurredAt
      : null;

  return {
    receipt: {
      merchantName:
        typeof r.merchantName === "string" ? r.merchantName.slice(0, 120) : null,
      occurredAt,
      currency: "INR",
      subtotalPaise: subtotal ?? null,
      taxPaise: tax ?? null,
      tipPaise: tip ?? null,
      totalPaise: total,
      items,
    },
    warnings,
  };
}

function sanitizeItems(raw: unknown, warnings: string[]): ReceiptLineItem[] {
  if (!Array.isArray(raw)) {
    warnings.push("items[] missing or not an array — defaulting to empty");
    return [];
  }
  const out: ReceiptLineItem[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const i = item as Record<string, unknown>;
    const name =
      typeof i.name === "string" && i.name.trim().length > 0
        ? i.name.trim().slice(0, 120)
        : null;
    if (!name) continue;
    const quantity = Math.max(
      1,
      Math.round(typeof i.quantity === "number" ? i.quantity : 1),
    );
    const unitPaise = Math.max(0, pickNonNegInt(i.unitPaise) ?? 0);
    let totalPaise = pickNonNegInt(i.totalPaise) ?? unitPaise * quantity;
    if (totalPaise !== unitPaise * quantity) {
      warnings.push(
        `Item "${name}": totalPaise (${totalPaise}) != qty*unit (${unitPaise * quantity}); using qty*unit`,
      );
      totalPaise = unitPaise * quantity;
    }
    const tags = Array.isArray(i.tags)
      ? (i.tags
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.toLowerCase())
          .filter((t) => ALLOWED_TAG_SET.has(t)) as ItemTag[])
      : [];
    out.push({ name, quantity, unitPaise, totalPaise, tags });
  }
  return out;
}

function pickNonNegInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n < 0 ? 0 : n;
}
