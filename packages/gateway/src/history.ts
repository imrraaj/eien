import type { ModelMessage } from "@eien/llm";

export interface ConversationStoreOptions {
  maxMessages?: number;
  maxChars?: number;
}

function contentLength(message: ModelMessage): number {
  if (typeof message.content === "string") return message.content.length;
  return JSON.stringify(message.content).length;
}

/**
 * In-memory per-user chat history. This is intentionally temporary: Phase 1
 * moves transcripts into Postgres and the history is rebuilt from the DB.
 */
export class ConversationStore {
  readonly #byUser = new Map<string, ModelMessage[]>();
  readonly #maxMessages: number;
  readonly #maxChars: number;

  constructor(options: ConversationStoreOptions = {}) {
    this.#maxMessages = options.maxMessages ?? 24;
    this.#maxChars = options.maxChars ?? 24_000;
  }

  get(userId: string): ModelMessage[] {
    return [...(this.#byUser.get(userId) ?? [])];
  }

  set(userId: string, messages: ModelMessage[]): void {
    this.#byUser.set(userId, this.#trim(messages));
  }

  reset(userId: string): void {
    this.#byUser.delete(userId);
  }

  #trim(messages: ModelMessage[]): ModelMessage[] {
    const trimmed = [...messages];
    let chars = trimmed.reduce((sum, m) => sum + contentLength(m), 0);

    while (
      trimmed.length > 1 &&
      (trimmed.length > this.#maxMessages || chars > this.#maxChars)
    ) {
      const removed = trimmed.shift();
      if (removed) chars -= contentLength(removed);
    }

    return trimmed;
  }
}
