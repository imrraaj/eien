import type { Env } from "@eien/shared";
import { createModels, createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
    loadModelsFile,
    loadSelectionFile,
    modelsPath,
    refOf,
    resolveSelection,
    saveSelection,
    selectionPath,
    type ModelCatalogEntry,
    type ModelConfig,
    type ModelSelection,
    type ProviderConfig,
} from "./config.ts";

export * from "./config.ts";

/** Provider id used for the legacy single-endpoint `.env` configuration. */
export const PROVIDER_ID = "eien";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function openRouterHeaders(baseURL: string): Record<string, string> {
    return new URL(baseURL).hostname === "openrouter.ai"
        ? { "HTTP-Referer": "https://localhost", "X-Title": "eien", "X-OpenRouter-Title": "eien" }
        : {};
}

function modelFromConfig(provider: string, baseUrl: string, model: ModelConfig, env: Env): Model<"openai-completions"> {
    return {
        id: model.id,
        name: model.name ?? model.id,
        api: "openai-completions",
        provider,
        baseUrl,
        reasoning: model.reasoning ?? false,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: model.contextWindow ?? env.LLM_CONTEXT_WINDOW,
        maxTokens: model.maxTokens ?? env.LLM_MAX_TOKENS,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    };
}

function apiKeyAuth(provider: string, config: ProviderConfig) {
    return {
        apiKey: {
            name: `${config.name ?? provider} API key`,
            resolve: async () => {
                const key = config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined);
                if (key === undefined) return { auth: {}, source: "keyless" };
                return { auth: { apiKey: key }, source: config.apiKeyEnv ?? "models.json" };
            },
        },
    };
}

/** The model the agent runs on when no JSON catalog is configured. */
export function resolveModelId(env: Env): string {
    const id = env.MODEL_MAIN ?? env.LLM_MODEL;
    if (!id) throw new Error("No model configured. Set MODEL_MAIN in .env, or create models.json.");
    return id;
}

export interface Llm {
    models: MutableModels;
    catalog: readonly ModelCatalogEntry[];
    /** The active model; `/setmodel` changes it. */
    readonly selection: ModelSelection;
    /** Switch the active model, or return undefined when nothing matches. */
    select(input: string): ModelSelection | undefined;
    /** Persist a selection so it survives restarts. */
    remember(selection: ModelSelection): void;
}

/**
 * Build the provider registry from `models.json` (or the legacy env endpoint)
 * and restore the persisted model choice.
 */
export function createLlm(env: Env): Llm {
    const filePath = modelsPath(env);
    const file = loadModelsFile(filePath);
    const models = createModels();
    const catalog: ModelCatalogEntry[] = [];

    if (file === undefined) {
        // No JSON catalog: keep the original single-provider env path working.
        const id = resolveModelId(env);
        const settings = resolveLlmSettings(env);
        const ref = refOf(PROVIDER_ID, id);
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
                models: [modelFromConfig(PROVIDER_ID, settings.baseURL, { id }, env)],
                api: openAICompletionsApi(),
            }),
        );
        catalog.push({ provider: PROVIDER_ID, modelId: id, ref, name: id });
    } else {
        for (const [providerId, config] of Object.entries(file.providers)) {
            const headers = config.headers ?? openRouterHeaders(config.baseUrl);
            models.setProvider(
                createProvider({
                    id: providerId,
                    name: config.name ?? providerId,
                    baseUrl: config.baseUrl,
                    headers,
                    auth: apiKeyAuth(providerId, config),
                    models: config.models.map((model) => modelFromConfig(providerId, config.baseUrl, model, env)),
                    api: openAICompletionsApi(),
                }),
            );
            for (const model of config.models) {
                catalog.push({
                    provider: providerId,
                    modelId: model.id,
                    ref: refOf(providerId, model.id),
                    name: model.name ?? model.id,
                });
            }
        }
        if (catalog.length === 0) throw new Error(`${filePath} has no providers with models.`);
    }

    const wanted = loadSelectionFile(selectionPath(env)) ?? file?.selected;
    const restored = wanted === undefined ? undefined : resolveSelection(wanted, catalog);
    let selection: ModelSelection = restored ?? catalog[0]!;

    return {
        models,
        catalog,
        get selection() {
            return selection;
        },
        select(input) {
            const next = resolveSelection(input, catalog);
            if (next !== undefined) selection = next;
            return next;
        },
        remember(next) {
            saveSelection(selectionPath(env), next.ref);
        },
    };
}

/** pi-ai model registry only; kept for callers that just need the provider collection. */
export function createModelsRegistry(env: Env): MutableModels {
    return createLlm(env).models;
}

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
    return { baseURL, apiKey, headers: openRouterHeaders(baseURL) };
}
