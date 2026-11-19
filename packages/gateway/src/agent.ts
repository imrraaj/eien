import type { Llm, Message, Tool, ToolCall } from "@eien/llm";

export interface AgentTurnResult {
  messages: Message[];
  text: string;
}

export interface AgentTurnOptions {
  llm: Pick<Llm, "complete">;
  messages: Message[];
  system: string;
  tools: Tool[];
  maxSteps: number;
  timeoutMs: number;
  sessionId: string;
  executeTool: (call: ToolCall) => Promise<{ text: string; isError: boolean }>;
  /** Called before a tool runs, for "still working" signals. */
  onToolStart?: (call: ToolCall) => void;
  onToolCall?: (call: ToolCall, result: { isError: boolean; ms: number }) => void;
}

export function assistantText(message: Message): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

export function assistantToolCalls(message: Message): ToolCall[] {
  if (message.role !== "assistant") return [];
  return message.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
}

/** Run one user turn: model call → tool calls → repeat until the model answers. */
export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const working = [...options.messages];

  for (let step = 0; step < options.maxSteps; step += 1) {
    const assistant = await options.llm.complete({
      kind: "main",
      system: options.system,
      messages: working,
      tools: options.tools,
      signal: AbortSignal.timeout(options.timeoutMs),
      sessionId: options.sessionId,
    });

    working.push(assistant);

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      throw new Error(
        assistant.errorMessage ??
          `model call ended with stop reason "${assistant.stopReason}"`,
      );
    }

    const calls = assistantToolCalls(assistant);
    if (calls.length === 0) {
      return { messages: working, text: assistantText(assistant) };
    }

    for (const call of calls) {
      const startedAt = Date.now();
      options.onToolStart?.(call);
      const result = await options.executeTool(call);
      working.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
        timestamp: Date.now(),
      });
      options.onToolCall?.(call, {
        isError: result.isError,
        ms: Date.now() - startedAt,
      });
    }
  }

  const last = working.at(-1);
  const lastText = last ? assistantText(last) : "";
  const notice = `(stopped after ${options.maxSteps} tool steps; send another message to continue)`;

  // Ask for a summary without tools so the turn ends with useful information.
  try {
    const summary = await options.llm.complete({
      kind: "main",
      system: `${options.system}\n\nYou have reached the ${options.maxSteps}-step tool limit. Do not call tools. Summarize what you learned, what failed, and the single next action the user should take.`,
      messages: working,
      tools: [],
      signal: AbortSignal.timeout(options.timeoutMs),
      sessionId: options.sessionId,
    });
    working.push(summary);

    if (summary.stopReason !== "error" && summary.stopReason !== "aborted") {
      const text = assistantText(summary);
      if (text) return { messages: working, text };
    }
  } catch {
    // Fall through to the static notice.
  }

  return { messages: working, text: lastText ? `${lastText}\n\n${notice}` : notice };
}
