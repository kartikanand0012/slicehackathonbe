/**
 * Two renderers for EXPLAIN_EXPENSE:
 *
 *   - `renderExplanationTemplate` — deterministic, never calls an LLM.
 *     Always works; what we used in PR 3.
 *   - `renderExplanationNarrated` — wraps the template + computed
 *     breakdown into a Claude / Bedrock prompt and returns the model's
 *     paraphrase. Falls back to the template if no provider is
 *     configured or the call fails — the engine numbers always survive.
 *
 * Per proposal §04: the engine is the source of truth; the AI is the
 * translator. This file is the boundary that enforces that rule — the
 * narrator never sees an editable money field.
 */

import { logger } from "@/lib/logger";
import { getIntentParser } from "@/ai/registry";
import { EXPLAIN_EXPENSE_SYSTEM_PROMPT } from "@/ai/prompts/explain-expense";

export type ExpenseExplainInput = {
  title: string;
  splitMode: string;
  amountPaise: number;
  paidByName: string;
  audienceName?: string;
  audienceShare?: number;
  shares: { name: string; amountPaise: number }[];
};

export function formatINR(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(paise / 100);
}

export function renderExplanationTemplate(input: ExpenseExplainInput): string {
  const lines = [
    `${input.title} (${input.splitMode.toLowerCase()} split) — total ${formatINR(input.amountPaise)} paid by ${input.paidByName}.`,
    ...input.shares.map(
      (s) => `  • ${s.name}: ${formatINR(s.amountPaise)}`,
    ),
  ];
  if (input.audienceName && typeof input.audienceShare === "number") {
    lines.push(`Your share: ${formatINR(input.audienceShare)}.`);
  }
  return lines.join("\n");
}

/**
 * AI-narrated variant. The model gets the computed breakdown only — never
 * raw inputs. On any failure (no provider, model error, empty response) we
 * silently fall back to the template so callers always get a string.
 */
export async function renderExplanationNarrated(
  input: ExpenseExplainInput,
): Promise<{ text: string; source: "template" | "model"; model?: string }> {
  const template = renderExplanationTemplate(input);

  // We piggy-back on the registry's IntentParser surface — provider already
  // has model selection + auth. Mock parser doesn't know how to narrate, so
  // we short-circuit to the template when mock is in front.
  const provider = getIntentParser();
  if (!provider.isConfigured() || provider.name === "mock") {
    return { text: template, source: "template" };
  }

  // Build a single user-turn that contains all the engine numbers. The
  // model paraphrases — no tool-use round-trip.
  const audienceClause = input.audienceName
    ? `Audience: ${input.audienceName} (their share: ${formatINR(input.audienceShare ?? 0)})`
    : "Audience: a generic group member";

  const userMessage = [
    `Title: ${input.title}`,
    `Split mode: ${input.splitMode}`,
    `Total: ${formatINR(input.amountPaise)} paid by ${input.paidByName}`,
    `Shares:`,
    ...input.shares.map((s) => `  - ${s.name}: ${formatINR(s.amountPaise)}`),
    audienceClause,
    `Now narrate this breakdown in 1–3 sentences of plain language.`,
  ].join("\n");

  try {
    // We reuse parseIntent's transport because both Anthropic + Bedrock
    // providers expose it; the system prompt and lack of tools steer the
    // model to plain text instead of an Intent. (For prod we could split
    // this into its own provider method; this works and keeps the
    // provider interface tight.)
    const result = await provider.parseIntent({
      utterance: userMessage,
      source: "chat",
      scope: { callerUserId: "narrator", callerName: "narrator" },
      tools: [], // no tool-use
      toolRunner: async () => ({ toolCallId: "n/a", content: {} }),
      maxRounds: 1,
    });
    // The intent parser returns a ParsedIntent; for narration we drop into
    // its `explanation` or REJECT.reason field which carries free text.
    const intent = result.intent;
    const text =
      "explanation" in intent && typeof intent.explanation === "string"
        ? intent.explanation
        : intent.type === "REJECT" && intent.reason
          ? intent.reason
          : "";
    if (text.trim().length === 0) {
      return { text: template, source: "template" };
    }
    return { text, source: "model", model: result.modelId };
  } catch (err) {
    logger.warn({ err }, "Explanation narrator failed; using template");
    return { text: template, source: "template" };
  }
}

// Re-export the system prompt so a future dedicated provider method can
// reuse it without importing the prompts module elsewhere.
export { EXPLAIN_EXPENSE_SYSTEM_PROMPT };
