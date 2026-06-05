import type { AiHealth, ExtractInput, ReceiptExtractor } from "../types";
import { RECEIPT_EXTRACTION_SYSTEM_PROMPT } from "../prompts/receipt-extraction";

/**
 * OpenAI-backed receipt extractor. Uses the chat/completions vision endpoint
 * with JSON-mode response. Implemented with `fetch` (Node 20+) — no SDK
 * dependency, so the build stays slim if the user never enables this provider.
 *
 * Activation: set `OPENAI_API_KEY`. Model defaults to `gpt-4o-mini` and can
 * be overridden via `OPENAI_MODEL`.
 */
export class OpenAiReceiptExtractor implements ReceiptExtractor {
  readonly name = "openai";

  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly endpoint = "https://api.openai.com/v1/chat/completions";

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY;
    this.model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async health(): Promise<AiHealth> {
    if (!this.apiKey) return { ok: false, detail: "OPENAI_API_KEY not set" };
    // We don't burn tokens on a real call here — just check the models list.
    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      return { ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async extract(input: ExtractInput): ReturnType<ReceiptExtractor["extract"]> {
    if (!this.apiKey) {
      throw new Error("OpenAI provider not configured (OPENAI_API_KEY missing)");
    }
    const base64 = input.imageBuffer.toString("base64");
    const dataUrl = `data:${input.mimeType};base64,${base64}`;

    const body = {
      model: this.model,
      response_format: { type: "json_object" as const },
      temperature: 0,
      messages: [
        { role: "system", content: RECEIPT_EXTRACTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: input.hint
                ? `Hint from user: ${input.hint}\nExtract the receipt.`
                : "Extract the receipt.",
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    };

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`OpenAI extract failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    const raw = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content: string | undefined = raw?.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned no content");

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("OpenAI returned non-JSON content");
    }
    return { extracted: parsed as ReturnType<typeof JSON.parse>, raw };
  }
}
