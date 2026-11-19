import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Message, ToolCall } from "@eien/llm";
import { runAgentTurn } from "./agent.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "eien",
    model: "test/model",
    usage,
    stopReason,
    timestamp: 0,
  };
}

const user: Message = { role: "user", content: "hi", timestamp: 0 };

const toolCall: ToolCall = {
  type: "toolCall",
  id: "call-1",
  name: "bash",
  arguments: { command: "pwd" },
};

function fakeLlm(replies: AssistantMessage[]) {
  const seen: Message[][] = [];
  return {
    seen,
    llm: {
      async complete(request: { messages: Message[] }) {
        seen.push([...request.messages]);
        const next = replies.shift();
        if (!next) throw new Error("no reply left");
        return next;
      },
    },
  };
}

describe("runAgentTurn", () => {
  test("executes tool calls then returns the final text", async () => {
    const { llm, seen } = fakeLlm([
      assistant([toolCall]),
      assistant([{ type: "text", text: "all done" }]),
    ]);
    const executed: string[] = [];

    const result = await runAgentTurn({
      llm,
      messages: [user],
      system: "test",
      tools: [],
      maxSteps: 5,
      timeoutMs: 1_000,
      sessionId: "s",
      executeTool: async (call) => {
        executed.push(call.id);
        return { text: "exit code: 0\n/work", isError: false };
      },
    });

    expect(executed).toEqual(["call-1"]);
    expect(result.text).toBe("all done");
    expect(seen).toHaveLength(2);
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(result.messages[2]).toMatchObject({
      toolCallId: "call-1",
      toolName: "bash",
      isError: false,
    });
  });

  test("throws when the model turn fails", async () => {
    const { llm } = fakeLlm([assistant([], "error")]);
    await expect(
      runAgentTurn({
        llm,
        messages: [user],
        system: "test",
        tools: [],
        maxSteps: 5,
        timeoutMs: 1_000,
        sessionId: "s",
        executeTool: async () => ({ text: "", isError: false }),
      }),
    ).rejects.toThrow("stop reason");
  });

  test("summarizes progress at the step limit", async () => {
    const { llm } = fakeLlm([
      assistant([toolCall]),
      assistant([toolCall]),
      assistant([{ type: "text", text: "ran out of steps; next: check the API" }]),
    ]);
    const result = await runAgentTurn({
      llm,
      messages: [user],
      system: "test",
      tools: [],
      maxSteps: 2,
      timeoutMs: 1_000,
      sessionId: "s",
      executeTool: async () => ({ text: "ok", isError: false }),
    });
    expect(result.text).toContain("ran out of steps");
  });

  test("folds mid-turn messages into the next model call", async () => {
    const { llm, seen } = fakeLlm([
      assistant([toolCall]),
      assistant([{ type: "text", text: "done" }]),
    ]);

    const followUp: Message = { role: "user", content: "also rename it", timestamp: 1 };
    let delivered = false;

    const result = await runAgentTurn({
      llm,
      messages: [user],
      system: "test",
      tools: [],
      maxSteps: 5,
      timeoutMs: 1_000,
      sessionId: "s",
      takePending: () => {
        if (delivered) return [];
        delivered = true;
        return [followUp];
      },
      executeTool: async () => ({ text: "ok", isError: false }),
    });

    expect(seen[1]?.some((message) => message.content === "also rename it")).toBe(true);
    expect(result.messages.some((message) => message.content === "also rename it")).toBe(
      true,
    );
  });

  test("returns aborted when the signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const { llm } = fakeLlm([]);

    const result = await runAgentTurn({
      llm,
      messages: [user],
      system: "test",
      tools: [],
      maxSteps: 5,
      timeoutMs: 1_000,
      sessionId: "s",
      signal: controller.signal,
      executeTool: async () => ({ text: "", isError: false }),
    });

    expect(result.aborted).toBe(true);
  });
});
