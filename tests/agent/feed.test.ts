import { describe, expect, test } from "bun:test";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import { toFeedItem, toLiveState } from "../../packages/agent/src/feed.ts";

const entry = (id: number, kind: string, model: unknown[]): EntryRecord =>
    ({ id, conversationId: 1, kind, model }) as unknown as EntryRecord;

describe("toFeedItem", () => {
    test("maps user, assistant, tool, and reset entries", () => {
        expect(toFeedItem(entry(1, "pi.user", [{ role: "user", content: "hi", timestamp: 0 }]))).toEqual({
            kind: "user",
            id: 1,
            text: "hi",
        });
        expect(
            toFeedItem(
                entry(2, "pi.assistant", [
                    {
                        role: "assistant",
                        content: [
                            { type: "text", text: "Listing." },
                            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
                        ],
                    },
                ]),
            ),
        ).toEqual({
            kind: "assistant",
            id: 2,
            text: "Listing.",
            toolCalls: [{ id: "c1", name: "bash", args: '{"command":"ls"}' }],
        });
        expect(
            toFeedItem(
                entry(3, "pi.tool-result", [
                    {
                        role: "toolResult",
                        toolCallId: "c1",
                        toolName: "bash",
                        content: [{ type: "text", text: "a.txt" }],
                        isError: false,
                    },
                ]),
            ),
        ).toEqual({ kind: "tool", id: 3, callId: "c1", name: "bash", text: "a.txt", isError: false });
        expect(toFeedItem(entry(4, "pi.reset", []))).toEqual({ kind: "reset", id: 4 });
    });

    test("skips bookkeeping entries and clips long tool output", () => {
        expect(toFeedItem(entry(5, "pi.system", [{ role: "system", content: [] }]))).toBeUndefined();
        const long = toFeedItem(
            entry(6, "pi.tool-result", [
                {
                    role: "toolResult",
                    toolCallId: "c",
                    toolName: "bash",
                    content: [{ type: "text", text: "x".repeat(5_000) }],
                },
            ]),
        );
        expect(long?.kind === "tool" && long.text.length).toBeLessThan(4_100);
    });
});

describe("toLiveState", () => {
    test("idle when there is no live document", () => {
        expect(toLiveState(undefined)).toEqual({ busy: false, tools: [] });
    });

    test("carries the partial answer, running tools, retries, and failures", () => {
        const live = {
            run: { taskId: 1, inputs: [], turns: 0 },
            generation: {
                attempt: 2,
                message: { role: "assistant", content: [{ type: "text", text: "Half an ans" }] },
                retry: { at: 10, error: "overloaded" },
            },
            tools: [{ callId: "c1", name: "bash", status: "running", output: "building..." }],
            runFailure: { taskId: 1, inputs: [], reason: "model_error", detail: "boom" },
        } as unknown as LiveState;
        expect(toLiveState(live)).toEqual({
            busy: true,
            partial: "Half an ans",
            tools: [{ callId: "c1", name: "bash", status: "running", output: "building..." }],
            retry: { at: 10, error: "overloaded" },
            failure: { reason: "model_error", detail: "boom" },
        });
    });
});
