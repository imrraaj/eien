import { describe, expect, test } from "bun:test";
import { resolveInRoot } from "../../packages/sandbox/src/paths.ts";

const resolved = (root: string, path: string) => resolveInRoot(root, path).unwrap();
const rejection = (root: string, path: string) => {
  const result = resolveInRoot(root, path);
  if (result.isOk()) throw new Error(`expected ${path} to be rejected`);
  expect(result.error._tag).toBe("InvalidPath");
  return result.error.message;
};

describe("resolveInRoot", () => {
  test("resolves relative paths against the root", () => {
    expect(resolved("/work", "repo/file.ts")).toBe("/work/repo/file.ts");
  });

  test("accepts absolute paths inside the root", () => {
    expect(resolved("/work", "/work/repo/file.ts")).toBe("/work/repo/file.ts");
  });

  test("normalizes . and ..", () => {
    expect(resolved("/work", "repo/../other")).toBe("/work/other");
  });

  test("rejects escapes", () => {
    expect(rejection("/work", "../etc/passwd")).toContain("escapes");
    expect(rejection("/work", "/etc/passwd")).toContain("escapes");
    expect(rejection("/work", "/workspace/file")).toContain("escapes");
  });

  test("rejects empty paths and NUL bytes", () => {
    expect(rejection("/work", "")).toBe("invalid path");
    expect(rejection("/work", "a\0b")).toBe("invalid path");
  });

  test("supports a root of /", () => {
    expect(resolved("/", "/etc/hosts")).toBe("/etc/hosts");
  });

  test("a relative root is a configuration bug and throws", () => {
    expect(() => resolveInRoot("work", "a")).toThrow("must be absolute");
  });
});
