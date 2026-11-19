import { z } from "zod";

/** Treat empty / whitespace-only env values as unset. */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const nonEmpty = z.string().trim().min(1);
const optionalNonEmpty = z.preprocess(emptyToUndefined, nonEmpty.optional());
const textWithDefault = (fallback: string) =>
  z.preprocess(emptyToUndefined, z.string().trim().min(1).default(fallback));
const intWithDefault = (fallback: number) =>
  z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(fallback),
  );

/** Comma-separated Telegram user IDs -> string[] (numeric IDs only). */
const telegramUserIds = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  )
  .pipe(
    z.array(z.string().regex(/^\d+$/, "must be a numeric Telegram user ID")),
  );

/**
 * Environment schema. Secrets stay optional so infrastructure-only processes
 * can start without them; each process validates the subset it needs at
 * startup (e.g. the gateway requires the Telegram token and an LLM key).
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_DIR: textWithDefault("logs"),

  TEMPORAL_ADDRESS: textWithDefault("localhost:7233"),
  TEMPORAL_NAMESPACE: textWithDefault("default"),
  TEMPORAL_TASK_QUEUE: textWithDefault("brain"),

  DATABASE_URL: textWithDefault(
    "postgres://agent:agent@localhost:5432/agent",
  ),

  // Any OpenAI-compatible endpoint. OpenRouter is the default, and the legacy
  // OPENROUTER_* names are still read as fallbacks.
  LLM_BASE_URL: optionalNonEmpty,
  LLM_API_KEY: optionalNonEmpty,
  LLM_MODEL: optionalNonEmpty,
  LLM_TIMEOUT_MS: intWithDefault(120_000),
  LLM_CONTEXT_WINDOW: intWithDefault(128_000),
  LLM_MAX_TOKENS: intWithDefault(8_192),
  OPENROUTER_API_KEY: optionalNonEmpty,
  OPENROUTER_BASE_URL: textWithDefault("https://openrouter.ai/api/v1"),

  MODEL_MAIN: optionalNonEmpty,
  MODEL_WORKER: optionalNonEmpty,
  MODEL_CHEAP: optionalNonEmpty,
  SYSTEM_PROMPT: optionalNonEmpty,

  TELEGRAM_BOT_TOKEN: optionalNonEmpty,
  ALLOWED_TELEGRAM_USER_IDS: telegramUserIds,

  SBX_NAME: textWithDefault("agent-1"),
  SBX_WORKDIR: textWithDefault("/work"),
  MAX_AGENT_STEPS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(100).default(100),
  ),
  MAX_CONCURRENT_WORKERS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(16).default(3),
  ),

  GOOGLE_CLI_BIN: optionalNonEmpty,
  GOOGLE_CLI_CONFIG_DIR: optionalNonEmpty,

  EXA_MCP_URL: textWithDefault("https://mcp.exa.ai/mcp"),
  EXA_API_KEY: optionalNonEmpty,
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validate process env and return a typed config object.
 * Throws on invalid config: a bad environment should fail fast at startup.
 */
export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
