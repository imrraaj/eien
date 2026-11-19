import { describe, expect, test } from "bun:test";
import { ackText } from "./ack.ts";

describe("ackText", () => {
  test("quotes a short request on one line", () => {
    expect(ackText("build the thing\nwith details")).toBe(
      "On it — build the thing\nI'll post the result here when it's done.",
    );
  });

  test("truncates long requests", () => {
    const text = ackText("x".repeat(300));
    expect(text.split("\n")[0]?.length).toBeLessThanOrEqual(110);
    expect(text).toContain("…");
  });

  test("drops the attachment note", () => {
    expect(ackText("convert this to png\n\n[attached file saved in /work/uploads/a.jpg]")).toBe(
      "On it — convert this to png\nI'll post the result here when it's done.",
    );
  });

  test("falls back when there is no text", () => {
    expect(ackText("[attached file only]")).toBe(
      "On it — working on it.\nI'll post the result here when it's done.",
    );
  });
});
