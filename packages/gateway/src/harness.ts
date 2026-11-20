import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  type Conversation,
  type ConversationId,
  type EntryId,
  type Extension,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { createModelsRegistry } from "@eien/llm";
import type { Env, Logger } from "@eien/shared";
import {
  editText,
  killSandboxWork,
  readText,
  resolveInRoot,
  sbxExec,
  writeText,
  type SandboxConfig,
} from "@eien/sandbox";
import { runWebTool } from "@eien/tools";
import type { Context } from "grammy";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sendSandboxFile } from "./files.ts";

const CHORD = BACKGROUND_CONTEXT;

export interface RuntimeOptions {
  env: Env;
  modelId: string;
  models: ReturnType<typeof createModelsRegistry>;
  system: string;
  storageDir: string;
  chatMapPath: string;
  sandbox: SandboxConfig;
  log: Logger;
}

export interface AgentRuntime {
  run(
    ctx: Context,
    chatId: string,
    text: string,
    onProgress?: () => void,
  ): Promise<string>;
  steer(chatId: string, text: string): Promise<boolean>;
  abort(chatId: string): Promise<void>;
  reset(chatId: string): Promise<void>;
  isBusy(chatId: string): boolean;
}

function textOf(entry: unknown): string {
  const model = (entry as { model?: unknown }).model;
  if (!Array.isArray(model)) return "";

  return model
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      return Array.isArray(content) ? content : [];
    })
    .filter(
      (block): block is { type: "text"; text: string } =>
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("")
    .trim();
}

function toolResult(text: string, isError = false): ToolExecutionResult {
  return { output: [{ type: "text", text }], isError };
}

/**
 * pi-durable backed runtime: durable turns, native steering, child conversations.
 */
export async function createAgentRuntime(options: RuntimeOptions): Promise<AgentRuntime> {
  const { env, sandbox, log } = options;
  const contexts = new Map<ConversationId, Context>();

  await mkdir(options.storageDir, { recursive: true });
  const storage = await openNodeJsonlStorage(options.storageDir, CHORD);

  // ── tools ────────────────────────────────────────────────────────────────
  const bash = defineTool({
    name: "bash",
    description:
      "Run a bash command inside the agent sandbox VM (not on the host). The working directory is the workspace root.",
    parameters: obj({ command: str(), timeoutSec: opt(num()) }),
    execute: async (args) => {
      const seconds = Math.min(900, Math.max(1, Math.trunc(args.timeoutSec ?? 120)));
      const result = await sbxExec(sandbox, args.command, {
        cwd: env.SBX_WORKDIR,
        timeoutMs: seconds * 1_000,
      });
      const suffix = result.timedOut ? `\n(command timed out after ${seconds}s)` : "";
      return toolResult(
        `exit code: ${result.exitCode}\n${result.output.trim() || "(no output)"}${suffix}`,
        result.exitCode !== 0 || result.timedOut,
      );
    },
  });

  const read = defineTool({
    name: "read",
    description: "Read a UTF-8 text file from the sandbox workspace.",
    parameters: obj({ path: str(), offset: opt(num()), limit: opt(num()) }),
    execute: async (args) => {
      const result = await readText(sandbox, env.SBX_WORKDIR, args.path, {
        offset: args.offset,
        limit: args.limit,
      });
      return toolResult(
        `${result.path} (lines ${result.startLine}-${result.endLine})${result.truncated ? " [truncated]" : ""}\n${result.text || "(empty)"}`,
      );
    },
  });

  const write = defineTool({
    name: "write",
    description: "Create or overwrite a UTF-8 text file in the sandbox workspace.",
    parameters: obj({ path: str(), content: str() }),
    execute: async (args) =>
      toolResult(await writeText(sandbox, env.SBX_WORKDIR, args.path, args.content)),
  });

  const edit = defineTool({
    name: "edit",
    description:
      "Replace exactly one occurrence of `old` with `new` in a sandbox file.",
    parameters: obj({ path: str(), old: str(), new: str() }),
    execute: async (args) => {
      const result = await editText(
        sandbox,
        env.SBX_WORKDIR,
        args.path,
        args.old,
        args.new,
      );
      return toolResult(`replaced 1 occurrence at ${result.path}:${result.line}`);
    },
  });

  const sendFile = defineTool({
    name: "send_file",
    description:
      "Upload a file from the sandbox workspace to the current Telegram chat (max 50 MB).",
    parameters: obj({ path: str(), caption: opt(str()) }),
    execute: async (args, api) => {
      const telegram = contexts.get(api.conversationId);
      if (!telegram) return toolResult("sending files is not available in this chat", true);
      const remote = resolveInRoot(env.SBX_WORKDIR, args.path);
      return toolResult(
        await sendSandboxFile(telegram, sandbox, {
          path: remote,
          caption: args.caption?.trim() || undefined,
        }),
      );
    },
  });

  const webSearch = defineTool({
    name: "web_search",
    description:
      "Search the web for current information. Returns titles, URLs, and snippets.",
    parameters: obj({ query: str(), numResults: opt(num()) }),
    execute: async (args) => {
      const result = await runWebTool(
        {
          type: "toolCall",
          id: "web",
          name: "web_search",
          arguments: { query: args.query, numResults: args.numResults ?? 5 },
        },
        { mcpUrl: env.EXA_MCP_URL, exaApiKey: env.EXA_API_KEY },
      );
      return toolResult(result.text, result.isError);
    },
  });

  const webFetch = defineTool({
    name: "web_fetch",
    description: "Fetch one http(s) URL and return readable text.",
    parameters: obj({ url: str() }),
    execute: async (args) => {
      const result = await runWebTool(
        { type: "toolCall", id: "web", name: "web_fetch", arguments: { url: args.url } },
        { mcpUrl: env.EXA_MCP_URL, exaApiKey: env.EXA_API_KEY },
      );
      return toolResult(result.text, result.isError);
    },
  });

  let spawnExtension: Extension;
  const spawn = defineTool({
    name: "spawn_agent",
    description:
      "Delegate a self-contained task to a worker conversation. Only its final report returns to you. Give exact paths and acceptance criteria; give parallel workers separate directories.",
    parameters: obj({ task: str(), cwd: opt(str()), maxSteps: opt(num()) }),
    execute: async (args, api, context) => {
      const childId = await api.commit(async (tx) => {
        const created = await tx.createConversation({
          ownership: { kind: "task", taskId: api.taskId },
        });
        await configure(tx, created.id, {
          extensions: { remove: [spawnExtension] },
          cwd: resolveInRoot(env.SBX_WORKDIR, args.cwd ?? env.SBX_WORKDIR),
          maxTurns: Math.min(80, Math.max(1, Math.trunc(args.maxSteps ?? 40))),
        });
        return created.id;
      }, context);

      const child = await api.conversation(childId, context);
      if (!child) return toolResult("could not create the worker", true);

      const parentContext = contexts.get(api.conversationId);
      if (parentContext) contexts.set(childId, parentContext);

      const submission = await child.submit({ type: "input", content: args.task }, context);
      const settled = await submission.wait(context);

      if (settled.status !== "done" || settled.answer === undefined) {
        return toolResult(
          `worker did not finish (${settled.status}${settled.reason ? `: ${settled.reason}` : ""})`,
          true,
        );
      }

      const entry = await api.commit(
        (tx) =>
          (tx as unknown as { entry(id: EntryId): Promise<unknown> }).entry(
            settled.answer as EntryId,
          ),
        context,
      );
      return toolResult(textOf(entry) || "(worker returned no text)");
    },
  });

  const toolsExtension = defineExtension({
    name: "eien-tools",
    tools: [bash, read, write, edit, sendFile, webSearch, webFetch, spawn],
  });
  spawnExtension = toolsExtension;

  const registry = createRegistry();
  registry.install(toolsExtension);

  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry,
      onReport: (report) => log.error("durable report", { report }),
    },
    CHORD,
  );

  // ── chat -> conversation mapping ─────────────────────────────────────────
  await mkdir(dirname(options.chatMapPath), { recursive: true });
  const chatMap = new Map<string, number>();
  try {
    const saved = JSON.parse(await readFile(options.chatMapPath, "utf8")) as Record<
      string,
      number
    >;
    for (const [chat, conversation] of Object.entries(saved)) chatMap.set(chat, conversation);
  } catch {
    // First run.
  }

  let saving = Promise.resolve();
  const saveMap = () => {
    saving = saving
      .then(() =>
        writeFile(
          options.chatMapPath,
          JSON.stringify(Object.fromEntries(chatMap), null, 2),
        ),
      )
      .catch((error: unknown) => log.warn("could not save chat map", { error }));
    return saving;
  };

  const busy = new Set<string>();

  async function conversationFor(chatId: string): Promise<Conversation> {
    const existing = chatMap.get(chatId);
    if (existing) {
      const conversation = await harness.conversation(existing as unknown as ConversationId, CHORD);
      if (conversation) return conversation;
    }

    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: "eien", modelId: options.modelId },
          extensions: [toolsExtension],
          instructions: options.system,
          cwd: env.SBX_WORKDIR,
          maxTurns: env.MAX_AGENT_STEPS,
        },
      },
      CHORD,
    );

    chatMap.set(chatId, conversation.id as unknown as number);
    await saveMap();
    return conversation;
  }

  async function answerFor(
    conversation: Conversation,
    answerId: EntryId,
  ): Promise<string> {
    const entry = await conversation.commit((tx) => tx.entry(answerId), CHORD);
    return textOf(entry);
  }

  return {
    isBusy: (chatId) => busy.has(chatId),

    async run(ctx, chatId, text, onProgress) {
      const conversation = await conversationFor(chatId);
      contexts.set(conversation.id, ctx);
      busy.add(chatId);

      const timer = onProgress ? setTimeout(onProgress, 10_000) : undefined;

      try {
        const submission = await conversation.submit(
          { type: "input", content: text },
          CHORD,
        );
        const settled = await submission.wait(CHORD);

        if (settled.status === "done" && settled.answer !== undefined) {
          return answerFor(conversation, settled.answer);
        }

        return settled.reason === "turn_limit"
          ? "Hit the step limit. Send another message to continue."
          : `Stopped (${settled.status}${settled.reason ? `: ${settled.reason}` : ""}).`;
      } finally {
        if (timer) clearTimeout(timer);
        busy.delete(chatId);
        contexts.delete(conversation.id);
      }
    },

    async steer(chatId, text) {
      const conversation = await conversationFor(chatId);
      try {
        await conversation.submit(
          { type: "input", content: text, whenBusy: "steer", whenIdle: "reject" },
          CHORD,
        );
        return true;
      } catch (error) {
        log.warn("steer rejected", { chatId, error });
        return false;
      }
    },

    async abort(chatId) {
      const conversation = await conversationFor(chatId);
      await conversation.abort(CHORD).catch(() => undefined);
      await killSandboxWork(sandbox, env.SBX_WORKDIR).catch(() => 0);
    },

    async reset(chatId) {
      const conversation = await conversationFor(chatId);
      await conversation.reset(undefined, CHORD);
    },
  };
}
