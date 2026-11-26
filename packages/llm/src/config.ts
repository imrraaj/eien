import { errorText, type Env } from "@eien/shared";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/** One model the operator lists under a provider. */
export interface ModelConfig {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
}

/** One OpenAI-compatible endpoint and the models it serves. */
export interface ProviderConfig {
    name?: string;
    baseUrl: string;
    /** Literal key; keep this file private. Prefer `apiKeyEnv` to keep secrets in `.env`. */
    apiKey?: string;
    /** Environment variable read when `apiKey` is absent. */
    apiKeyEnv?: string;
    headers?: Record<string, string>;
    models: ModelConfig[];
}

/** `models.json`: the provider catalog and the startup selection. */
export interface ModelsFile {
    /** `provider/model-id`, used until `/setmodel` (or the selection file) overrides it. */
    selected?: string;
    providers: Record<string, ProviderConfig>;
}

/** A fully qualified model reference. */
export interface ModelSelection {
    provider: string;
    modelId: string;
    /** `provider/model-id`; model ids may themselves contain slashes. */
    ref: string;
}

export interface ModelCatalogEntry extends ModelSelection {
    name: string;
}

const modelSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    reasoning: z.boolean().optional(),
});

const providerSchema = z.object({
    name: z.string().trim().min(1).optional(),
    baseUrl: z.string().trim().url(),
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z.string().trim().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    models: z.array(modelSchema).min(1),
});

const modelsFileSchema = z.object({
    selected: z.string().trim().min(1).optional(),
    providers: z.record(z.string().trim().min(1), providerSchema),
});

const selectionFileSchema = z.object({ selected: z.string().trim().min(1) });

/** Where the provider catalog lives: `$MODELS_PATH`, else `<state>/models.json`. */
export function modelsPath(env: Env): string {
    return env.MODELS_PATH ?? join(env.STATE_DIR, "models.json");
}

/** Where `/setmodel` persists the active model: `$MODEL_SELECTION_PATH`, else `<state>/model.json`. */
export function selectionPath(env: Env): string {
    return env.MODEL_SELECTION_PATH ?? join(env.STATE_DIR, "model.json");
}

function readJson(path: string): unknown {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error(`Could not read ${path}: ${errorText(error)}`);
    }
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`${path} is not valid JSON: ${errorText(error)}`);
    }
}

function formatIssues(path: string, error: z.ZodError): string {
    return error.issues.map((issue) => `  ${path}: ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
}

/** Read and validate `models.json`; undefined when the file does not exist. */
export function loadModelsFile(path: string): ModelsFile | undefined {
    const raw = readJson(path);
    if (raw === undefined) return undefined;
    const parsed = modelsFileSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid model config in ${path}:\n${formatIssues(path, parsed.error)}`);
    return parsed.data;
}

/** Read the persisted `/setmodel` choice; undefined when missing or unreadable. */
export function loadSelectionFile(path: string): string | undefined {
    const raw = readJson(path);
    if (raw === undefined) return undefined;
    const parsed = selectionFileSchema.safeParse(raw);
    return parsed.success ? parsed.data.selected : undefined;
}

function writeJsonAtomic(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
}

/** Persist the active model without rewriting the provider catalog (and its keys). */
export function saveSelection(path: string, ref: string): void {
    writeJsonAtomic(path, { selected: ref });
}

export function refOf(provider: string, modelId: string): string {
    return `${provider}/${modelId}`;
}

/**
 * Resolve what the operator typed against the catalog. Accepts the full
 * `provider/model` ref, a bare model id, or a unique trailing segment (useful
 * for OpenRouter ids that already look like `vendor/model`).
 */
export function resolveSelection(input: string, catalog: readonly ModelCatalogEntry[]): ModelSelection | undefined {
    const wanted = input.trim();
    if (wanted === "") return undefined;

    const matches = (test: (entry: ModelCatalogEntry) => boolean) => catalog.filter(test);
    const pick = (found: ModelCatalogEntry[]) => {
        const entry = found[0];
        return entry ? { provider: entry.provider, modelId: entry.modelId, ref: entry.ref } : undefined;
    };
    const lower = wanted.toLowerCase();

    for (const test of [
        (entry: ModelCatalogEntry) => entry.ref === wanted,
        (entry: ModelCatalogEntry) => entry.ref.toLowerCase() === lower,
        (entry: ModelCatalogEntry) => entry.modelId === wanted,
        (entry: ModelCatalogEntry) => entry.modelId.toLowerCase() === lower,
        (entry: ModelCatalogEntry) => entry.ref.endsWith(`/${wanted}`),
        (entry: ModelCatalogEntry) => entry.ref.toLowerCase().endsWith(`/${lower}`),
    ]) {
        const found = matches(test);
        if (found.length === 1) return pick(found);
        if (found.length > 1) {
            // Ambiguous shorthand: only an exact ref (handled above) disambiguates.
            return undefined;
        }
    }
    return undefined;
}
