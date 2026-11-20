import { describe, expect, test } from "bun:test";
import { defaultSystemPrompt } from "./prompt.ts";

describe("defaultSystemPrompt", () => {
  test("includes the sandbox and workspace", () => {
    const prompt = defaultSystemPrompt("agent-1", "/work");
    expect(prompt).toContain('"agent-1"');
    expect(prompt).toContain("/work");
  });

  test("sets the brevity rules", () => {
    const prompt = defaultSystemPrompt("agent-1", "/work");
    expect(prompt).toContain("one or two sentences");
    expect(prompt).toContain("Do not restate the question");
    expect(prompt).toContain("No bullet lists");
  });

  test("sets the voice without identity slurs", () => {
    const prompt = defaultSystemPrompt("agent-1", "/work");
    expect(prompt).toContain("foul-mouthed");
    expect(prompt).toContain("no slurs about race");
  });
});
