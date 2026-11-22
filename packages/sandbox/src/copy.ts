import { Result } from "better-result";
import { commandFailed, type CommandFailed } from "./errors.ts";
import { shellQuote } from "./process.ts";
import type { CopyOptions, RemoteFileInfo, Sandbox } from "./types.ts";

/** Stat a path inside the sandbox. */
export async function statSandboxFile(
    sandbox: Sandbox,
    remotePath: string,
    options: CopyOptions = {},
): Promise<Result<RemoteFileInfo, CommandFailed>> {
    const run = await sandbox.exec(`stat -Lc '%F|%s' -- ${shellQuote(remotePath)}`, {
        timeoutMs: options.timeoutMs ?? 15_000,
        signal: options.signal,
    });
    if (run.exitCode !== 0) return Result.err(commandFailed(run.exitCode, run.output, `cannot stat ${remotePath}`));

    const [rawType, rawSize] = run.output.trim().split("|");
    const size = Number(rawSize);
    return Result.ok({ type: (rawType ?? "").toLowerCase(), size: Number.isFinite(size) ? size : 0 });
}

/** Create a directory (and parents) inside the sandbox. */
export async function makeSandboxDir(sandbox: Sandbox, dir: string): Promise<Result<void, CommandFailed>> {
    const run = await sandbox.exec(`mkdir -p -- ${shellQuote(dir)}`, { timeoutMs: 15_000 });
    return run.exitCode === 0
        ? Result.ok(undefined)
        : Result.err(commandFailed(run.exitCode, run.output, `could not create ${dir}`));
}
