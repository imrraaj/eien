import { posix } from "node:path";
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
): Promise<ReadResult> {
  const absolute = resolveInRoot(sandbox.root, path);
  const start = Math.max(1, Math.trunc(options.offset ?? 1));
  const limit = Math.min(2_000, Math.max(1, Math.trunc(options.limit ?? 400)));
  const end = start + limit - 1;

  const result = await sandbox.exec(
    `test -f ${shellQuote(absolute)} || { echo "not a readable file: ${absolute.replaceAll('"', '\\"')}" >&2; exit 2; }; sed -n '${start},${end}p' -- ${shellQuote(absolute)}`,
    { signal: options.signal, timeoutMs: 30_000 },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.output.trim() || `read failed with exit ${result.exitCode}`);
  }

  return {
    path: absolute,
    text: result.output,
    startLine: start,
    endLine: end,
    truncated: result.truncated,
  };
}

export async function writeText(
  sandbox: Sandbox,
  path: string,
  content: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const absolute = resolveInRoot(sandbox.root, path);
  const dir = posix.dirname(absolute);
  const result = await sandbox.exec(
    `mkdir -p -- ${shellQuote(dir)} && cat > ${shellQuote(absolute)}`,
    { stdin: content, signal: options.signal, timeoutMs: 30_000 },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.output.trim() || `write failed with exit ${result.exitCode}`);
  }
  return `wrote ${Buffer.byteLength(content)} bytes to ${absolute}`;
}

export interface EditResult {
  path: string;
  replacements: number;
  line: number;
}

/**
 * Replace exactly one occurrence of `oldText` with `newText`.
 * Ambiguous or missing matches fail so the model must be precise.
 */
export async function editText(
  sandbox: Sandbox,
  path: string,
  oldText: string,
  newText: string,
  options: { signal?: AbortSignal } = {},
): Promise<EditResult> {
  if (!oldText) throw new Error("old text must not be empty");

  const current = await readText(sandbox, path, {
    limit: 20_000,
    signal: options.signal,
  });

  if (current.truncated) {
    throw new Error(
      `${current.path} is too large to edit safely (output truncated); use bash or write it in smaller files`,
    );
  }

  const occurrences = current.text.split(oldText).length - 1;
  if (occurrences === 0) throw new Error(`old text not found in ${current.path}`);
  if (occurrences > 1) {
    throw new Error(
      `old text appears ${occurrences} times in ${current.path}; include more context to make it unique`,
    );
  }

  const index = current.text.indexOf(oldText);
  const line = current.text.slice(0, index).split("\n").length;
  const updated = `${current.text.slice(0, index)}${newText}${current.text.slice(index + oldText.length)}`;

  await writeText(sandbox, current.path, updated, options);
  return { path: current.path, replacements: 1, line };
}
