import type { FeedEvent } from "@eien/io";

/** A file the agent sent to the web chat, kept for download. */
export interface StoredFile {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly caption?: string;
    readonly at: number;
}

/** Messages the server pushes over `/api/events`. The React app imports these types. */
export type ServerMessage =
    | { readonly type: "feed"; readonly event: FeedEvent }
    /** Something the bot said outside the transcript: a failed run, a command reply. */
    | { readonly type: "notice"; readonly text: string; readonly at: number }
    | { readonly type: "file"; readonly file: StoredFile }
    | { readonly type: "status"; readonly status: "working" | "queued" | "steered" | "idle" };

export type { FeedEvent, FeedItem, FeedPage, FeedToolCall, LiveState, LiveTool } from "@eien/io";
