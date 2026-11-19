import { sbxExec, shellQuote, type SandboxConfig } from "./exec.ts";

export interface KillOptions {
  timeoutMs?: number;
}

/**
 * Terminate processes whose working directory is inside the workspace.
 * Used when a turn is cancelled; kills this agent's work without touching
 * dockerd/containerd.
 */
export async function killSandboxWork(
  sandbox: SandboxConfig,
  root: string,
  options: KillOptions = {},
): Promise<number> {
  const base = shellQuote(root.replace(/\/+$/, ""));
  const matches = `case "$c" in ${base}|${base}/*) true;; *) false;; esac`;
  const sweep = (signal: string) => `
    for p in /proc/[0-9]*; do
      pid=\${p#/proc/}
      [ "$pid" = "$$" ] && continue
      c=$(readlink "$p/cwd" 2>/dev/null) || continue
      ${matches} || continue
      kill -${signal} "$pid" 2>/dev/null && n=$((n + 1))
    done`;

  const result = await sbxExec(
    sandbox,
    `n=0; ${sweep("TERM")}; sleep 1; ${sweep("KILL")}; echo "$n"`,
    { cwd: root, timeoutMs: options.timeoutMs ?? 20_000 },
  );

  const count = Number(result.output.trim().split("\n").at(-1));
  return Number.isFinite(count) ? count : 0;
}
