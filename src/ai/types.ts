/**
 * Shared types for the AI provider layer.
 *
 * The receipt-extraction contract is intentionally provider-agnostic:
 * everything an AI model returns goes through `ExtractedReceipt` so the
 * receipt module never needs to know which model produced the data.
 */

export type ReceiptLineItem = {
  name: string;
  quantity: number;
  unitPaise: number;
  totalPaise: number;
};

export type ExtractedReceipt = {
  merchantName: string | null;
  occurredAt: string | null; // ISO 8601, provider best-effort
  currency: "INR";           // we only accept INR receipts in this PR
  subtotalPaise: number | null;
  taxPaise: number | null;
  tipPaise: number | null;
  totalPaise: number;
  items: ReceiptLineItem[];
};

export type AiHealth = {
  ok: boolean;
  detail?: string;
};

export type ExtractInput = {
  imageBuffer: Buffer;
  mimeType: string;
  hint?: string; // optional caller-provided context (e.g. "split among 4 people")
};

export interface ReceiptExtractor {
  /** Stable id, e.g. "mock" / "openai" / "claude". */
  readonly name: string;
  /** True if this provider can be selected at runtime. */
  isConfigured(): boolean;
  /** Quick liveness check — no extraction. */
  health(): Promise<AiHealth>;
  /** Extract a structured receipt from an image. Throws on failure. */
  extract(input: ExtractInput): Promise<{
    extracted: ExtractedReceipt;
    raw: unknown; // raw provider response, for audit
  }>;
}
