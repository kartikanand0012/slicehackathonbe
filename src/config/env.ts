import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().url().or(z.string().startsWith("postgres")),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("30d"),

  ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),

  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  UPLOAD_DIR: z.string().default("./uploads"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().max(50).default(10),

  AI_PROVIDER_PRIORITY: z.string().optional(),

  // Anthropic direct
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_RECEIPT_MODEL: z.string().optional(),
  CLAUDE_INTENT_MODEL: z.string().optional(),

  // AWS Bedrock (Claude on Bedrock). Standard AWS SDK env vars apply.
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_SESSION_TOKEN: z.string().optional(),
  BEDROCK_RECEIPT_MODEL_ID: z.string().optional(),
  BEDROCK_INTENT_MODEL_ID: z.string().optional(),

  // OpenAI (legacy)
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env: Env = loadEnv();
