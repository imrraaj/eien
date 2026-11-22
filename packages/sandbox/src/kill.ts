import { shellQuote } from "./process.ts";
import type { KillOptions, Sandbox } from "./types.ts";

/**
 * Terminate processes whose working directory is inside the workspace.
 * Used when a turn is cancelled; kills this agent's work without touching
 * the init process.
 */
export async function killSandboxWork(
  sandbox: Sandbox,
  options: KillOptions = {},
): Promise<number> {
  const base = shellQuote(sandbox.root.replace(/\/+$/, ""));
  const matches = `case "$c" in ${base}|${base}/*) true;; *) false;; esac`;
  const sweep = (signal: string) => `
    for p in /proc/[0-9]*; do
      pid=\${p#/proc/}
      [ "$pid" = "$$" ] && continue
      c=$(readlink "$p/cwd" 2>/dev/null) || continue
      ${matches} || continue
      kill -${signal} "$pid" 2>/dev/null && n=$((n + 1))
    done`;

  const result = await sandbox.exec(
    `n=0; ${sweep("TERM")}; sleep 1; ${sweep("KILL")}; echo "$n"`,
    { cwd: sandbox.root, timeoutMs: options.timeoutMs ?? 20_000 },
  );

  const count = Number(result.output.trim().split("\n").at(-1));
  return Number.isFinite(count) ? count : 0;
}
