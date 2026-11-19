import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@earendil-works/pi-ai";
import { runTool, type ToolContext } from "./index.ts";

function call(name: string, args: Record<string, string>): ToolCall {
  return { type: "toolCall", id: "call-1", name, arguments: args };
}

function context(sendFile?: ToolContext["sendFile"]): ToolContext {
  return {
    sandbox: { name: "test" },
    root: "/work",
    web: { mcpUrl: "https://example.invalid/mcp" },
    sendFile,
  };
}

describe("send_file", () => {
  test("resolves the path inside the workspace and hands it to the sender", async () => {
    const seen: Array<{ path: string; caption?: string }> = [];
    const result = await runTool(
      call("send_file", { path: "out/report.pdf", caption: "  done  " }),
      context(async (file) => {
        seen.push(file);
        return "sent report.pdf";
      }),
    );

    expect(result).toEqual({ text: "sent report.pdf", isError: false });
    expect(seen).toEqual([{ path: "/work/out/report.pdf", caption: "done" }]);
  });

  test("accepts absolute paths inside the workspace", async () => {
    const result = await runTool(
      call("send_file", { path: "/work/clip.mp4" }),
      context(async () => "sent clip.mp4"),
    );
    expect(result.isError).toBe(false);
  });

  test("rejects paths that escape the workspace", async () => {
    const result = await runTool(
      call("send_file", { path: "../../etc/passwd" }),
      context(async () => "should not run"),
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("escapes the workspace");
  });

  test("reports when file sending is unavailable", async () => {
    const result = await runTool(call("send_file", { path: "a.txt" }), context());
    expect(result).toEqual({
      text: "sending files is not available in this chat",
      isError: true,
    });
  });
});
