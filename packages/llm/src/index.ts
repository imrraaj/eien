import type { Env } from "@eien/shared";
import {
  createModels,
  createProvider,
  type AssistantMessage,
  type Message,
  type Model,
  type Tool,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export type ModelKind = "main" | "worker" | "cheap";

const PROVIDER_ID = "eien";

const MODEL_ENV_VAR: Record<ModelKind, string> = {
  main: "MODEL_MAIN",
  worker: "MODEL_WORKER",
  cheap: "MODEL_CHEAP",
};

export interface LlmSettings {
  baseURL: string;
  apiKey: string;
  headers: Record<string, string>;
}

/** Resolve an OpenAI-compatible endpoint from env. OpenRouter is the default. */
export function resolveLlmSettings(env: Env): LlmSettings {
  const apiKey = env.LLM_API_KEY ?? env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No LLM API key configured. Set LLM_API_KEY (or OPENROUTER_API_KEY) in .env.",
    );
  }

  const baseURL = env.LLM_BASE_URL ?? env.OPENROUTER_BASE_URL;
  const headers: Record<string, string> =
    new URL(baseURL).hostname === "openrouter.ai"
      ? {
          "HTTP-Referer": "https://localhost",
          "X-Title": "eien",
          "X-OpenRouter-Title": "eien",
        }
      : {};

  return { baseURL, apiKey, headers };
}

export function resolveModelId(env: Env, kind: ModelKind = "main"): string {
  const id =
    kind === "main"
      ? (env.MODEL_MAIN ?? env.LLM_MODEL)
      : kind === "worker"
        ? env.MODEL_WORKER
        : env.MODEL_CHEAP;

  if (!id) {
    throw new Error(
      `No model configured for "${kind}". Set ${MODEL_ENV_VAR[kind]} in .env.`,
    );
  }
  return id;
}

function configuredModelIds(env: Env): string[] {
  const ids = [
    env.MODEL_MAIN ?? env.LLM_MODEL,
    env.MODEL_WORKER,
    env.MODEL_CHEAP,
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

export interface CompleteRequest {
  kind?: ModelKind;
  messages: Message[];
  system?: string;
  tools?: Tool[];
  temperature?: number;
  signal?: AbortSignal;
  sessionId?: string;
}

export interface Llm {
  complete(request: CompleteRequest): Promise<AssistantMessage>;
  modelId(kind?: ModelKind): string;
}

/**
 * pi-ai backed client for any OpenAI-compatible endpoint.
 * Each call is one model turn; the caller owns the tool loop and durability.
 */
export function createLlm(env: Env): Llm {
  const settings = resolveLlmSettings(env);

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
          resolve: async () => ({
            auth: { apiKey: settings.apiKey },
            source: "LLM_API_KEY",
          }),
        },
      },
      models: configuredModelIds(env).map(
        (id): Model<"openai-completions"> => ({
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
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
        }),
      ),
      api: openAICompletionsApi(),
    }),
  );

  const getModel = (kind: ModelKind): Model<"openai-completions"> => {
    const id = resolveModelId(env, kind);
    const model = models.getModel(PROVIDER_ID, id);
    if (!model) {
      throw new Error(
        `Model "${id}" is not configured in the provider catalog. Set a model env var.`,
      );
    }
    return model as Model<"openai-completions">;
  };

  return {
    modelId: (kind = "main") => resolveModelId(env, kind),
    async complete(request) {
      const kind = request.kind ?? "main";
      const model = getModel(kind);

      const message = await models.complete(
        model,
        {
          systemPrompt: request.system,
          messages: request.messages,
          tools: request.tools,
        },
        {
          signal: request.signal,
          temperature: request.temperature,
          maxTokens: env.LLM_MAX_TOKENS,
          sessionId: request.sessionId,
        },
      );

      return message;
    },
  };
}

export type {
  AssistantMessage,
  Message,
  Tool,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
