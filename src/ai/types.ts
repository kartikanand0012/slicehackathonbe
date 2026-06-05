/**
 * Shared types for the AI layer.
 *
 * The two capabilities we expose are intentionally separate interfaces so a
 * provider can implement either or both:
 *
 *   - ReceiptExtractor  → vision OCR: image → ExtractedReceipt
 *   - IntentParser      → NL command: utterance + tools → ParsedIntent
 *
 * Receipt extraction never sees a user's full account context (only the
 * image). Intent parsing sees a tightly-scoped context bundle and may call
 * tools to fetch more.
 */

// ─── Receipt extraction ───────────────────────────────────

export type ReceiptLineItem = {
  name: string;
  quantity: number;
  unitPaise: number;
  totalPaise: number;
  /**
   * Tags the model attached at extraction time — used by CONSTRAINT split.
   * Examples: "veg", "non-veg", "alcohol", "dessert", "starter", "beverage".
   */
  tags?: string[];
};

export type ExtractedReceipt = {
  merchantName: string | null;
  occurredAt: string | null;
  currency: "INR";
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
  hint?: string;
};

export interface ReceiptExtractor {
  readonly name: string;
  isConfigured(): boolean;
  health(): Promise<AiHealth>;
  extract(input: ExtractInput): Promise<{
    extracted: ExtractedReceipt;
    raw: unknown;
  }>;
}

// ─── Intent parsing (tool-use) ────────────────────────────

/**
 * Provider-neutral tool definition. Each provider maps this onto its native
 * tool-use schema (Anthropic `tools[]`, Bedrock `toolConfig`, OpenAI
 * `tools[].function`, etc.).
 */
export type ToolDefinition = {
  name: string;
  description: string;
  // JSON Schema (draft-07 compatible).
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResult = {
  toolCallId: string;
  content: unknown; // serialised back to the model
  isError?: boolean;
};

/**
 * Discriminated union of every intent the command layer can execute. New
 * intents must be added here AND wired in `commands.executor`.
 */
export type ParsedIntent =
  | {
      type: "CREATE_GROUP";
      name: string;
      emoji?: string;
      memberUserIds: string[];
      explanation: string;
    }
  | {
      type: "ADD_MEMBERS";
      groupId: string;
      memberUserIds: string[];
      explanation: string;
    }
  | {
      type: "CREATE_EXPENSE";
      groupId: string;
      title: string;
      amountPaise: number;
      paidById: string;
      occurredAt?: string;
      receiptId?: string;
      split:
        | { mode: "EQUAL"; userIds: string[] }
        | { mode: "EXACT"; shares: { userId: string; amountPaise: number }[] }
        | { mode: "PERCENTAGE"; shares: { userId: string; basisPoints: number }[] }
        | { mode: "SHARES"; shares: { userId: string; shares: number }[] }
        | {
            mode: "CONSTRAINT";
            items: {
              name: string;
              totalPaise: number;
              tags: string[];
            }[];
            participants: {
              userId: string;
              allow?: string[];
              deny?: string[];
            }[];
            commonItemsPaise?: number; // tax / tip / service charge — proportionally distributed
          };
      explanation: string;
    }
  | {
      type: "CREATE_SETTLEMENT";
      groupId: string;
      fromId: string;
      toId: string;
      amountPaise: number;
      method?: string;
      explanation: string;
    }
  | {
      type: "QUERY_BALANCE";
      groupId: string;
      explanation: string;
    }
  | {
      type: "EXPLAIN_EXPENSE";
      expenseId: string;
      audienceUserId?: string;
      explanation: string;
    }
  | {
      type: "REJECT";
      reason: string;
    };

export type ParseIntentInput = {
  utterance: string;
  source: "voice" | "chat";
  /** Caller-controlled scope: a group/receipt the conversation is in. */
  scope: {
    callerUserId: string;
    callerName: string;
    contextGroupId?: string | null;
    contextReceiptId?: string | null;
  };
  /** Tools the provider must expose to the model. */
  tools: ToolDefinition[];
  /** Bridge that actually executes a tool the model invokes. */
  toolRunner: (call: ToolCall) => Promise<ToolResult>;
  /** Max tool-use rounds; provider must throw if exceeded. */
  maxRounds?: number;
};

export type ParseIntentResult = {
  intent: ParsedIntent;
  raw: unknown;
  toolCallTrace: { call: ToolCall; result: ToolResult }[];
  modelId?: string;
};

export interface IntentParser {
  readonly name: string;
  isConfigured(): boolean;
  parseIntent(input: ParseIntentInput): Promise<ParseIntentResult>;
}
