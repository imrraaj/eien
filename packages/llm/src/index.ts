import type { Env } from "@eien/shared";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const PROVIDER_ID = "eien";

interface LlmSettings {
  baseURL: string;
  apiKey: string;
  headers: Record<string, string>;
}

/** Resolve an OpenAI-compatible endpoint from env. OpenRouter is the default. */
function resolveLlmSettings(env: Env): LlmSettings {
  const apiKey = env.LLM_API_KEY ?? env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("No LLM API key configured. Set LLM_API_KEY (or OPENROUTER_API_KEY) in .env.");

  const baseURL = env.LLM_BASE_URL ?? env.OPENROUTER_BASE_URL;
  const headers: Record<string, string> =
    new URL(baseURL).hostname === "openrouter.ai"
      ? { "HTTP-Referer": "https://localhost", "X-Title": "eien", "X-OpenRouter-Title": "eien" }
      : {};

  return { baseURL, apiKey, headers };
}

/** The model the agent runs on. */
export function resolveModelId(env: Env): string {
  const id = env.MODEL_MAIN ?? env.LLM_MODEL;
  if (!id) throw new Error("No model configured. Set MODEL_MAIN in .env.");
  return id;
}

/** pi-ai model registry with one provider: the configured OpenAI-compatible endpoint. */
export function createModelsRegistry(env: Env) {
  const settings = resolveLlmSettings(env);
  const id = resolveModelId(env);

  const models = createModels();
  models.setProvider(
    createProvider({
      id: PROVIDER_ID,
      name: "eien",
      baseUrl: settings.baseURL,
      headers: settings.headers,
      auth: {
        apiKey: {
          name: "LLM API key",
          resolve: async () => ({ auth: { apiKey: settings.apiKey }, source: "LLM_API_KEY" }),
        },
      },
      models: [
        {
          id,
          name: id,
          api: "openai-completions",
          provider: PROVIDER_ID,
          baseUrl: settings.baseURL,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: env.LLM_CONTEXT_WINDOW,
          maxTokens: env.LLM_MAX_TOKENS,
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        } satisfies Model<"openai-completions">,
      ],
      api: openAICompletionsApi(),
    }),
  );

  return models;
}
