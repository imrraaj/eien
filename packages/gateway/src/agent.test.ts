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

  test("stops at the step limit", async () => {
    const { llm } = fakeLlm([
      assistant([toolCall]),
      assistant([toolCall]),
      assistant([toolCall]),
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
    expect(result.text).toContain("stopped after 2 tool steps");
  });
});
