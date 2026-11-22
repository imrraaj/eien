import type { CopyOptions, RemoteFileInfo, Sandbox } from "./types.ts";

/** Stat a path inside the sandbox. Throws when the path does not exist. */
export async function statSandboxFile(
  sandbox: Sandbox,
  remotePath: string,
  options: CopyOptions = {},
): Promise<RemoteFileInfo> {
  const quoted = `'${remotePath.replaceAll("'", `'\\''`)}'`;
  const result = await sandbox.exec(`stat -Lc '%F|%s' -- ${quoted}`, {
    timeoutMs: options.timeoutMs ?? 15_000,
    signal: options.signal,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.output.trim() || `cannot stat ${remotePath}`);
  }

  const [rawType, rawSize] = result.output.trim().split("|");
  const size = Number(rawSize);
  return {
    type: (rawType ?? "").toLowerCase(),
    size: Number.isFinite(size) ? size : 0,
  };
}
