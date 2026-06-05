/**
 * AWS Bedrock provider — Claude models hosted on Bedrock. Implements both
 * ReceiptExtractor and IntentParser using the Bedrock Converse API, which
 * gives us native tool-use without parsing model-specific payload shapes.
 *
 * Activation: set AWS_REGION + Bedrock-capable credentials (env, profile, or
 * IAM role). Optional overrides:
 *   - BEDROCK_RECEIPT_MODEL_ID (default us.anthropic.claude-3-5-haiku-20241022-v1:0)
 *   - BEDROCK_INTENT_MODEL_ID  (default us.anthropic.claude-3-5-sonnet-20241022-v2:0)
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message as BedrockMessage,
  type Tool as BedrockTool,
} from "@aws-sdk/client-bedrock-runtime";
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
import { extractJsonBlock } from "./anthropic";

const DEFAULT_RECEIPT_MODEL =
  "us.anthropic.claude-3-5-haiku-20241022-v1:0";
const DEFAULT_INTENT_MODEL =
  "us.anthropic.claude-3-5-sonnet-20241022-v2:0";

export class BedrockProvider implements ReceiptExtractor, IntentParser {
  readonly name = "bedrock";
  private readonly client: BedrockRuntimeClient | null;
  private readonly receiptModelId: string;
  private readonly intentModelId: string;

  constructor() {
    // We instantiate the client unconditionally; the SDK throws lazily if
    // credentials aren't resolvable at request time.
    const region = process.env.AWS_REGION;
    this.client = region
      ? new BedrockRuntimeClient({ region })
      : null;
    this.receiptModelId =
      process.env.BEDROCK_RECEIPT_MODEL_ID ?? DEFAULT_RECEIPT_MODEL;
    this.intentModelId =
      process.env.BEDROCK_INTENT_MODEL_ID ?? DEFAULT_INTENT_MODEL;
  }

  isConfigured(): boolean {
    return Boolean(this.client);
  }

  async health(): Promise<AiHealth> {
    if (!this.client) return { ok: false, detail: "AWS_REGION not set" };
    try {
      await this.client.send(
        new ConverseCommand({
          modelId: this.receiptModelId,
          messages: [{ role: "user", content: [{ text: "ping" }] }],
          inferenceConfig: { maxTokens: 8 },
        }),
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async extract(input: ExtractInput): ReturnType<ReceiptExtractor["extract"]> {
    if (!this.client) throw new Error("Bedrock provider not configured");
    const format = mimeToFormat(input.mimeType);
    const resp = await this.client.send(
      new ConverseCommand({
        modelId: this.receiptModelId,
        system: [{ text: RECEIPT_EXTRACTION_SYSTEM_PROMPT }],
        messages: [
          {
            role: "user",
            content: [
              { image: { format, source: { bytes: input.imageBuffer } } },
              {
                text: input.hint
                  ? `Extract the receipt. Hint: ${input.hint}`
                  : "Extract the receipt.",
              },
            ],
          },
        ],
        inferenceConfig: { maxTokens: 2048, temperature: 0 },
      }),
    );

    const text =
      resp.output?.message?.content
        ?.map((c) => ("text" in c ? c.text : ""))
        .join("")
        .trim() ?? "";

    const json = extractJsonBlock(text);
    return { extracted: json as never, raw: resp };
  }

  async parseIntent(input: ParseIntentInput): Promise<ParseIntentResult> {
    if (!this.client) throw new Error("Bedrock provider not configured");
    return runBedrockToolLoop(
      this.client,
      this.intentModelId,
      input,
      this.name,
    );
  }
}

// ── Helpers ────────────────────────────────────────────────

type BedrockImageFormat = "jpeg" | "png" | "gif" | "webp";

function mimeToFormat(mime: string): BedrockImageFormat {
  const m = mime.toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  return "jpeg";
}

async function runBedrockToolLoop(
  client: BedrockRuntimeClient,
  modelId: string,
  input: ParseIntentInput,
  providerName: string,
): Promise<ParseIntentResult> {
  const maxRounds = input.maxRounds ?? 8;
  const trace: ParseIntentResult["toolCallTrace"] = [];

  const messages: BedrockMessage[] = [
    {
      role: "user",
      content: [
        {
          text: `${INTENT_PARSER_EXAMPLES}\n\nScope: ${JSON.stringify(input.scope)}\nUser utterance (${input.source}): ${input.utterance}`,
        },
      ],
    },
  ];

  const tools: BedrockTool[] = input.tools.map(
    (t) =>
      ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: {
            json: t.inputSchema as unknown as Record<string, unknown>,
          },
        },
      }) as unknown as BedrockTool,
  );

  for (let round = 0; round < maxRounds; round++) {
    const resp = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: INTENT_PARSER_SYSTEM_PROMPT }],
        messages,
        toolConfig: { tools },
        inferenceConfig: { maxTokens: 4096, temperature: 0 },
      }),
    );

    const assistantContent = resp.output?.message?.content ?? [];
    const toolUses = assistantContent.flatMap((c) =>
      "toolUse" in c && c.toolUse ? [c.toolUse] : [],
    );

    if (toolUses.length === 0 || resp.stopReason === "end_turn") {
      const text = assistantContent
        .map((c) => ("text" in c ? c.text : ""))
        .join("")
        .trim();
      let intent: ParsedIntent;
      try {
        intent = extractJsonBlock(text) as ParsedIntent;
      } catch (e) {
        throw new Error(`Model returned no tool calls and no parseable JSON: ${(e as Error).message}`);
      }
      return { intent, raw: resp, toolCallTrace: trace, modelId };
    }

    const toolResults = await Promise.all(
      toolUses.map(async (tu) => {
        const call: ToolCall = {
          id: tu.toolUseId!,
          name: tu.name!,
          input: (tu.input as Record<string, unknown>) ?? {},
        };
        const result = await input.toolRunner(call);
        trace.push({ call, result });
        return { tu, result };
      }),
    );

    messages.push({ role: "assistant", content: assistantContent });
    messages.push({
      role: "user",
      content: toolResults.map(
        ({ tu, result }) =>
          ({
            toolResult: {
              toolUseId: tu.toolUseId!,
              content: [{ json: result.content as Record<string, unknown> }],
              status: result.isError ? "error" : "success",
            },
          }) as unknown as ContentBlock,
      ),
    });
  }

  throw new Error(
    `Intent parsing exceeded ${maxRounds} tool-use rounds (provider=${providerName})`,
  );
}
