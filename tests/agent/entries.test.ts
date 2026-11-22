import { describe, expect, test } from "bun:test";
import { answerText, callsTools } from "../../packages/agent/src/entries.ts";

type Entry = Parameters<typeof answerText>[0];

const assistant = (content: unknown[]): Entry => ({ model: [{ role: "assistant", content }] }) as unknown as Entry;

describe("entries", () => {
    test("joins text blocks and ignores the rest", () => {
        const entry = assistant([
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "Hello " },
            { type: "text", text: "there " },
        ]);
        expect(answerText(entry)).toBe("Hello there");
        expect(callsTools(entry)).toBe(false);
    });

    test("detects tool calls", () => {
        const entry = assistant([
            { type: "text", text: "Checking." },
            { type: "toolCall", id: "1", name: "bash", arguments: {} },
        ]);
        expect(callsTools(entry)).toBe(true);
    });

    test("handles string content and missing entries", () => {
        expect(answerText({ model: [{ role: "user", content: "plain", timestamp: 0 }] } as Entry)).toBe("");
        expect(answerText(undefined)).toBe("");
        expect(callsTools(undefined)).toBe(false);
    });
});
