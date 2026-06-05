/**
 * Mock provider — always available, returns deterministic canned data. Used
 * for development, tests, and as the last-resort fallback when no real
 * provider is configured. Implements both ReceiptExtractor and IntentParser
 * so the whole pipeline can be exercised offline.
 *
 * The intent mock implements a tiny rule-based pseudo-parser so the basic
 * demo utterances ("split this bill with @kartik, @sukant, @mohit — mohit veg")
 * produce a structurally-valid CONSTRAINT intent. It is NOT a replacement for
 * a real model — just enough to keep the contract honest in CI / locally.
 */

import type {
  AiHealth,
  ExtractInput,
  IntentParser,
  ParseIntentInput,
  ParseIntentResult,
  ParsedIntent,
  ReceiptExtractor,
  ToolCall,
} from "../types";

// Re-exported under the old name so legacy imports keep working.
export { MockProvider as MockReceiptExtractor };

export class MockProvider implements ReceiptExtractor, IntentParser {
  readonly name = "mock";

  isConfigured(): boolean {
    return true;
  }

  async health(): Promise<AiHealth> {
    return { ok: true, detail: "mock provider is always healthy" };
  }

  async extract(_input: ExtractInput): ReturnType<ReceiptExtractor["extract"]> {
    const extracted = {
      merchantName: "Cafe Bistro",
      occurredAt: new Date().toISOString(),
      currency: "INR" as const,
      subtotalPaise: 84_500,
      taxPaise: 4_225,
      tipPaise: 8_450,
      totalPaise: 97_175,
      items: [
        {
          name: "Veg Pizza",
          quantity: 1,
          unitPaise: 45_000,
          totalPaise: 45_000,
          tags: ["veg", "main"],
        },
        {
          name: "Chicken Tikka",
          quantity: 1,
          unitPaise: 28_500,
          totalPaise: 28_500,
          tags: ["non-veg", "main"],
        },
        {
          name: "Iced Latte",
          quantity: 2,
          unitPaise: 5_500,
          totalPaise: 11_000,
          tags: ["veg", "beverage"],
        },
      ],
    };
    return { extracted, raw: { provider: "mock" } };
  }

  async parseIntent(input: ParseIntentInput): Promise<ParseIntentResult> {
    const trace: ParseIntentResult["toolCallTrace"] = [];
    const utterance = input.utterance.toLowerCase();
    const mentions = Array.from(input.utterance.matchAll(/@([\w.\-]+)/g)).map(
      (m) => m[1]!,
    );

    // Resolve each mention via the runner.
    const resolved: string[] = [];
    for (const m of mentions) {
      const call: ToolCall = {
        id: `mock_${m}`,
        name: "resolve_mention",
        input: { mention: `@${m}`, scope: "any" },
      };
      const result = await input.toolRunner(call);
      trace.push({ call, result });
      const match = (
        result.content as { match?: { id?: string } | null }
      )?.match;
      if (match?.id) resolved.push(match.id);
    }

    // Mock can answer two intents: CREATE_EXPENSE (with optional CONSTRAINT)
    // and QUERY_BALANCE. Anything else returns REJECT so callers fail loudly.
    if (utterance.includes("how much") || utterance.includes("balance")) {
      const groupsCall: ToolCall = {
        id: "mock_groups",
        name: "get_my_groups",
        input: {},
      };
      const groupsRes = await input.toolRunner(groupsCall);
      trace.push({ call: groupsCall, result: groupsRes });
      const firstGroupId =
        input.scope.contextGroupId ??
        (groupsRes.content as { groups?: { id: string }[] }).groups?.[0]?.id;
      if (!firstGroupId) {
        return {
          intent: { type: "REJECT", reason: "No group context for balance query" },
          raw: { provider: "mock" },
          toolCallTrace: trace,
        };
      }
      const intent: ParsedIntent = {
        type: "QUERY_BALANCE",
        groupId: firstGroupId,
        explanation: "Show current balances for the group.",
      };
      return { intent, raw: { provider: "mock" }, toolCallTrace: trace };
    }

    if (utterance.includes("split") && input.scope.contextReceiptId) {
      const itemsCall: ToolCall = {
        id: "mock_items",
        name: "get_receipt_items",
        input: { receiptId: input.scope.contextReceiptId },
      };
      const itemsRes = await input.toolRunner(itemsCall);
      trace.push({ call: itemsCall, result: itemsRes });

      const receipt = (
        itemsRes.content as {
          receipt?: {
            totalPaise: number;
            subtotalPaise: number | null;
            taxPaise: number | null;
            tipPaise: number | null;
            items: { name: string; totalPaise: number; tags: string[] }[];
          };
        }
      ).receipt;
      if (!receipt) {
        return {
          intent: {
            type: "REJECT",
            reason: "Could not load receipt for CONSTRAINT split",
          },
          raw: { provider: "mock" },
          toolCallTrace: trace,
        };
      }

      const items = receipt.items.map((it) => ({
        name: it.name,
        totalPaise: it.totalPaise,
        tags: it.tags?.length ? it.tags : ["other"],
      }));
      const itemsSum = items.reduce((s, it) => s + it.totalPaise, 0);
      const commonItemsPaise = Math.max(0, receipt.totalPaise - itemsSum);

      // Constrain by trailing keyword "veg" applied to the last mention.
      const constraints: { userId: string; allow?: string[] }[] = resolved.map(
        (uid) => ({ userId: uid }),
      );
      if (constraints.length > 0 && /veg/.test(utterance)) {
        constraints[constraints.length - 1]!.allow = ["veg", "beverage"];
      }

      const intent: ParsedIntent = {
        type: "CREATE_EXPENSE",
        groupId: input.scope.contextGroupId ?? "",
        title: receipt.totalPaise ? "Receipt" : "Expense",
        amountPaise: receipt.totalPaise,
        paidById: input.scope.callerUserId,
        receiptId: input.scope.contextReceiptId,
        split: {
          mode: "CONSTRAINT",
          items,
          participants: constraints,
          commonItemsPaise,
        },
        explanation:
          "Mock plan — last mentioned person gets only veg/beverage items.",
      };
      return { intent, raw: { provider: "mock" }, toolCallTrace: trace };
    }

    return {
      intent: {
        type: "REJECT",
        reason: "Mock provider only handles 'split this bill' and balance queries.",
      },
      raw: { provider: "mock" },
      toolCallTrace: trace,
    };
  }
}
