import { validateToolCall, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import {
  editText,
  readText,
  resolveInRoot,
  sbxExec,
  writeText,
  type SandboxConfig,
} from "@eien/sandbox";
import { runWebTool, webTools, type WebOptions } from "./web.ts";
import { runSpawnTool, spawnTool, type SpawnInput } from "./spawn.ts";

export { webTools, type WebOptions } from "./web.ts";
export { spawnTool, type SpawnInput } from "./spawn.ts";

export interface OutgoingFile {
  /** Absolute path inside the sandbox workspace. */
  path: string;
  caption?: string;
}

export interface ToolContext {
  sandbox: SandboxConfig;
  /** Absolute workspace root inside the sandbox. */
  root: string;
  web: WebOptions;
  /** Upload a sandbox file to the chat. Returns a short status line. */
  sendFile?: (file: OutgoingFile) => Promise<string>;
  /** Run a nested worker turn. Returns its final report. */
  spawnAgent?: (input: SpawnInput) => Promise<string>;
  signal?: AbortSignal;
}

export interface ToolRunResult {
  text: string;
  isError: boolean;
}

const jsonSchema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

export const sandboxTools: Tool[] = [
  {
    name: "bash",
    description:
      "Run a bash command inside the agent sandbox VM (not on the host). Use it for builds, tests, git, grep, package installs, and inspecting the workspace. The default working directory is the workspace root. Commands are killed after the timeout. Return stdout/stderr and the exit code.",
    parameters: jsonSchema(
      {
        command: { type: "string", description: "Bash command to execute." },
        timeoutSec: {
          type: "number",
          description: "Timeout in seconds (1-900, default 120).",
        },
      },
      ["command"],
    ),
  },
  {
    name: "read",
    description:
      "Read a UTF-8 text file from the sandbox workspace. Paths may be relative to the workspace root or absolute inside it. Returns up to 2000 lines starting at `offset` (1-based).",
    parameters: jsonSchema(
      {
        path: { type: "string", description: "File path inside the workspace." },
        offset: {
          type: "number",
          description: "First line to return (1-based, default 1).",
        },
        limit: {
          type: "number",
          description: "Maximum lines to return (default 400, max 2000).",
        },
      },
      ["path"],
    ),
  },
  {
    name: "write",
    description:
      "Create or overwrite a UTF-8 text file in the sandbox workspace. Creates parent directories. Use `edit` for small changes to an existing file.",
    parameters: jsonSchema(
      {
        path: { type: "string", description: "File path inside the workspace." },
        content: { type: "string", description: "Full file content." },
      },
      ["path", "content"],
    ),
  },
  {
    name: "edit",
    description:
      "Replace exactly one occurrence of `old` with `new` in a sandbox file. Fails when the old text is missing or appears more than once, so include enough surrounding context to be unique.",
    parameters: jsonSchema(
      {
        path: { type: "string", description: "File path inside the workspace." },
        old: { type: "string", description: "Exact text to replace." },
        new: { type: "string", description: "Replacement text." },
      },
      ["path", "old", "new"],
    ),
  },
  {
    name: "send_file",
    description:
      "Upload a file from the sandbox workspace to the current Telegram chat as a document (any type: image, video, audio, zip, pdf, html...). Use it to deliver results the user asked for. Max 50 MB. The path must be inside the workspace.",
    parameters: jsonSchema(
      {
        path: { type: "string", description: "File path inside the workspace." },
        caption: {
          type: "string",
          description: "Optional short caption (max 1024 characters).",
        },
      },
      ["path"],
    ),
  },
];

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`"${key}" must be a string`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`"${key}" must be a number`);
  }
  return value;
}

/** Validate arguments and execute one tool call against the sandbox. */
export async function runTool(
  call: ToolCall,
  context: ToolContext,
): Promise<ToolRunResult> {
  let args: Record<string, unknown>;
  try {
    args = validateToolCall(sandboxTools, call) as Record<string, unknown>;
  } catch (error) {
    return {
      text: `invalid arguments: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }

  try {
    switch (call.name) {
      case "bash": {
        const timeoutSec = Math.min(300, Math.max(1, Math.trunc(optionalNumber(args, "timeoutSec") ?? 120)));
        const result = await sbxExec(context.sandbox, str(args, "command"), {
          cwd: context.root,
          timeoutMs: timeoutSec * 1_000,
          signal: context.signal,
        });
        const output = result.output.trim();
        const suffix = result.timedOut ? `\n(command timed out after ${timeoutSec}s)` : "";
        return {
          text: `exit code: ${result.exitCode}\n${output || "(no output)"}${suffix}`,
          isError: result.exitCode !== 0 || result.timedOut,
        };
      }

      case "read": {
        const result = await readText(context.sandbox, context.root, str(args, "path"), {
          offset: optionalNumber(args, "offset"),
          limit: optionalNumber(args, "limit"),
          signal: context.signal,
        });
        return {
          text: `${result.path} (lines ${result.startLine}-${result.endLine})${result.truncated ? " [output truncated]" : ""}\n${result.text || "(empty)"}`,
          isError: false,
        };
      }

      case "write": {
        const message = await writeText(
          context.sandbox,
          context.root,
          str(args, "path"),
          str(args, "content"),
          { signal: context.signal },
        );
        return { text: message, isError: false };
      }

      case "edit": {
        const result = await editText(
          context.sandbox,
          context.root,
          str(args, "path"),
          str(args, "old"),
          str(args, "new"),
          { signal: context.signal },
        );
        return {
          text: `replaced 1 occurrence at ${result.path}:${result.line}`,
          isError: false,
        };
      }

      case "send_file": {
        if (!context.sendFile) {
          return { text: "sending files is not available in this chat", isError: true };
        }
        const remotePath = resolveInRoot(context.root, str(args, "path"));
        const rawCaption = args.caption;
        const caption =
          typeof rawCaption === "string" && rawCaption.trim()
            ? rawCaption.trim().slice(0, 1024)
            : undefined;
        const status = await context.sendFile({ path: remotePath, caption });
        return { text: status, isError: false };
      }

      default:
        return { text: `unknown tool: ${call.name}`, isError: true };
    }
  } catch (error) {
    return {
      text: `tool failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

/** Every tool exposed to the agent: sandbox coding tools plus web tools. */
export const agentTools: Tool[] = [...sandboxTools, ...webTools, spawnTool];

/** Route a tool call to the sandbox, the web client, or a worker agent. */
export async function runAgentTool(
  call: ToolCall,
  context: ToolContext,
): Promise<ToolRunResult> {
  if (call.name === "web_search" || call.name === "web_fetch") {
    return runWebTool(call, context.web, context.signal);
  }
  if (call.name === "spawn_agent") {
    return runSpawnTool(call, context);
  }
  return runTool(call, context);
}
