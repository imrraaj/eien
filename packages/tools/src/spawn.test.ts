import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@earendil-works/pi-ai";
import { runSpawnTool } from "./spawn.ts";
import type { SpawnContext } from "./spawn.ts";

function call(args: Record<string, string | number>): ToolCall {
  return { type: "toolCall", id: "spawn-1", name: "spawn_agent", arguments: args };
}

const context = (spawnAgent?: SpawnContext["spawnAgent"]): SpawnContext => ({
  root: "/work",
  spawnAgent,
});

describe("spawn_agent", () => {
  test("passes the resolved cwd and clamped steps to the runner", async () => {
    let seen: unknown;
    const result = await runSpawnTool(call({ task: "do it", cwd: "repo", maxSteps: 500 }), {
      root: "/work",
      spawnAgent: async (input) => {
        seen = input;
        return "done";
      },
    });

    expect(result).toEqual({ text: "done", isError: false });
    expect(seen).toEqual({ task: "do it", cwd: "/work/repo", maxSteps: 80 });
  });

  test("defaults cwd to the workspace root", async () => {
    let cwd: string | undefined;
    await runSpawnTool(call({ task: "x" }), context(async (input) => {
      cwd = input.cwd;
      return "ok";
    }));
    expect(cwd).toBe("/work");
  });

  test("rejects an escaping cwd", async () => {
    const result = await runSpawnTool(
      call({ task: "x", cwd: "../etc" }),
      context(async () => "unused"),
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("escapes the workspace");
  });

  test("rejects an empty task", async () => {
    const result = await runSpawnTool(call({ task: "  " }), context(async () => "x"));
    expect(result).toEqual({ text: "task must not be empty", isError: true });
  });

  test("reports when workers are unavailable", async () => {
    const result = await runSpawnTool(call({ task: "x" }), context());
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not available");
  });

  test("surfaces runner failures", async () => {
    const result = await runSpawnTool(
      call({ task: "x" }),
      context(async () => {
        throw new Error("boom");
      }),
    );
    expect(result).toEqual({ text: "worker failed: boom", isError: true });
  });
});
