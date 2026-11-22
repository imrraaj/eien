import type { Result } from "better-result";
import type { CommandFailed } from "./errors.ts";
import { runCopy, runProcess, shellQuote } from "./process.ts";
import type { CopyOptions, ExecOptions, ExecResult, Sandbox, SshOptions } from "./types.ts";

/** argv for `ssh`, without the destination or command. Exported for tests. */
export function sshArgs(ssh: SshOptions): string[] {
  return [
    "-T",
    "-p",
    String(ssh.port),
    "-i",
    ssh.keyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${ssh.knownHostsPath}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "LogLevel=ERROR",
  ];
}

/** argv for `scp`, without the source and target. Exported for tests. */
export function scpArgs(ssh: SshOptions): string[] {
  return [
    "-q",
    "-P",
    String(ssh.port),
    "-i",
    ssh.keyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${ssh.knownHostsPath}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "LogLevel=ERROR",
  ];
}

/** `user@host:path` for scp. */
export function sshRemote(ssh: SshOptions, path: string): string {
  return `${ssh.user}@${ssh.host}:${path}`;
}

/** Remote script for one command, entering `cwd` first. */
export function sshScript(command: string, cwd: string): string {
  return `cd -- ${shellQuote(cwd)} && ${command}`;
}

/**
 * The single remote command string ssh sends. ssh joins its command arguments
 * with spaces, so the whole `bash -lc '...'` invocation must be one quoted
 * token or the script's semicolons and && escape into the outer shell.
 */
export function sshCommand(script: string): string {
  return `bash -lc ${shellQuote(script)}`;
}

/** Sandbox container reached over SSH (no Docker socket anywhere). */
export class SshSandbox implements Sandbox {
  readonly driver = "ssh";
  readonly name: string;
  readonly root: string;
  readonly ssh: SshOptions;

  constructor(config: { name: string; root: string; ssh: SshOptions }) {
    this.name = config.name;
    this.root = config.root;
    this.ssh = config.ssh;
  }

  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const cwd = options.cwd ?? this.root;
    return runProcess(
      "ssh",
      [
        ...sshArgs(this.ssh),
        `${this.ssh.user}@${this.ssh.host}`,
        "--",
        sshCommand(sshScript(command, cwd)),
      ],
      options,
    );
  }

  copyIn(localPath: string, remotePath: string, options?: CopyOptions): Promise<Result<void, CommandFailed>> {
    return runCopy("scp", [...scpArgs(this.ssh), localPath, sshRemote(this.ssh, remotePath)], options);
  }

  copyOut(remotePath: string, localPath: string, options?: CopyOptions): Promise<Result<void, CommandFailed>> {
    return runCopy("scp", [...scpArgs(this.ssh), sshRemote(this.ssh, remotePath), localPath], options);
  }
}
