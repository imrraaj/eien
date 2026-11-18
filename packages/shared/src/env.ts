import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const optionalNonEmpty = nonEmpty.optional();

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
  .pipe(z.array(z.string().regex(/^\d+$/, "must be a numeric Telegram user ID")));

/**
 * Environment schema. Secrets stay optional for now so infrastructure-only
 * processes (compose smoke checks, tooling) can start without them. Each
 * process validates the subset it actually needs at startup in later phases.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("brain"),

  DATABASE_URL: z
    .string()
    .default("postgres://agent:agent@localhost:5432/agent"),

  OPENROUTER_API_KEY: optionalNonEmpty,
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  MODEL_MAIN: optionalNonEmpty,
  MODEL_WORKER: optionalNonEmpty,
  MODEL_CHEAP: optionalNonEmpty,

  TELEGRAM_BOT_TOKEN: optionalNonEmpty,
  ALLOWED_TELEGRAM_USER_IDS: telegramUserIds,

  SBX_NAME: z.string().default("agent-1"),
  MAX_CONCURRENT_WORKERS: z.coerce.number().int().min(1).max(16).default(3),

  GOOGLE_CLI_BIN: optionalNonEmpty,
  GOOGLE_CLI_CONFIG_DIR: optionalNonEmpty,
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
