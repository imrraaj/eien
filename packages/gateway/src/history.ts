import type { Message } from "@eien/llm";

export interface ConversationStoreOptions {
  maxMessages?: number;
  maxChars?: number;
}

function contentLength(message: Message): number {
  if (typeof message.content === "string") return message.content.length;
  return JSON.stringify(message.content).length;
}

/**
 * In-memory per-user chat history. The bot is a single long-running process for
 * now; moving this to Postgres is the next step.
 */
export class ConversationStore {
  readonly #byUser = new Map<string, Message[]>();
  readonly #maxMessages: number;
  readonly #maxChars: number;

  constructor(options: ConversationStoreOptions = {}) {
    this.#maxMessages = options.maxMessages ?? 40;
    this.#maxChars = options.maxChars ?? 48_000;
  }

  get(userId: string): Message[] {
    return [...(this.#byUser.get(userId) ?? [])];
  }

  set(userId: string, messages: Message[]): void {
    this.#byUser.set(userId, this.#trim(messages));
  }

  reset(userId: string): void {
    this.#byUser.delete(userId);
  }

  #trim(messages: Message[]): Message[] {
    const trimmed = [...messages];
    let chars = trimmed.reduce((sum, message) => sum + contentLength(message), 0);

    while (
      trimmed.length > 1 &&
      (trimmed.length > this.#maxMessages || chars > this.#maxChars)
    ) {
      const removed = trimmed.shift();
      if (removed) chars -= contentLength(removed);
    }

    // A tool result without the assistant call that produced it is invalid context.
    while (trimmed[0]?.role === "toolResult") trimmed.shift();

    return trimmed;
  }
}
