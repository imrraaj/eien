import { describe, expect, test } from "bun:test";
import { editText, readText, writeText } from "../../packages/sandbox/src/files.ts";
import { statSandboxFile } from "../../packages/sandbox/src/copy.ts";
import type { CopyOptions, ExecOptions, ExecResult, Sandbox } from "../../packages/sandbox/src/types.ts";

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
    const result = (await readText(sandbox, "notes.txt")).unwrap();

    expect(result.path).toBe("/work/notes.txt");
    expect(result.text).toBe("one\ntwo\n");
    expect(sandbox.calls[0]?.command).toContain("'/work/notes.txt'");
  });

  test("readText rejects paths outside the root before running anything", async () => {
    const sandbox = new FakeSandbox();
    const result = await readText(sandbox, "../../etc/passwd");
    expect(result.isErr() && result.error._tag).toBe("InvalidPath");
    expect(sandbox.calls).toHaveLength(0);
  });

  test("readText reports a failing command with its output", async () => {
    const sandbox = new FakeSandbox(() => ({ ...ok("not a readable file: /work/x\n"), exitCode: 2 }));
    const result = await readText(sandbox, "x");
    if (result.isOk()) throw new Error("expected failure");
    expect(result.error).toMatchObject({ _tag: "CommandFailed", exitCode: 2, message: "not a readable file: /work/x" });
  });

  test("writeText sends content on stdin", async () => {
    const sandbox = new FakeSandbox();
    (await writeText(sandbox, "dir/a.txt", "hello")).unwrap();

    expect(sandbox.calls[0]?.command).toContain("mkdir -p -- '/work/dir'");
    expect(sandbox.calls[0]?.command).toContain("cat > '/work/dir/a.txt'");
    expect(sandbox.calls[0]?.options?.stdin).toBe("hello");
  });

  test("editText replaces exactly one occurrence", async () => {
    const sandbox = new FakeSandbox((command) =>
      command.includes("sed -n") ? ok("a\nold\nb\n") : ok(),
    );
    const result = (await editText(sandbox, "f.txt", "old", "new")).unwrap();

    expect(result).toEqual({ line: 2, path: "/work/f.txt" });
    expect(sandbox.calls.at(-1)?.options?.stdin).toBe("a\nnew\nb\n");
  });

  test("editText refuses ambiguous matches", async () => {
    const sandbox = new FakeSandbox((command) =>
      command.includes("sed -n") ? ok("old\nold\n") : ok(),
    );
    const result = await editText(sandbox, "f.txt", "old", "new");
    if (result.isOk()) throw new Error("expected failure");
    expect(result.error).toMatchObject({ _tag: "EditFailed", reason: "ambiguous" });
    expect(sandbox.calls).toHaveLength(1);
  });

  test("editText refuses missing and empty text without writing", async () => {
    const sandbox = new FakeSandbox((command) => (command.includes("sed -n") ? ok("abc\n") : ok()));
    const missing = await editText(sandbox, "f.txt", "zzz", "new");
    const empty = await editText(sandbox, "f.txt", "", "new");
    expect(missing.isErr() && missing.error).toMatchObject({ _tag: "EditFailed", reason: "not_found" });
    expect(empty.isErr() && empty.error).toMatchObject({ _tag: "EditFailed", reason: "empty" });
    expect(sandbox.calls.every((call) => call.options?.stdin === undefined)).toBe(true);
  });

  test("statSandboxFile parses type and size", async () => {
    const sandbox = new FakeSandbox(() => ok("regular file|1234\n"));
    expect((await statSandboxFile(sandbox, "/work/a.bin")).unwrap()).toEqual({ type: "regular file", size: 1234 });
  });
});
