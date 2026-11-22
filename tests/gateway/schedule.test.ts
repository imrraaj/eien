import { describe, expect, test } from "bun:test";
import { formatDuration, formatSchedules, parseDelay } from "../../packages/gateway/src/schedule.ts";

describe("parseDelay", () => {
  test("parses seconds, minutes, hours, days", () => {
    expect(parseDelay("30s")).toBe(30_000);
    expect(parseDelay("2m")).toBe(120_000);
    expect(parseDelay("1h")).toBe(3_600_000);
    expect(parseDelay("2d")).toBe(172_800_000);
  });

  test("treats a bare number as minutes", () => {
    expect(parseDelay("5")).toBe(300_000);
  });

  test("accepts long unit words and spaces", () => {
    expect(parseDelay(" 2 minutes ")).toBe(120_000);
    expect(parseDelay("10 seconds")).toBe(10_000);
  });

  test("rejects junk and zero", () => {
    expect(parseDelay("soon")).toBeUndefined();
    expect(parseDelay("0m")).toBeUndefined();
    expect(parseDelay("-2m")).toBeUndefined();
    expect(parseDelay("2m 30s")).toBeUndefined();
  });
});

describe("formatDuration", () => {
  test("picks the largest whole unit", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(900_000)).toBe("15m");
    expect(formatDuration(7_200_000)).toBe("2h");
    expect(formatDuration(172_800_000)).toBe("2d");
  });
});

describe("formatSchedules", () => {
  const now = 1_000_000;

  test("says so when empty", () => {
    expect(formatSchedules([], now)).toBe("No schedules.");
  });

  test("lists soonest first with interval and preview", () => {
    const text = formatSchedules(
      [
        { name: "later", prompt: "check the build", nextAt: now + 3_600_000, everyMs: 900_000 },
        { name: "joke", prompt: "tell me a joke", nextAt: now + 60_000 },
      ],
      now,
    );
    expect(text.split("\n")).toEqual([
      "joke — in 1m — tell me a joke",
      "later — in 1h, every 15m — check the build",
    ]);
  });

  test("marks an overdue schedule", () => {
    expect(formatSchedules([{ name: "x", prompt: "p", nextAt: now - 1 }], now)).toContain(
      "due now",
    );
  });
});
