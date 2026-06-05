/**
 * Anthropic-direct provider — implements both ReceiptExtractor and
 * IntentParser using the official @anthropic-ai/sdk. Selected when
 * ANTHROPIC_API_KEY is set.
 *
 * Cost-aware routing: receipt extraction uses the fast model
 * (CLAUDE_RECEIPT_MODEL, default claude-3-5-haiku) and intent parsing —
 * which fans out tool calls — uses the deep model (CLAUDE_INTENT_MODEL,
 * default claude-3-5-sonnet).
 */

import Anthropic from "@anthropic-ai/sdk";
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
import { RECEIPT_EXTRACTION_SYSTEM_PROMPT } from "../prompts/receipt-extraction";
import {
  INTENT_PARSER_EXAMPLES,
  INTENT_PARSER_SYSTEM_PROMPT,
} from "../prompts/intent-parser";

const DEFAULT_RECEIPT_MODEL = "claude-3-5-haiku-20241022";
const DEFAULT_INTENT_MODEL = "claude-3-5-sonnet-20241022";

export class AnthropicProvider implements ReceiptExtractor, IntentParser {
  readonly name = "anthropic";
  private readonly client: Anthropic | null;
  private readonly receiptModel: string;
  private readonly intentModel: string;

  constructor() {
    const key = process.env.ANTHROPIC_API_KEY;
    this.client = key ? new Anthropic({ apiKey: key }) : null;
    this.receiptModel = process.env.CLAUDE_RECEIPT_MODEL ?? DEFAULT_RECEIPT_MODEL;
    this.intentModel = process.env.CLAUDE_INTENT_MODEL ?? DEFAULT_INTENT_MODEL;
  }

  isConfigured(): boolean {
    return Boolean(this.client);
  }

  async health(): Promise<AiHealth> {
    if (!this.client) return { ok: false, detail: "ANTHROPIC_API_KEY not set" };
    try {
      await this.client.messages.create({
        model: this.receiptModel,
        max_tokens: 8,
        messages: [{ role: "user", content: "ping" }],
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async extract(input: ExtractInput): ReturnType<ReceiptExtractor["extract"]> {
    if (!this.client) throw new Error("Anthropic provider not configured");
    const mediaType = isSupportedImage(input.mimeType)
      ? input.mimeType
      : "image/jpeg";
    const response = await this.client.messages.create({
      model: this.receiptModel,
      max_tokens: 2048,
      system: RECEIPT_EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: input.imageBuffer.toString("base64"),
              },
            },
            {
              type: "text",
              text: input.hint
                ? `Extract the receipt. Hint from user: ${input.hint}`
                : "Extract the receipt.",
            },
          ],
        },
      ],
    });

    const text = textOf(response);
    const json = extractJsonBlock(text);
    return { extracted: json as never, raw: response };
  }

  async parseIntent(input: ParseIntentInput): Promise<ParseIntentResult> {
    if (!this.client) throw new Error("Anthropic provider not configured");
    return runToolLoop(
      this.client,
      this.intentModel,
      input,
      this.name,
    );
  }
}

// ─── Helpers (shared with the Bedrock provider via re-import) ──────────

export function isSupportedImage(mime: string): boolean {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime);
}

export function textOf(response: Anthropic.Message): string {
  const block = response.content.find((c) => c.type === "text");
  return (block as Anthropic.TextBlock | undefined)?.text ?? "";
}

export function extractJsonBlock(text: string): unknown {
  // Strip any ```json fences the model sometimes adds despite instructions.
  const cleaned = text
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: find the first {...} or [...] in the text.
    const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) throw new Error(`Could not parse JSON from model output: ${text.slice(0, 200)}`);
    return JSON.parse(match[0]);
  }
}

export async function runToolLoop(
  client: Anthropic,
  model: string,
  input: ParseIntentInput,
  providerName: string,
): Promise<ParseIntentResult> {
  const maxRounds = input.maxRounds ?? 8;
  const trace: ParseIntentResult["toolCallTrace"] = [];

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `${INTENT_PARSER_EXAMPLES}\n\nScope: ${JSON.stringify(input.scope)}\nUser utterance (${input.source}): ${input.utterance}`,
        },
      ],
    },
  ];

  const tools: Anthropic.Tool[] = input.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));

  for (let round = 0; round < maxRounds; round++) {
    const resp = await client.messages.create({
      model,
      max_tokens: 4096,
      system: INTENT_PARSER_SYSTEM_PROMPT,
      tools,
      messages,
    });

    const toolUses = resp.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
    );

    if (toolUses.length === 0 || resp.stop_reason === "end_turn") {
      const text = textOf(resp);
      let intent: ParsedIntent;
      try {
        intent = extractJsonBlock(text) as ParsedIntent;
      } catch (e) {
        throw new Error(`Model returned no tool calls and no parseable JSON: ${(e as Error).message}`);
      }
      return { intent, raw: resp, toolCallTrace: trace, modelId: model };
    }

    // Run every tool use in parallel, then append a single user-turn with
    // all the results.
    const toolResults = await Promise.all(
      toolUses.map(async (tu) => {
        const call: ToolCall = {
          id: tu.id,
          name: tu.name,
          input: (tu.input as Record<string, unknown>) ?? {},
        };
        const result = await input.toolRunner(call);
        trace.push({ call, result });
        return { tu, result };
      }),
    );

    messages.push({ role: "assistant", content: resp.content });
    messages.push({
      role: "user",
      content: toolResults.map(({ tu, result }) => ({
        type: "tool_result" as const,
        tool_use_id: tu.id,
        content: JSON.stringify(result.content),
        is_error: result.isError === true,
      })),
    });
  }

  throw new Error(
    `Intent parsing exceeded ${maxRounds} tool-use rounds (provider=${providerName})`,
  );
}
