import { validateToolCall, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { resolveInRoot } from "@eien/sandbox";

export interface SpawnInput {
  /** Complete, self-contained task for the worker. */
  task: string;
  /** Absolute workspace-relative directory the worker should start in. */
  cwd: string;
  maxSteps: number;
}

export interface SpawnContext {
  root: string;
  spawnAgent?: (input: SpawnInput) => Promise<string>;
}

export interface SpawnResult {
  text: string;
  isError: boolean;
}

const MAX_TASK_CHARS = 8_000;

export const spawnTool: Tool = {
  name: "spawn_agent",
  description:
    "Delegate a self-contained task to a worker agent that runs its own turn. Only the worker's concise final report returns to you, so this keeps noisy exploration, long builds, and mass file work out of your context. Give a complete brief: exact paths, what to do, and what 'done' means. The worker shares the workspace; give overlapping workers separate directories to avoid collisions.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Complete instructions for the worker, including paths and acceptance criteria.",
      },
      cwd: {
        type: "string",
        description: "Directory inside the workspace to start in (default: workspace root).",
      },
      maxSteps: {
        type: "number",
        description: "Worker step budget (default 40, max 80).",
      },
    },
    required: ["task"],
    additionalProperties: false,
  },
};

/** Run a spawn_agent call against the gateway-provided worker runner. */
export async function runSpawnTool(
  call: ToolCall,
  context: SpawnContext,
): Promise<SpawnResult> {
  let args: Record<string, unknown>;
  try {
    args = validateToolCall([spawnTool], call) as Record<string, unknown>;
  } catch (error) {
    return {
      text: `invalid arguments: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }

  if (!context.spawnAgent) {
    return { text: "worker agents are not available in this context", isError: true };
  }

  const task = String(args.task ?? "").trim();
  if (!task) return { text: "task must not be empty", isError: true };
  if (task.length > MAX_TASK_CHARS) {
    return { text: `task is too long (${task.length} > ${MAX_TASK_CHARS})`, isError: true };
  }

  const rawSteps = Number(args.maxSteps ?? 40);
  const maxSteps = Math.min(80, Math.max(1, Number.isFinite(rawSteps) ? Math.trunc(rawSteps) : 40));

  try {
    const cwd = resolveInRoot(
      context.root,
      String(args.cwd ?? context.root).trim() || context.root,
    );
    return { text: await context.spawnAgent({ task, cwd, maxSteps }), isError: false };
  } catch (error) {
    return {
      text: `worker failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}
