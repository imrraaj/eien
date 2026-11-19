import { describe, expect, test } from "bun:test";
import type { Message } from "@eien/llm";
import { Steering } from "./steering.ts";

const message = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

describe("Steering", () => {
  test("returns queued messages once", () => {
    const steering = new Steering();
    steering.add("chat-1", message("a"));
    steering.add("chat-1", message("b"));

    expect(steering.take("chat-1").map((m) => m.content)).toEqual(["a", "b"]);
    expect(steering.take("chat-1")).toEqual([]);
  });

  test("keeps chats separate", () => {
    const steering = new Steering();
    steering.add("chat-1", message("a"));
    expect(steering.take("chat-2")).toEqual([]);
    expect(steering.take("chat-1")).toHaveLength(1);
  });

  test("clear reports and drops pending messages", () => {
    const steering = new Steering();
    steering.add("chat-1", message("a"));
    steering.add("chat-1", message("b"));
    expect(steering.clear("chat-1")).toBe(2);
    expect(steering.take("chat-1")).toEqual([]);
  });
});
