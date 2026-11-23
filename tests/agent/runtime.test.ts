import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import type { Address, OutboundMessage } from "../../packages/io/src/index.ts";
import { createModelsRegistry } from "../../packages/llm/src/index.ts";
import type { Sandbox } from "../../packages/sandbox/src/index.ts";
import { createLogger, loadEnv } from "../../packages/shared/src/index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRuntime, type AgentRuntime } from "../../packages/agent/src/runtime.ts";

/** OpenAI-compatible endpoint that streams "echo: <last user message>" and records each request. */
function fakeModelServer() {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
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

    async function open(outbox: ReturnType<typeof recordingOutbox>["outbox"]): Promise<AgentRuntime> {
        const env = loadEnv({
            LLM_BASE_URL: `http://localhost:${model.server.port}/v1`,
            LLM_API_KEY: "x",
            MODEL_MAIN: "fake",
        });
        return createAgentRuntime({
            storagePath: join(dir, "eien.sqlite"),
            models: createModelsRegistry(env),
            modelId: "fake",
            maxTurns: 5,
            sandbox,
            web: { mcpUrl: "http://localhost:1" },
            outbox,
            instructions: (service) => `test prompt for ${service}`,
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
            { kind: "text", text: "echo: hello" },
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
            [chat, { kind: "text", text: "echo: again" }],
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
});
