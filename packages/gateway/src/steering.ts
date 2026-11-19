import type { Message } from "@eien/llm";

/**
 * Messages that arrive while a turn is running. They are folded into the
 * running turn at its next model step instead of waiting for it to finish.
 */
export class Steering {
  readonly #pending = new Map<string, Message[]>();

  add(key: string, message: Message): void {
    const list = this.#pending.get(key) ?? [];
    list.push(message);
    this.#pending.set(key, list);
  }

  take(key: string): Message[] {
    const list = this.#pending.get(key);
    if (!list || list.length === 0) return [];
    this.#pending.delete(key);
    return list;
  }

  clear(key: string): number {
    const list = this.#pending.get(key);
    this.#pending.delete(key);
    return list?.length ?? 0;
  }
}
