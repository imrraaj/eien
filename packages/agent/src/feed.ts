import type { EntryRecord, LiveState as DurableLive } from "@earendil-works/pi-durable";
import type { FeedItem, LiveState } from "@eien/io";
import { answerText } from "./entries.ts";

/** Tool results and outputs are cut here: the transcript is for reading, not for replaying. */
const MAX_TOOL_TEXT = 4_000;

type Message = NonNullable<EntryRecord["model"]>[number];

function clip(text: string, limit = MAX_TOOL_TEXT): string {
    return text.length <= limit ? text : `${text.slice(0, limit)}\n… [${text.length - limit} more characters]`;
}

function messageText(message: Message | undefined): string {
    if (!message) return "";
    if (typeof message.content === "string") return message.content;
    return message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
        .trim();
}

/** The feed item for a transcript entry, or `undefined` for bookkeeping entries a reader does not need. */
export function toFeedItem(entry: EntryRecord): FeedItem | undefined {
    const message = entry.model?.[0];
    switch (entry.kind) {
        case "pi.user":
            return { kind: "user", id: entry.id, text: messageText(message) };
        case "pi.assistant": {
            const blocks = message?.role === "assistant" ? message.content : [];
            const toolCalls = blocks.flatMap((block) =>
                block.type === "toolCall"
                    ? [{ id: block.id, name: block.name, args: JSON.stringify(block.arguments) }]
                    : [],
            );
            return { kind: "assistant", id: entry.id, text: answerText(entry), toolCalls };
        }
        case "pi.tool-result": {
            if (message?.role !== "toolResult") return undefined;
            return {
                kind: "tool",
                id: entry.id,
                callId: message.toolCallId,
                name: message.toolName,
                text: clip(messageText(message)),
                isError: message.isError === true,
            };
        }
        case "pi.reset":
            return { kind: "reset", id: entry.id };
        default:
            return undefined;
    }
}

/** What a viewer needs from pi-durable's live document. */
export function toLiveState(live: DurableLive | undefined): LiveState {
    const generation = live?.generation;
    const partial = generation?.message ? answerText({ model: [generation.message as Message] }) : "";
    return {
        busy: live?.run !== undefined,
        ...(partial ? { partial } : {}),
        tools: (live?.tools ?? []).map((tool) => ({
            callId: tool.callId,
            name: tool.name,
            status: tool.status,
            ...(tool.output ? { output: clip(tool.output) } : {}),
        })),
        ...(generation?.retry ? { retry: generation.retry } : {}),
        ...(live?.runFailure ? { failure: { reason: live.runFailure.reason, detail: live.runFailure.detail } } : {}),
    };
}
