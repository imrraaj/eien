import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../../packages/shared/src/index.ts";
import {
    createLlm,
    loadModelsFile,
    loadSelectionFile,
    resolveSelection,
    saveSelection,
    type ModelCatalogEntry,
} from "../../packages/llm/src/index.ts";

const catalog: ModelCatalogEntry[] = [
    {
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4.5",
        ref: "openrouter/anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
    },
    {
        provider: "openrouter",
        modelId: "openai/gpt-5.1",
        ref: "openrouter/openai/gpt-5.1",
        name: "GPT-5.1",
    },
    { provider: "local", modelId: "gpt-5.1", ref: "local/gpt-5.1", name: "gpt-5.1" },
];

describe("resolveSelection", () => {
    test("accepts a full ref", () => {
        expect(resolveSelection("openrouter/openai/gpt-5.1", catalog)?.ref).toBe("openrouter/openai/gpt-5.1");
    });

    test("accepts a unique bare id or trailing segment", () => {
        expect(resolveSelection("anthropic/claude-sonnet-4.5", catalog)?.provider).toBe("openrouter");
        expect(resolveSelection("local/gpt-5.1", catalog)?.provider).toBe("local");
    });

    test("refuses ambiguous shorthand", () => {
        const ambiguous: ModelCatalogEntry[] = [
            { provider: "a", modelId: "x", ref: "a/x", name: "x" },
            { provider: "b", modelId: "x", ref: "b/x", name: "x" },
        ];
        expect(resolveSelection("x", ambiguous)).toBeUndefined();
    });

    test("is case-insensitive", () => {
        expect(resolveSelection("OPENROUTER/OpenAI/GPT-5.1", catalog)?.ref).toBe("openrouter/openai/gpt-5.1");
    });

    test("ignores unknown models", () => {
        expect(resolveSelection("nope", catalog)).toBeUndefined();
    });
});

describe("model config", () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), "eien-llm-"));
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test("loads a valid catalog", async () => {
        const path = join(dir, "models.json");
        await writeFile(
            path,
            JSON.stringify({
                selected: "local/gpt-5.1",
                providers: {
                    local: {
                        baseUrl: "http://localhost:11434/v1",
                        apiKeyEnv: "LOCAL_KEY",
                        models: [{ id: "gpt-5.1" }],
                    },
                },
            }),
        );
        expect(loadModelsFile(path)?.providers.local?.models[0]?.id).toBe("gpt-5.1");
    });

    test("rejects an invalid catalog", async () => {
        const path = join(dir, "bad.json");
        await writeFile(path, JSON.stringify({ providers: { local: { models: [] } } }));
        expect(() => loadModelsFile(path)).toThrow(/Invalid model config/);
    });

    test("missing files are not an error", async () => {
        expect(loadModelsFile(join(dir, "missing.json"))).toBeUndefined();
    });

    test("persists and restores the selection", async () => {
        const path = join(dir, "model.json");
        saveSelection(path, "local/gpt-5.1");
        expect(loadSelectionFile(path)).toBe("local/gpt-5.1");
        expect((await readFile(path, "utf8")).includes("local/gpt-5.1")).toBe(true);
    });

    test("builds a registry and restores the saved model", async () => {
        const path = join(dir, "models.json");
        await writeFile(
            path,
            JSON.stringify({
                selected: "local/gpt-5.1",
                providers: {
                    local: {
                        baseUrl: "http://localhost:11434/v1",
                        apiKey: "x",
                        models: [{ id: "gpt-5.1" }, { id: "qwen3", name: "Qwen 3" }],
                    },
                    other: {
                        baseUrl: "http://localhost:8080/v1",
                        models: [{ id: "m" }],
                    },
                },
            }),
        );
        const env = loadEnv({ STATE_DIR: dir, MODELS_PATH: path });
        const llm = createLlm(env);
        expect(llm.catalog.map((entry) => entry.ref)).toEqual(["local/gpt-5.1", "local/qwen3", "other/m"]);
        expect(llm.selection.ref).toBe("local/gpt-5.1");
        expect(llm.models.getModels().map((model) => `${model.provider}/${model.id}`)).toEqual([
            "local/gpt-5.1",
            "local/qwen3",
            "other/m",
        ]);
    });
});
