import { spawn } from "node:child_process";
import { Result } from "better-result";
import { commandFailed, type CommandFailed } from "./errors.ts";
import type { CopyOptions, ExecOptions, ExecResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const RAW_CAPTURE_BYTES = 1_048_576;
const OUTPUT_BYTES = 32_768;

/** Quote a string for safe use in a POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function truncateMiddle(text: string, limit = OUTPUT_BYTES): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };

  const half = Math.floor(limit / 2);
  const removed = text.length - limit;
  return {
    text: `${text.slice(0, half)}\n\n… [${removed} characters truncated] …\n\n${text.slice(-half)}`,
    truncated: true,
  };
}

/**
 * Spawn a command, capture stdout/stderr, middle-truncate, and report the exit
 * code. Shared by every backend; nothing here knows what the command means.
 */
export function runProcess(
  bin: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    let captured = 0;
    let rawTruncated = false;
    let timedOut = false;
    let settled = false;

    const capture = (chunk: Buffer) => {
      if (captured >= RAW_CAPTURE_BYTES) {
        rawTruncated = true;
        return;
      }
      const remaining = RAW_CAPTURE_BYTES - captured;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      captured += slice.length;
      if (slice.length < chunk.length) rawTruncated = true;
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);

      const truncated = truncateMiddle(Buffer.concat(chunks).toString("utf8"));
      resolve({
        output: truncated.text,
        exitCode,
        timedOut,
        truncated: truncated.truncated || rawTruncated,
      });
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (code) => finish(code ?? 1));

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

/**
 * Run a copy command. A non-zero exit is `CommandFailed` carrying stderr; failing
 * to start the binary at all is a broken install and rejects.
 */
export function runCopy(
  bin: string,
  args: string[],
  options: CopyOptions = {},
): Promise<Result<void, CommandFailed>> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });

    child.on("close", (code) => {
      cleanup();
      resolve(code === 0 ? Result.ok(undefined) : Result.err(commandFailed(code ?? 1, stderr, `${bin} failed`)));
    });
  });
}
