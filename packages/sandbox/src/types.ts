import type { Result } from "better-result";
import type { CommandFailed } from "./errors.ts";

/** Transport-agnostic view of the sandbox the agent works in. */

export interface ExecOptions {
  /** Directory inside the sandbox; defaults to the sandbox root. */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
  /** Cap on captured output before middle-truncation. */
  maxOutputBytes?: number;
}

export interface ExecResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface CopyOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RemoteFileInfo {
  /** "file", "directory", or another stat type. */
  type: string;
  size: number;
}

/**
 * Where commands and files go. Implementations own the transport (sbx CLI,
 * ssh/scp, ...); callers never see it.
 */
export interface Sandbox {
  /** Backend identifier for logs and `/status`, e.g. "sbx" or "ssh". */
  readonly driver: string;
  /** Sandbox or container name, for logs. */
  readonly name: string;
  /** Workspace root inside the sandbox, e.g. "/work". */
  readonly root: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** Copy a host file into the sandbox. */
  copyIn(localPath: string, remotePath: string, options?: CopyOptions): Promise<Result<void, CommandFailed>>;
  /** Copy a sandbox file to the host. */
  copyOut(remotePath: string, localPath: string, options?: CopyOptions): Promise<Result<void, CommandFailed>>;
}

export interface SshOptions {
  host: string;
  user: string;
  port: number;
  /** Private key readable by the gateway process. */
  keyPath: string;
  /** known_hosts file pinning the sandbox host key. */
  knownHostsPath: string;
}

export type SandboxConfig =
  | { driver: "sbx"; name: string; root: string }
  | { driver: "ssh"; name: string; root: string; ssh: SshOptions };
