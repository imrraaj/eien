import { z } from "zod";

/** Treat empty / whitespace-only env values as unset. */
const emptyToUndefined = (value: unknown): unknown =>
    typeof value === "string" && value.trim() === "" ? undefined : value;

const nonEmpty = z.string().trim().min(1);
const optionalNonEmpty = z.preprocess(emptyToUndefined, nonEmpty.optional());
const textWithDefault = (fallback: string) =>
    z.preprocess(emptyToUndefined, z.string().trim().min(1).default(fallback));
const intWithDefault = (fallback: number) =>
    z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(fallback));

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
 * Environment schema. Secrets stay optional so infrastructure-only processes
 * can start without them; each process validates the subset it needs at
 * startup (e.g. the gateway requires the Telegram token and an LLM key).
 */
export const envSchema = z.object({
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    STATE_DIR: textWithDefault("state"),
    /** Control-plane memory file; defaults to STATE_DIR/memory.md. */
    MEMORY_PATH: optionalNonEmpty,
    MEMORY_MAX_BYTES: intWithDefault(64 * 1024),

    // Any OpenAI-compatible endpoint. OpenRouter is the default, and the legacy
    // OPENROUTER_* names are still read as fallbacks.
    LLM_BASE_URL: optionalNonEmpty,
    LLM_API_KEY: optionalNonEmpty,
    LLM_MODEL: optionalNonEmpty,
    LLM_CONTEXT_WINDOW: intWithDefault(128_000),
    LLM_MAX_TOKENS: intWithDefault(8_192),
    OPENROUTER_API_KEY: optionalNonEmpty,
    OPENROUTER_BASE_URL: textWithDefault("https://openrouter.ai/api/v1"),

    MODEL_MAIN: optionalNonEmpty,
    /** JSON provider catalog; defaults to `<STATE_DIR>/models.json`. */
    MODELS_PATH: optionalNonEmpty,
    /** Where `/setmodel` remembers the active model; defaults to `<STATE_DIR>/model.json`. */
    MODEL_SELECTION_PATH: optionalNonEmpty,
    SYSTEM_PROMPT: optionalNonEmpty,
    /** Persona file; defaults to the repo's prompts/SOUL.md. */
    SOUL_PATH: optionalNonEmpty,

    TELEGRAM_BOT_TOKEN: optionalNonEmpty,
    ALLOWED_TELEGRAM_USER_IDS: telegramUserIds,

    /** Enables the web app. Everyone with it is the same user; use a long random value. */
    WEB_ACCESS_TOKEN: z.preprocess(
        emptyToUndefined,
        z
            .string()
            .trim()
            .min(24, "must be at least 24 characters; generate one with `openssl rand -hex 24`")
            .optional(),
    ),
    WEB_HOST: textWithDefault("127.0.0.1"),
    /** Comma-separated public origins of the web app; required when a proxy rewrites the Host header. */
    WEB_ORIGIN: z
        .string()
        .default("")
        .transform((value) =>
            value
                .split(",")
                .map((origin) => origin.trim().replace(/\/+$/, ""))
                .filter(Boolean),
        )
        .pipe(z.array(z.url("must be an origin like https://eien.example.com"))),
    WEB_PORT: intWithDefault(8787),

    SBX_NAME: textWithDefault("agent-1"),
    SBX_WORKDIR: textWithDefault("/work"),
    /** "docker" for a persistent Linux container, "sbx" for Docker Sandboxes on KVM hosts. */
    SANDBOX_DRIVER: z.enum(["docker", "sbx"]).default("docker"),
    /** Image the Docker sandbox container runs; built by sandbox/bootstrap.sh. */
    SANDBOX_DOCKER_IMAGE: textWithDefault("eien/sandbox:local"),
    /** "bridge" keeps Docker networking; "none" isolates the sandbox. */
    SANDBOX_DOCKER_NETWORK: z.enum(["bridge", "none"]).default("bridge"),
    MAX_AGENT_STEPS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(100).default(100)),

    EXA_MCP_URL: textWithDefault("https://mcp.exa.ai/mcp"),
    EXA_API_KEY: optionalNonEmpty,
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validate process env and return a typed config object.
 * Throws on invalid config: a bad environment should fail fast at startup.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
    const parsed = envSchema.safeParse(source);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("\n");
        throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    return parsed.data;
}
