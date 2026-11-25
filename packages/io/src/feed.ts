/**
 * A read-only view of a conversation for clients that show the transcript (the web
 * app), as opposed to output services that only receive answers. Plain data, so a
 * client never depends on the agent's storage types.
 */

import type { Address } from "./types.ts";

/** A tool call the assistant made, with its arguments as compact JSON. */
export interface FeedToolCall {
    readonly id: string;
    readonly name: string;
    readonly args: string;
}

export type FeedItem =
    | { readonly kind: "user"; readonly id: number; readonly text: string }
    | {
          readonly kind: "assistant";
          readonly id: number;
          readonly text: string;
          readonly toolCalls: readonly FeedToolCall[];
      }
    | {
          readonly kind: "tool";
          readonly id: number;
          readonly callId: string;
          readonly name: string;
          readonly text: string;
          readonly isError: boolean;
      }
    /** The context was cleared; later items start fresh. */
    | { readonly kind: "reset"; readonly id: number };

/** A tool call of the current round while it runs. */
export interface LiveTool {
    readonly callId: string;
    readonly name: string;
    readonly status: "pending" | "running" | "done";
    /** Recent output, when the tool streams it. */
    readonly output?: string;
}

/** What the agent is doing right now. */
export interface LiveState {
    readonly busy: boolean;
    /** The answer as written so far. */
    readonly partial?: string;
    readonly tools: readonly LiveTool[];
    /** The model request failed and will be retried at `at`. */
    readonly retry?: { readonly at: number; readonly error: string };
    /** Why the newest run ended without an answer. */
    readonly failure?: { readonly reason: string; readonly detail?: string };
}

export type FeedEvent =
    | { readonly kind: "items"; readonly items: readonly FeedItem[] }
    | { readonly kind: "live"; readonly live: LiveState };

export interface FeedPage {
    /** Oldest first. */
    readonly items: readonly FeedItem[];
    /** Pass as `before` to load the page before this one; absent at the start of the conversation. */
    readonly before?: number;
}

export interface ConversationFeed {
    /** Items with ids below `before` (default: all), newest `limit` of them, returned oldest first. */
    history(from: Address, options?: { readonly before?: number; readonly limit?: number }): Promise<FeedPage>;
    /**
     * Items after id `after`, then every new item and live change as it happens. The current
     * live state arrives right away, after any catch-up items. Resolves with a function that stops it.
     */
    subscribe(from: Address, after: number, listener: (event: FeedEvent) => void): Promise<() => Promise<void>>;
}
