import type { Result } from "better-result";
import type { DeliveryFailed } from "./errors.ts";

/** Where a conversation lives: which service, and which chat inside it. */
export interface Address {
    readonly service: string;
    readonly chat: string;
}

/** A file an input service already saved on the host. The receiver deletes it when done. */
export interface Attachment {
    readonly localPath: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
}

/** Who sent a message inside a shared chat. The id is authoritative; name/username are user-controlled. */
export interface Author {
    readonly id: string;
    readonly name: string;
    readonly username?: string;
}

export type InboundEvent =
    | {
          readonly kind: "message";
          readonly from: Address;
          /** Unique per service; repeats of one event carry the same id. */
          readonly id: string;
          readonly text: string;
          readonly attachments: readonly Attachment[];
          /** Present when the chat can contain several people, e.g. a group. */
          readonly author?: Author;
          /** The user replied to one of this service's own messages; a hint to steer the run in flight. */
          readonly replyToBot?: boolean;
      }
    | {
          readonly kind: "command";
          readonly from: Address;
          readonly id: string;
          /** Lowercase, without the leading slash. */
          readonly name: string;
          readonly args: readonly string[];
      }
    | {
          readonly kind: "callback";
          readonly from: Address;
          readonly id: string;
          /** The `data` of the choice the user clicked, as rendered by this service. */
          readonly data: string;
      };

export type InboundSink = (event: InboundEvent) => Promise<void>;

/** A source of user messages (Telegram, the web app, ...). */
export interface InputService {
    readonly name: string;
    start(sink: InboundSink): Promise<void>;
    stop(): Promise<void>;
}

/** One clickable option rendered by an input service. `data` is echoed back as a callback event. */
export interface Choice {
    readonly label: string;
    readonly data: string;
}

/** What the agent says. `status` is a hint each service renders its own way, or ignores. */
export type OutboundMessage =
    | {
          readonly kind: "text";
          readonly text: string;
          /** Transcript entry this answer came from; absent for notices such as a failed run. */
          readonly entry?: number;
      }
    | {
          readonly kind: "choices";
          readonly text: string;
          readonly choices: readonly Choice[];
      }
    | {
          readonly kind: "file";
          /** Host path, valid until `send` settles. */
          readonly localPath: string;
          readonly name: string;
          readonly size: number;
          readonly caption?: string;
      }
    | { readonly kind: "status"; readonly status: "working" | "queued" | "steered" | "idle" };

/** A destination for agent output. Limits it cannot meet come back as `DeliveryFailed`, never as a throw. */
export interface OutputService {
    readonly name: string;
    /** Guidance added to the system prompt for chats on this service, such as formatting rules. */
    readonly promptHint?: string;
    send(chat: string, message: OutboundMessage): Promise<Result<void, DeliveryFailed>>;
}
