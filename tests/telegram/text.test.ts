import { describe, expect, test } from "bun:test";
import { splitMessage } from "../../packages/telegram/src/text.ts";

describe("splitMessage", () => {
  test("returns short text as a single chunk", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  test("splits on the last newline within the limit", () => {
    const text = `${"a".repeat(10)}\n${"b".repeat(10)}`;
    expect(splitMessage(text, 15)).toEqual(["a".repeat(10), "b".repeat(10)]);
  });

  test("hard-splits a long token", () => {
    const chunks = splitMessage("x".repeat(25), 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  test("never emits a lone surrogate", () => {
    const text = `${"a".repeat(9)}😀${"b".repeat(9)}`;
    const chunks = splitMessage(text, 10);
    for (const chunk of chunks) {
      expect(chunk.isWellFormed()).toBe(true);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("rejects invalid limits", () => {
    expect(() => splitMessage("hi", 0)).toThrow(RangeError);
    expect(() => splitMessage("hi", 1.5)).toThrow(RangeError);
  });
});
