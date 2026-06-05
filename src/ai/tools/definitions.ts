/**
 * Tool definitions exposed to the AI for the NL command pipeline.
 *
 * Each tool has a stable name, a description (the model reads it to decide
 * when to call), and a JSON Schema for its inputs. The implementation lives
 * in `runner.ts` — definitions stay declarative so the same registry can
 * back any provider (Anthropic, Bedrock, OpenAI, future subagents).
 *
 * Design rule: tools query and *categorize* — they never mutate. Every
 * mutation goes through the executor after the user confirms a plan.
 */

import type { ToolDefinition } from "../types";

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_current_user",
    description:
      "Return the calling user's id, name, and known UPI handle. Use this when the utterance refers to 'me', 'I', 'my'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "resolve_mention",
    description:
      "Resolve a name, @handle, phone, or email mention to a single user. Returns the best match plus any ambiguous candidates. Use this for every person referenced in the utterance.",
    inputSchema: {
      type: "object",
      properties: {
        mention: {
          type: "string",
          description: "Raw mention as written (e.g. '@kartik', 'Mohit', '+919812345678').",
        },
        scope: {
          type: "string",
          enum: ["group", "contacts", "any"],
          description:
            "Where to search. 'group' searches only the current context group; 'contacts' searches the caller's contact book; 'any' tries both.",
        },
      },
      required: ["mention"],
      additionalProperties: false,
    },
  },
  {
    name: "get_my_groups",
    description: "List the caller's active groups (id, name, memberCount).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_group_members",
    description:
      "List active members of a group with id, name, and UPI handle. Use when the utterance targets a group and you need every member.",
    inputSchema: {
      type: "object",
      properties: { groupId: { type: "string" } },
      required: ["groupId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_my_contacts",
    description:
      "List the caller's contacts (address book). Useful for resolving mentions of people who aren't on the platform yet.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional case-insensitive search." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_receipt_items",
    description:
      "Fetch extracted line items for a receipt. Each item has name, totalPaise, and any tags the OCR step already attached.",
    inputSchema: {
      type: "object",
      properties: { receiptId: { type: "string" } },
      required: ["receiptId"],
      additionalProperties: false,
    },
  },
  {
    name: "categorize_items",
    description:
      "Classify a list of item names into dietary / category tags. Use this for CONSTRAINT splits when you need to decide which items can go to which participant (e.g. 'veg' people get only items tagged 'veg'). Return tags drawn from this closed set: 'veg', 'non-veg', 'alcohol', 'dessert', 'starter', 'main', 'beverage', 'other'.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
            required: ["name"],
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "get_recent_expenses",
    description:
      "Recent (non-deleted) expenses in a group. Useful when the utterance is time-scoped ('today', 'this week').",
    inputSchema: {
      type: "object",
      properties: {
        groupId: { type: "string" },
        withinDays: { type: "integer", minimum: 1, maximum: 90, default: 7 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["groupId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_group_balances",
    description:
      "Current per-member balances and minimum-transfer settle-up suggestions for a group. Use for QUERY_BALANCE intents.",
    inputSchema: {
      type: "object",
      properties: { groupId: { type: "string" } },
      required: ["groupId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_expense",
    description: "Fetch one expense (incl. shares) for EXPLAIN_EXPENSE intents.",
    inputSchema: {
      type: "object",
      properties: { expenseId: { type: "string" } },
      required: ["expenseId"],
      additionalProperties: false,
    },
  },
];

/** Stable tag set for categorize_items output. */
export const ALLOWED_TAGS = [
  "veg",
  "non-veg",
  "alcohol",
  "dessert",
  "starter",
  "main",
  "beverage",
  "other",
] as const;

export type ItemTag = (typeof ALLOWED_TAGS)[number];
