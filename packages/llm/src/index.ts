import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Env } from "@eien/shared";
import { generateText, type ModelMessage } from "ai";

export type ModelKind = "main" | "worker" | "cheap";

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

/**
 * Resolve provider settings from env. Any OpenAI-compatible endpoint works:
 * set LLM_BASE_URL + LLM_API_KEY. OpenRouter is the default and its legacy
 * env names are still read as fallbacks.
 */
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
      ? { "HTTP-Referer": "https://localhost", "X-Title": "eien" }
      : {};

  return { baseURL, apiKey, headers };
}

export function resolveModelId(env: Env, kind: ModelKind = "main"): string {
  // The simple chat bot only needs one model; fall back to LLM_MODEL for main.
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

export interface ChatRequest {
  kind?: ModelKind;
  messages: ModelMessage[];
  /** Optional system prompt, applied ahead of `messages`. */
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export interface ChatUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}

export interface ChatResponse {
  text: string;
  model: string;
  finishReason: string;
  usage: ChatUsage;
}

export interface Llm {
  chat(request: ChatRequest): Promise<ChatResponse>;
  modelId(kind?: ModelKind): string;
}

/**
 * Thin provider-agnostic wrapper over the AI SDK. Kept deliberately small so
 * it can later run inside a Temporal activity without leaking provider detail.
 */
export function createLlm(env: Env): Llm {
  const settings = resolveLlmSettings(env);
  const provider = createOpenAICompatible({
    name: "eien",
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    headers: settings.headers,
  });

  return {
    modelId: (kind = "main") => resolveModelId(env, kind),
    async chat(request) {
      const kind = request.kind ?? "main";
      const model = resolveModelId(env, kind);

      const result = await generateText({
        model: provider(model),
        system: request.system,
        messages: request.messages,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        abortSignal: request.abortSignal,
      });

      return {
        text: result.text,
        model,
        finishReason: result.finishReason,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        },
      };
    },
  };
}

export type { ModelMessage } from "ai";
