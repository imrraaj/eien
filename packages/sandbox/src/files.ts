import { Result } from "better-result";
import { posix } from "node:path";
import { CommandFailed, EditFailed, InvalidPath, commandFailed } from "./errors.ts";
import { resolveInRoot } from "./paths.ts";
import { shellQuote } from "./process.ts";
import type { Sandbox } from "./types.ts";

export interface ReadOptions {
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}

export interface ReadResult {
  path: string;
  text: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

export async function readText(
  sandbox: Sandbox,
  path: string,
  options: ReadOptions = {},
): Promise<Result<ReadResult, InvalidPath | CommandFailed>> {
  const resolved = resolveInRoot(sandbox.root, path);
  if (resolved.isErr()) return resolved;
  const absolute = resolved.value;
  const start = Math.max(1, Math.trunc(options.offset ?? 1));
  const limit = Math.min(2_000, Math.max(1, Math.trunc(options.limit ?? 400)));
  const end = start + limit - 1;

  const run = await sandbox.exec(
    `test -f ${shellQuote(absolute)} || { echo "not a readable file: ${absolute.replaceAll('"', '\\"')}" >&2; exit 2; }; sed -n '${start},${end}p' -- ${shellQuote(absolute)}`,
    { signal: options.signal, timeoutMs: 30_000 },
  );
  if (run.exitCode !== 0) return Result.err(commandFailed(run.exitCode, run.output, "read failed"));

  return Result.ok({ path: absolute, text: run.output, startLine: start, endLine: end, truncated: run.truncated });
}

export async function writeText(
  sandbox: Sandbox,
  path: string,
  content: string,
  options: { signal?: AbortSignal } = {},
): Promise<Result<string, InvalidPath | CommandFailed>> {
  const resolved = resolveInRoot(sandbox.root, path);
  if (resolved.isErr()) return resolved;
  const absolute = resolved.value;

  const run = await sandbox.exec(`mkdir -p -- ${shellQuote(posix.dirname(absolute))} && cat > ${shellQuote(absolute)}`, {
    stdin: content,
    signal: options.signal,
    timeoutMs: 30_000,
  });
  if (run.exitCode !== 0) return Result.err(commandFailed(run.exitCode, run.output, "write failed"));
  return Result.ok(`wrote ${Buffer.byteLength(content)} bytes to ${absolute}`);
}

export interface EditResult {
  path: string;
  line: number;
}

/**
 * Replace exactly one occurrence of `oldText` with `newText`.
 * Ambiguous or missing matches fail so the model must be precise.
 */
export function editText(
  sandbox: Sandbox,
  path: string,
  oldText: string,
  newText: string,
  options: { signal?: AbortSignal } = {},
): Promise<Result<EditResult, InvalidPath | CommandFailed | EditFailed>> {
  return Result.gen(async function* () {
    if (!oldText) yield* new EditFailed({ path, reason: "empty", message: "old text must not be empty" });

    const current = yield* Result.await(readText(sandbox, path, { limit: 20_000, signal: options.signal }));
    if (current.truncated) {
      yield* new EditFailed({
        path: current.path,
        reason: "too_large",
        message: `${current.path} is too large to edit safely (output truncated); use bash or write it in smaller files`,
      });
    }

    const occurrences = current.text.split(oldText).length - 1;
    if (occurrences === 0) {
      yield* new EditFailed({ path: current.path, reason: "not_found", message: `old text not found in ${current.path}` });
    }
    if (occurrences > 1) {
      yield* new EditFailed({
        path: current.path,
        reason: "ambiguous",
        message: `old text appears ${occurrences} times in ${current.path}; include more context to make it unique`,
      });
    }

    const index = current.text.indexOf(oldText);
    const line = current.text.slice(0, index).split("\n").length;
    const updated = `${current.text.slice(0, index)}${newText}${current.text.slice(index + oldText.length)}`;
    yield* Result.await(writeText(sandbox, current.path, updated, options));
    return Result.ok({ path: current.path, line });
  });
}
