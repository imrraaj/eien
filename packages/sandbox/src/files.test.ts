import { describe, expect, test } from "bun:test";
import { editText, readText, writeText } from "./files.ts";
import { statSandboxFile } from "./copy.ts";
import type { CopyOptions, ExecOptions, ExecResult, Sandbox } from "./types.ts";

const ok = (output = ""): ExecResult => ({
  output,
  exitCode: 0,
  timedOut: false,
  truncated: false,
});

class FakeSandbox implements Sandbox {
  readonly driver = "fake";
  readonly name = "fake";
  readonly root = "/work";
  readonly calls: Array<{ command: string; options?: ExecOptions }> = [];

  constructor(private readonly reply: (command: string) => ExecResult = () => ok()) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ command, options });
    return this.reply(command);
  }

  async copyIn(_local: string, _remote: string, _options?: CopyOptions): Promise<void> {}
  async copyOut(_remote: string, _local: string, _options?: CopyOptions): Promise<void> {}
}

describe("file helpers", () => {
  test("readText resolves against the sandbox root", async () => {
    const sandbox = new FakeSandbox(() => ok("one\ntwo\n"));
    const result = await readText(sandbox, "notes.txt");

    expect(result.path).toBe("/work/notes.txt");
    expect(result.text).toBe("one\ntwo\n");
    expect(sandbox.calls[0]?.command).toContain("'/work/notes.txt'");
  });

  test("readText rejects paths outside the root before running anything", async () => {
    const sandbox = new FakeSandbox();
    await expect(readText(sandbox, "../../etc/passwd")).rejects.toThrow("escapes the workspace");
    expect(sandbox.calls).toHaveLength(0);
  });

  test("writeText sends content on stdin", async () => {
    const sandbox = new FakeSandbox();
    await writeText(sandbox, "dir/a.txt", "hello");

    expect(sandbox.calls[0]?.command).toContain("mkdir -p -- '/work/dir'");
    expect(sandbox.calls[0]?.command).toContain("cat > '/work/dir/a.txt'");
    expect(sandbox.calls[0]?.options?.stdin).toBe("hello");
  });

  test("editText replaces exactly one occurrence", async () => {
    const sandbox = new FakeSandbox((command) =>
      command.includes("sed -n") ? ok("a\nold\nb\n") : ok(),
    );
    const result = await editText(sandbox, "f.txt", "old", "new");

    expect(result).toMatchObject({ replacements: 1, line: 2, path: "/work/f.txt" });
    expect(sandbox.calls.at(-1)?.options?.stdin).toBe("a\nnew\nb\n");
  });

  test("editText refuses ambiguous matches", async () => {
    const sandbox = new FakeSandbox((command) =>
      command.includes("sed -n") ? ok("old\nold\n") : ok(),
    );
    await expect(editText(sandbox, "f.txt", "old", "new")).rejects.toThrow("appears 2 times");
  });

  test("statSandboxFile parses type and size", async () => {
    const sandbox = new FakeSandbox(() => ok("regular file|1234\n"));
    await expect(statSandboxFile(sandbox, "/work/a.bin")).resolves.toEqual({
      type: "regular file",
      size: 1234,
    });
  });
});
