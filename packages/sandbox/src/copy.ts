import { spawn } from "node:child_process";
import { sbxExec, type SandboxConfig } from "./exec.ts";

export interface CopyOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RemoteFileInfo {
  /** "file", "directory", or another stat type. */
  type: string;
  size: number;
}

/** Stat a path inside the sandbox. Throws when the path does not exist. */
export async function statSandboxFile(
  sandbox: SandboxConfig,
  remotePath: string,
  options: CopyOptions = {},
): Promise<RemoteFileInfo> {
  const quoted = `'${remotePath.replaceAll("'", `'\\''`)}'`;
  const result = await sbxExec(sandbox, `stat -Lc '%F|%s' -- ${quoted}`, {
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

/** Copy a file from the sandbox to a host path via `sbx cp`. */
export function copyFromSandbox(
  sandbox: SandboxConfig,
  remotePath: string,
  localPath: string,
  options: CopyOptions = {},
): Promise<void> {
  return copy(`${sandbox.name}:${remotePath}`, localPath, options);
}

/** Copy a host file into the sandbox via `sbx cp`. */
export function copyToSandbox(
  sandbox: SandboxConfig,
  localPath: string,
  remotePath: string,
  options: CopyOptions = {},
): Promise<void> {
  return copy(localPath, `${sandbox.name}:${remotePath}`, options);
}

function copy(source: string, target: string, options: CopyOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("sbx", ["cp", source, target], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timeoutMs = options.timeoutMs ?? 120_000;
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
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `sbx cp failed with exit ${code}`));
    });
  });
}
