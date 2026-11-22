import { describe, expect, test } from "bun:test";
import { resolveInRoot } from "../../packages/sandbox/src/paths.ts";

describe("resolveInRoot", () => {
  test("resolves relative paths against the root", () => {
    expect(resolveInRoot("/work", "repo/file.ts")).toBe("/work/repo/file.ts");
  });

  test("accepts absolute paths inside the root", () => {
    expect(resolveInRoot("/work", "/work/repo/file.ts")).toBe("/work/repo/file.ts");
  });

  test("normalizes . and ..", () => {
    expect(resolveInRoot("/work", "repo/../other")).toBe("/work/other");
  });

  test("rejects escapes", () => {
    expect(() => resolveInRoot("/work", "../etc/passwd")).toThrow("escapes");
    expect(() => resolveInRoot("/work", "/etc/passwd")).toThrow("escapes");
    expect(() => resolveInRoot("/work", "/workspace/file")).toThrow("escapes");
  });

  test("rejects empty paths and NUL bytes", () => {
    expect(() => resolveInRoot("/work", "")).toThrow("invalid path");
    expect(() => resolveInRoot("/work", "a\0b")).toThrow("invalid path");
  });

  test("supports a root of /", () => {
    expect(resolveInRoot("/", "/etc/hosts")).toBe("/etc/hosts");
  });
});
