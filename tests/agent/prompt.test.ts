import { describe, expect, test } from "bun:test";
import { MAX_INJECTED_MEMORY_BYTES, buildInstructions, loadSoul } from "../../packages/agent/src/prompt.ts";

describe("system prompt", () => {
    test("ships the persona separately from the operating manual", async () => {
        const soul = await loadSoul();
        expect(soul).toContain("You are eien");
        expect(soul).not.toContain("## Environment");
    });

    test("orders base, memory, then the service hint", () => {
        const prompt = buildInstructions("PERSONA\n\nMANUAL", "TELEGRAM", "likes Bun");

        expect(prompt.indexOf("PERSONA")).toBeLessThan(prompt.indexOf("## Memory contents"));
        expect(prompt).toContain("<memory>\nlikes Bun\n</memory>");
        expect(prompt).toContain("## This chat\nTELEGRAM");
        expect(prompt.indexOf("</memory>")).toBeLessThan(prompt.indexOf("## This chat"));
    });

    test("omits the memory block when memory is empty", () => {
        expect(buildInstructions("BASE", "HINT", "  ")).not.toContain("## Memory contents");
    });

    test("caps the injected memory and points at memory_read", () => {
        const prompt = buildInstructions("BASE", undefined, "x".repeat(MAX_INJECTED_MEMORY_BYTES + 100));

        expect(prompt).toContain("memory truncated");
        expect(prompt).toContain("memory_read");
        expect(prompt.length).toBeLessThan(MAX_INJECTED_MEMORY_BYTES + 500);
    });
});
