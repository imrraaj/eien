import { runCopy, runProcess } from "./process.ts";
import type { CopyOptions, ExecOptions, ExecResult, Sandbox } from "./types.ts";

/** argv for `sbx exec`, ending with the remote shell command. Exported for tests. */
export function sbxExecArgs(name: string, command: string, cwd?: string): string[] {
  const args = ["exec"];
  if (cwd) args.push("-w", cwd);
  args.push(name, "bash", "-lc", command);
  return args;
}

/** `sandbox:path` as `sbx cp` expects it. */
export function sbxRemote(name: string, path: string): string {
  return `${name}:${path}`;
}

/** Sandbox managed by a host-installed Docker Sandboxes daemon (`sbx`). */
export class SbxSandbox implements Sandbox {
  readonly driver = "sbx";
  readonly name: string;
  readonly root: string;

  constructor(config: { name: string; root: string }) {
    this.name = config.name;
    this.root = config.root;
  }

  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const cwd = options.cwd ?? this.root;
    return runProcess("sbx", sbxExecArgs(this.name, command, cwd), options);
  }

  copyIn(localPath: string, remotePath: string, options?: CopyOptions): Promise<void> {
    return runCopy("sbx", ["cp", localPath, sbxRemote(this.name, remotePath)], options);
  }

  copyOut(remotePath: string, localPath: string, options?: CopyOptions): Promise<void> {
    return runCopy("sbx", ["cp", sbxRemote(this.name, remotePath), localPath], options);
  }
}
