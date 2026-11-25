import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import type { Address, FeedEvent, OutboundMessage } from "../../packages/io/src/index.ts";
import { createModelsRegistry, createLlm } from "../../packages/llm/src/index.ts";
import type { Sandbox } from "../../packages/sandbox/src/index.ts";
import { createLogger, loadEnv } from "../../packages/shared/src/index.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRuntime, type AgentRuntime } from "../../packages/agent/src/runtime.ts";
import { MemoryStore } from "../../packages/agent/src/memory.ts";

/** OpenAI-compatible endpoint that streams "echo: <last user message>" and records each request. */
function fakeModelServer() {
    const requests: Array<{ model?: string; messages: Array<{ role: string; content: unknown }> }> = [];
    const server = Bun.serve({
        port: 0,
        async fetch(request) {
            const body = (await request.json()) as (typeof requests)[number];
            requests.push(body);
            const last = [...body.messages].reverse().find((message) => message.role === "user");
            const text = `echo: ${typeof last?.content === "string" ? last.content : JSON.stringify(last?.content)}`;
            const chunk = (delta: object, finish: string | null) =>
                `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
            const usage = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`;
            return new Response(
                chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + usage + "data: [DONE]\n\n",
                { headers: { "content-type": "text/event-stream" } },
            );
        },
    });
    return { server, requests };
}

const sandbox: Sandbox = {
    driver: "fake",
    name: "fake",
    root: "/work",
    exec: async () => ({ output: "", exitCode: 0, timedOut: false, truncated: false }),
    copyIn: async () => Result.ok(undefined),
    copyOut: async () => Result.ok(undefined),
};

function recordingOutbox() {
    const sent: Array<[Address, OutboundMessage]> = [];
    const waiters: Array<() => void> = [];
    return {
        sent,
        outbox: {
            send: async (to: Address, message: OutboundMessage) => {
                sent.push([to, message]);
                for (const wake of waiters.splice(0)) wake();
                return Result.ok(undefined);
            },
        },
        /** Resolve once a message matching `predicate` has been sent. */
        async until(predicate: (message: OutboundMessage) => boolean): Promise<void> {
            while (!sent.some(([, message]) => predicate(message))) {
                await Promise.race([
                    new Promise<void>((resolve) => waiters.push(resolve)),
                    Bun.sleep(5_000).then(() => {
                        throw new Error(`timed out; sent: ${JSON.stringify(sent)}`);
                    }),
                ]);
            }
        },
    };
}

describe("agent runtime", () => {
    let dir: string;
    const model = fakeModelServer();
    const chat: Address = { service: "test", chat: "1" };

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), "eien-runtime-"));
    });
    afterAll(async () => {
        model.server.stop(true);
        await rm(dir, { recursive: true, force: true });
    });

    async function open(
        outbox: ReturnType<typeof recordingOutbox>["outbox"],
        memoryPath?: string,
    ): Promise<AgentRuntime> {
        const env = loadEnv({
            LLM_BASE_URL: `http://localhost:${model.server.port}/v1`,
            LLM_API_KEY: "x",
            MODEL_MAIN: "fake",
            MODELS_PATH: join(dir, "models.json"),
        });
        return createAgentRuntime({
            storagePath: join(dir, "eien.sqlite"),
            models: createModelsRegistry(env),
            model: { provider: "eien", modelId: "fake" },
            maxTurns: 5,
            sandbox,
            web: { mcpUrl: "http://localhost:1" },
            outbox,
            memory: memoryPath ? new MemoryStore(memoryPath) : undefined,
            instructions: (service, memoryText) =>
                `test prompt for ${service}${memoryText ? `\n\n<memory>${memoryText}</memory>` : ""}`,
            log: createLogger({ level: (process.env.TEST_LOG as "debug") ?? "error" }),
        });
    }

    test("answers a prompt and brackets it with working and idle", async () => {
        const out = recordingOutbox();
        const runtime = await open(out.outbox);
        await runtime.prompt(chat, "hello", "req-1");
        await out.until((message) => message.kind === "status" && message.status === "idle");
        await runtime.close();

        expect(out.sent.map(([, message]) => message)).toEqual([
            { kind: "status", status: "working" },
            { kind: "text", text: "echo: hello", entry: expect.any(Number) },
            { kind: "status", status: "idle" },
        ]);
        expect(model.requests[0]?.messages[0]?.role).toBe("system");
        expect(String(model.requests[0]?.messages[0]?.content)).toContain("test prompt for test");
    });

    test("a restart keeps the chat's conversation and does not resend delivered answers", async () => {
        const out = recordingOutbox();
        const runtime = await open(out.outbox);
        await Bun.sleep(100);
        expect(out.sent).toEqual([]);

        await runtime.prompt(chat, "again", "req-2");
        await out.until((message) => message.kind === "status" && message.status === "idle");
        await runtime.close();

        expect(out.sent.filter(([, message]) => message.kind === "text")).toEqual([
            [chat, { kind: "text", text: "echo: again", entry: expect.any(Number) }],
        ]);
        const history = model.requests.at(-1)!.messages.map((message) => message.role);
        expect(history).toEqual(["system", "user", "assistant", "user"]);
    });

    test("a repeated request id is admitted once", async () => {
        const out = recordingOutbox();
        const runtime = await open(out.outbox);
        const before = model.requests.length;
        await runtime.prompt(chat, "again", "req-2");
        await out.until((message) => message.kind === "status" && message.status === "idle");
        await runtime.close();
        expect(model.requests.length).toBe(before);
    });

    test("setModel points open conversations at the new model", async () => {
        const baseUrl = `http://localhost:${model.server.port}/v1`;
        const path = join(dir, "models-switch.json");
        await writeFile(
            path,
            JSON.stringify({
                selected: "one/fake",
                providers: {
                    one: { baseUrl, apiKey: "x", models: [{ id: "fake" }] },
                    two: { baseUrl, apiKey: "x", models: [{ id: "other" }] },
                },
            }),
        );
        const env = loadEnv({ MODELS_PATH: path, MODEL_SELECTION_PATH: join(dir, "switch-model.json") });
        const llm = createLlm(env);
        const out = recordingOutbox();
        const runtime = await createAgentRuntime({
            storagePath: join(dir, "switch.sqlite"),
            models: llm.models,
            model: llm.selection,
            maxTurns: 5,
            sandbox,
            web: { mcpUrl: "http://localhost:1" },
            outbox: out.outbox,
            instructions: (service) => `test prompt for ${service}`,
            log: createLogger({ level: "error" }),
        });

        await runtime.prompt(chat, "first", "switch-1");
        await out.until((message) => message.kind === "status" && message.status === "idle");
        await runtime.setModel({ provider: "two", modelId: "other" });
        await runtime.prompt(chat, "second", "switch-2");
        await out.until((message) => message.kind === "text" && message.text === "echo: second");
        await runtime.close();

        expect(model.requests.at(-1)?.model).toBe("other");
    });

    test("injects current memory and refreshes it before the next run", async () => {
        const memoryPath = join(dir, "memory-prompt.md");
        await writeFile(memoryPath, "likes Bun");
        const out = recordingOutbox();
        const runtime = await open(out.outbox, memoryPath);

        await runtime.prompt(chat, "first memory", "memory-1");
        await out.until((message) => message.kind === "text" && message.text === "echo: first memory");
        expect(String(model.requests.at(-1)?.messages[0]?.content)).toContain("likes Bun");

        await writeFile(memoryPath, "likes TypeScript");
        await runtime.prompt(chat, "second memory", "memory-2");
        await out.until((message) => message.kind === "text" && message.text === "echo: second memory");
        const system = String(model.requests.at(-1)?.messages[0]?.content);
        expect(system).toContain("likes TypeScript");
        expect(system).not.toContain("likes Bun");

        await runtime.close();
    });

    test("prefixes a shared-chat message with its sender", async () => {
        const out = recordingOutbox();
        const runtime = await open(out.outbox, join(dir, "memory-author.md"));

        await runtime.prompt(chat, "who am I?", "author-1", [], {
            author: { id: "42", name: "Ada Lovelace", username: "ada" },
        });
        await out.until((message) => message.kind === "text" && message.text.includes("who am I?"));
        const user = [...(model.requests.at(-1)?.messages ?? [])].reverse().find((message) => message.role === "user");
        expect(String(user?.content)).toContain("[sender: Ada Lovelace (@ada), user id: 42]");

        await runtime.close();
    });

    test("the feed pages history and streams new items and live state", async () => {
        const out = recordingOutbox();
        const runtime = await open(out.outbox);
        const feed: Address = { service: "test", chat: "feed" };

        await runtime.prompt(feed, "first", "feed-1");
        await out.until((message) => message.kind === "status" && message.status === "idle");
        const page = await runtime.history(feed);
        expect(page.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
        expect(page.before).toBeUndefined();

        const events: FeedEvent[] = [];
        const newest = page.items.at(-1)!.id;
        const stop = await runtime.subscribe(feed, newest, (event) => events.push(event));
        while (events.length === 0) await Bun.sleep(5);
        await runtime.prompt(feed, "second", "feed-2");
        await out.until((message) => message.kind === "text" && message.text === "echo: second");
        await Bun.sleep(50);
        await stop();
        await runtime.close();

        const items = events.flatMap((event) => (event.kind === "items" ? event.items : []));
        expect(items.map((item) => [item.kind, "text" in item ? item.text : ""])).toEqual([
            ["user", "second"],
            ["assistant", "echo: second"],
        ]);
        const lives = events.flatMap((event) => (event.kind === "live" ? [event.live.busy] : []));
        expect(lives[0]).toBe(false);
        expect(lives).toContain(true);
        expect(lives.at(-1)).toBe(false);

        // A one-item page reports where to continue.
        const older = await (await open(recordingOutbox().outbox)).history(feed, { limit: 1 });
        expect(older.items).toHaveLength(1);
        expect(older.before).toBeNumber();
    });
});
