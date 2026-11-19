import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@eien/llm";
import { ConversationStore } from "./history.ts";

const message = (content: string, role: "user" | "assistant" = "user"): ModelMessage => ({
  role,
  content,
});

describe("ConversationStore", () => {
  test("keeps the most recent messages", () => {
    const store = new ConversationStore({ maxMessages: 2 });
    store.set("u1", [message("one"), message("two"), message("three")]);
    expect(store.get("u1")).toEqual([message("two"), message("three")]);
  });

  test("drops old messages when the char budget is exceeded", () => {
    const store = new ConversationStore({ maxMessages: 10, maxChars: 10 });
    store.set("u1", [message("12345"), message("67890"), message("abcde")]);
    expect(store.get("u1")).toEqual([message("67890"), message("abcde")]);
  });

  test("always keeps at least one message", () => {
    const store = new ConversationStore({ maxMessages: 1, maxChars: 1 });
    store.set("u1", [message("too long to fit")]);
    expect(store.get("u1")).toHaveLength(1);
  });

  test("reset clears a user's history", () => {
    const store = new ConversationStore();
    store.set("u1", [message("hi")]);
    store.reset("u1");
    expect(store.get("u1")).toEqual([]);
  });
});
