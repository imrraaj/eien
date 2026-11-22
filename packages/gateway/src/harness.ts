import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  ConversationIdle,
  Harness,
  LiveDoc,
  configure,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type Conversation,
  type ConversationId,
  type EntryId,
  type Extension,
  type TaskId,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { createModelsRegistry } from "@eien/llm";
import type { Env, Logger } from "@eien/shared";
import {
  editText,
  readText,
  resolveInRoot,
  writeText,
  type Sandbox,
} from "@eien/sandbox";
import { runWebTool } from "@eien/tools";
import type { Context } from "grammy";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sendSandboxFile } from "./files.ts";
import { formatDuration, formatSchedules, parseDelay, type ScheduleInfo } from "./schedule.ts";

const CHORD = BACKGROUND_CONTEXT;

export interface RuntimeOptions {
  env: Env;
  modelId: string;
  modelProvider?: string;
  models: ReturnType<typeof createModelsRegistry>;
  system: string;
  storageDir: string;
  chatMapPath: string;
  sandbox: Sandbox;
  log: Logger;
  /** Deliver an agent answer to a chat, optionally quoting a message. */
  onAnswer: (chatId: string, text: string, replyTo?: number) => Promise<void>;
}

export interface AgentRuntime {
  run(ctx: Context, chatId: string, text: string, requestId?: string): Promise<string>;
  steer(chatId: string, text: string, requestId?: string, replyTo?: number): Promise<boolean>;
  reset(chatId: string): Promise<void>;
  isBusy(chatId: string): boolean;
  /** Formatted schedule list for a chat. */
  schedules(chatId: string): Promise<string>;
  /** Cancel a named schedule; false when there is none. */
  cancelSchedule(chatId: string, name: string): Promise<boolean>;
}

type SubagentRecord = {
  conversationId: ConversationId;
  reported: EntryId[];
};

const Subagents = defineDoc<{
  agents: Record<string, SubagentRecord>;
  reporters: Record<string, TaskId>;
}>({
  checkpointWhen: () => false,
  kind: "eien.subagents",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ agents: {}, reporters: {} }),
});

/** Background boundary so a subagent outlives the turn that spawned it. */
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "eien.subagent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_input, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      ),
  },
  abort: (_input, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type ReporterInput = {
  name: string;
  conversationId: ConversationId;
  message: string;
  followUp: boolean;
};
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

/** Deliver one message to a subagent and report its answer back to the main agent. */
const Reporter = defineTask<ReporterInput, ReporterState, null>({
  name: "eien.subagent-reporter",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (reporter, runtime, context) => {
      const { name, conversationId, message, followUp } = reporter.input;
      const subagent = await runtime.conversation(conversationId, context);
      if (!subagent) throw new Error("subagent conversation is gone");

      const submission = await subagent.submit(
        {
          type: "input",
          content: message,
          whenBusy: followUp ? "followUp" : "steer",
          requestId: `subagent:${reporter.id}`,
        },
        context,
      );
      const settled = await submission.wait(context);

      await runtime.commit(async (tx) => {
        const next = (report?: string) =>
          ({ status: "running", checkpoint: { phase: "report", report } }) as const;

        if (settled.status === "unanswered") {
          return next(
            settled.reason === "aborted" ? undefined : `[subagent ${name} failed: ${settled.reason}]`,
          );
        }
        if (settled.type !== "input" || settled.answer === undefined) return next();

        const doc = await tx.doc(Subagents, runtime.conversationId);
        const agent = doc.agents[name];
        if (!agent || agent.reported.includes(settled.answer)) return next();
        agent.reported.push(settled.answer);

        const entry = await tx.entry(AssistantEntry, settled.answer);
        const message = entry?.model?.[0];
        const parts = Array.isArray(message?.content) ? message.content : [];
        const text = parts
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("")
          .trim();

        return next(`[subagent ${name} finished] ${text || "(no report)"}`);
      }, context);
    },

    report: async (reporter, runtime, context) => {
      const report = reporter.state.checkpoint.report;
      if (report !== undefined) {
        const main = await runtime.conversation(runtime.conversationId, context);
        if (main) {
          await main.submit(
            {
              type: "input",
              content: report,
              whenBusy: "followUp",
              requestId: `subagent-report:${reporter.id}`,
            },
            context,
          );
        }
      }
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      );
    },
  },
  abort: (_input, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type ScheduleInput = { name: string; prompt: string; at: number; everyMs?: number };
type ScheduleState = { phase: "wait"; at: number } | { phase: "deliver"; at: number };
type ScheduleEntry = {
  taskId: TaskId;
  prompt: string;
  everyMs?: number;
  nextAt: number;
};

/** Named schedules in this conversation, so they can be listed and cancelled. */
const Schedules = defineDoc<{ items: Record<string, ScheduleEntry> }>({
  checkpointWhen: () => false,
  kind: "eien.schedules",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
});

/**
 * Durable reminder: sleep, put the prompt back into the conversation, and, for a
 * repeating schedule, sleep again. Cancelling means deleting the doc entry; the
 * task drops itself when it wakes and finds none.
 */
const Schedule = defineTask<ScheduleInput, ScheduleState, null>({
  name: "eien.schedule",
  version: 1,
  initial: (input) => ({ phase: "wait", at: input.at }),
  phases: {
    wait: (task, runtime, context) =>
      runtime.sleepUntil(task.state.checkpoint.at, { phase: "deliver", at: task.state.checkpoint.at }, context),
    deliver: async (task, runtime, context) => {
      const due = task.state.checkpoint.at;
      const { name, prompt, everyMs } = task.input;

      const entry = (await runtime.snapshot(Schedules, runtime.conversationId, context))?.items[name];
      if (!entry) {
        // Cancelled while it slept.
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "aborted" } }),
          context,
        );
        return;
      }

      const main = await runtime.conversation(runtime.conversationId, context);
      if (main) {
        await main.submit(
          {
            type: "input",
            content: prompt,
            whenBusy: "followUp",
            requestId: `schedule:${runtime.taskId}:${due}`,
          },
          context,
        );
      }

      if (everyMs === undefined) {
        await runtime.commit(
          async (tx) => {
            const doc = await tx.doc(Schedules, runtime.conversationId);
            delete doc.items[name];
            return { status: "terminal", outcome: { status: "completed", result: null } };
          },
          context,
        );
        return;
      }

      // Skip repeats missed while the process was down instead of firing them all.
      const next = Math.max(runtime.now(), due + everyMs);
      await runtime.commit(
        async (tx) => {
          const doc = await tx.doc(Schedules, runtime.conversationId);
          const current = doc.items[name];
          if (!current) {
            return { status: "terminal", outcome: { status: "aborted" } };
          }
          current.nextAt = next;
          return { status: "running", checkpoint: { phase: "wait", at: next } };
        },
        context,
      );
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

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
        typeof (block as { text?: string }).text === "string",
    )
    .map((block) => block.text)
    .join("")
    .trim();
}

function toolResult(text: string, isError = false): ToolExecutionResult {
  return { output: [{ type: "text", text }], isError };
}

function scheduleInfos(items: Record<string, ScheduleEntry>): ScheduleInfo[] {
  return Object.entries(items).map(([name, item]) => ({
    name,
    prompt: item.prompt,
    everyMs: item.everyMs,
    nextAt: item.nextAt,
  }));
}

export async function createAgentRuntime(options: RuntimeOptions): Promise<AgentRuntime> {
  const { env, sandbox, log } = options;
  const contexts = new Map<ConversationId, Context>();
  const watched = new Set<string>();

  await mkdir(options.storageDir, { recursive: true });
  const storage = await openNodeJsonlStorage(options.storageDir, CHORD);

  // ── sandbox and web tools ────────────────────────────────────────────────
  const bash = defineTool({
    name: "bash",
    description:
      "Run a bash command inside the agent sandbox VM (not on the host). The working directory is the workspace root.",
    parameters: obj({ command: str(), timeoutSec: opt(num()) }),
    execute: async (args) => {
      const seconds = Math.min(900, Math.max(1, Math.trunc(args.timeoutSec ?? 120)));
      const result = await sandbox.exec(args.command, { timeoutMs: seconds * 1_000 });
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
      const result = await readText(sandbox, args.path, {
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
      toolResult(await writeText(sandbox, args.path, args.content)),
  });

  const edit = defineTool({
    name: "edit",
    description: "Replace exactly one occurrence of `old` with `new` in a sandbox file.",
    parameters: obj({ path: str(), old: str(), new: str() }),
    execute: async (args) => {
      const result = await editText(sandbox, args.path, args.old, args.new);
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
      const remote = resolveInRoot(sandbox.root, args.path);
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
    description: "Search the web for current information.",
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

  // ── subagents ────────────────────────────────────────────────────────────
  let subagentExtension: Extension;

  const subagent = defineTool({
    name: "subagent",
    description:
      "Manage persistent background subagents that keep working after your turn ends. Actions: spawn (name, message), send (name, message; followUp: true queues it after its current answer instead of steering), stop (name), status (name or all). Answers are reported back to you as new messages.",
    parameters: obj({
      action: oneOf(["spawn", "send", "stop", "status"]),
      name: opt(str()),
      message: opt(str()),
      followUp: opt(bool()),
    }),
    replay: "unsafe",
    execute: async (args, api, callContext) => {
      const { action, name, message, followUp } = args;
      const reply = (text: string, conversationId?: ConversationId) => ({
        output: [{ type: "text" as const, text }],
        ...(conversationId === undefined || name === undefined
          ? {}
          : { details: { name, conversationId } }),
      });

      const registry = (await api.snapshot(Subagents, api.conversationId, callContext)) ?? {
        agents: {},
        reporters: {},
      };

      if (action === "status") {
        const names = name === undefined ? Object.keys(registry.agents) : [name];
        const lines: string[] = [];
        for (const each of names) {
          const found = Object.hasOwn(registry.agents, each) ? registry.agents[each] : undefined;
          if (!found) continue;
          const busy =
            (await api.snapshot(LiveDoc, found.conversationId, callContext))?.run !== undefined;
          lines.push(`${each}: ${busy ? "working" : "idle"}`);
        }
        return reply(lines.length === 0 ? "No subagents." : lines.join("\n"));
      }

      if (name === undefined) return reply(`${action} needs a name.`);
      const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : undefined;
      if (action !== "spawn" && !agent) return reply(`No subagent named ${name}.`);

      if (action === "stop") {
        const target = await api.conversation(agent!.conversationId, callContext);
        await target?.abort(callContext);
        return reply(`Stopped ${name}.`, agent!.conversationId);
      }

      if (message === undefined) return reply(`${action} needs a message.`);

      const result = await api.commit(async (tx) => {
        const state = await tx.doc(Subagents, api.conversationId);
        const background = { ownership: { kind: "conversation" }, background: true } as const;

        if (action === "spawn") {
          if (Object.hasOwn(state.agents, name)) return `${name} already exists; use send.`;
          const anchor = await tx.createTask(Anchor, null, background);
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: anchor },
          });
          await configure(tx, child.id, {
            extensions: { remove: [subagentExtension] },
            instructions: `You are the subagent "${name}". Work autonomously and answer the main agent's requests with a concise report.`,
          });
          state.agents[name] = { conversationId: child.id, reported: [] };
        }

        const conversationId = state.agents[name]!.conversationId;
        const input = {
          name,
          conversationId,
          message,
          followUp: action === "send" && followUp === true,
        };
        state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
        return action === "send" ? `Sent to ${name}.` : `Started ${name}.`;
      }, callContext);

      const current = (await api.snapshot(Subagents, api.conversationId, callContext))?.agents[name];
      return reply(result, current?.conversationId);
    },
  });

  const schedule = defineTool({
    name: "schedule",
    description:
      "Durable timers for this chat. action=add (default): schedule({ name, prompt, delay, every? }) runs the prompt later; with every it repeats. action=cancel stops one by name, action=list shows them. Delays look like \"30s\", \"2m\", \"1h\". Survives restarts.",
    parameters: obj({
      action: opt(oneOf(["add", "list", "cancel"])),
      name: opt(str()),
      delay: opt(str()),
      every: opt(str()),
      prompt: opt(str()),
    }),
    execute: async (args, api, callContext) => {
      const action = args.action ?? "add";
      const readItems = async () =>
        (await api.snapshot(Schedules, api.conversationId, callContext))?.items ?? {};

      if (action === "list") {
        return toolResult(formatSchedules(scheduleInfos(await readItems()), api.now()));
      }

      const name = args.name?.trim();
      if (!name) return toolResult(`${action} needs a name.`, true);

      if (action === "cancel") {
        const entry = (await readItems())[name];
        if (!entry) return toolResult(`No schedule named ${name}.`, true);
        await api.commit(async (tx) => {
          const doc = await tx.doc(Schedules, api.conversationId);
          delete doc.items[name];
        }, callContext);
        await harness.abortTask(entry.taskId, callContext).catch(() => undefined);
        return toolResult(`Cancelled ${name}.`);
      }

      const prompt = args.prompt;
      if (prompt === undefined) return toolResult("add needs a prompt.", true);
      const delay = parseDelay(args.delay ?? "");
      if (delay === undefined) {
        return toolResult(`invalid delay "${args.delay ?? ""}"; use e.g. 30s, 2m, 1h`, true);
      }
      if (delay > 30 * 86_400_000) return toolResult("delay is too long (max 30 days)", true);

      const everyMs = args.every === undefined ? undefined : parseDelay(args.every);
      if (args.every !== undefined && everyMs === undefined) {
        return toolResult(`invalid repeat "${args.every}"; use e.g. 15m, 1h`, true);
      }
      if (everyMs !== undefined && everyMs < 10_000) {
        return toolResult("a repeating schedule must be at least 10s apart", true);
      }

      if (Object.hasOwn(await readItems(), name)) {
        return toolResult(`"${name}" already exists; cancel it first or pick another name.`, true);
      }

      const at = api.now() + delay;
      await api.commit(async (tx) => {
        const doc = await tx.doc(Schedules, api.conversationId);
        if (doc.items[name]) throw new Error(`schedule "${name}" already exists`);
        const taskId = await tx.createTask(
          Schedule,
          { name, prompt, at, everyMs },
          { ownership: { kind: "conversation" }, background: true },
        );
        doc.items[name] = { taskId, prompt, everyMs, nextAt: at };
      }, callContext);

      return toolResult(
        everyMs === undefined
          ? `Scheduled "${name}" in ${formatDuration(delay)}.`
          : `Scheduled "${name}" every ${formatDuration(everyMs)}, first in ${formatDuration(delay)}.`,
      );
    },
  });

  subagentExtension = defineExtension({
    name: "eien-subagents",
    tasks: [Anchor, Reporter],
    tools: [subagent],
  });

  const toolsExtension = defineExtension({
    name: "eien-tools",
    tasks: [Schedule],
    tools: [bash, read, write, edit, sendFile, webSearch, webFetch, schedule],
  });

  const registry = createRegistry();
  registry.install(toolsExtension);
  registry.install(subagentExtension);

  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry,
      onReport: (report) => log.error("durable report", { report }),
    },
    CHORD,
  );

  // A failed session never recovers by itself; exit so the supervisor restarts us
  // with a fresh open instead of silently rejecting every later call.
  void harness.closed.then((end) => {
    if (end.kind !== "failed") return;
    log.error("durable storage failed; exiting", { error: end.error });
    setTimeout(() => process.exit(1), 100);
  });

  // ── chat -> conversation mapping ─────────────────────────────────────────
  await mkdir(dirname(options.chatMapPath), { recursive: true });
  const chatMap = new Map<string, number>();
  try {
    const saved = JSON.parse(await readFile(options.chatMapPath, "utf8")) as Record<string, number>;
    for (const [chat, conversation] of Object.entries(saved)) chatMap.set(chat, conversation);
  } catch {
    // First run.
  }

  let saving = Promise.resolve();
  const saveMap = () => {
    saving = saving
      .then(() =>
        writeFile(options.chatMapPath, JSON.stringify(Object.fromEntries(chatMap), null, 2)),
      )
      .catch((error: unknown) => log.warn("could not save chat map", { error }));
    return saving;
  };

  const busy = new Set<string>();
  /** Telegram message to quote when answering, per chat. */
  const replyTargets = new Map<string, number>();

  /**
   * Forward finished answers to Telegram. This is also how a background subagent's
   * report reaches the chat after its follow-up run answers.
   */
  async function watchConversation(conversation: Conversation, chatId: string): Promise<void> {
    if (watched.has(chatId)) return;
    watched.add(chatId);

    const watch = await conversation.watch(CHORD);
    let newest = watch.value.entries.at(-1)?.id ?? 0;

    watch.start(async (call) => {
      if (call.kind !== "value") return;

      for (const entry of call.value.entries) {
        if (entry.id <= newest) continue;
        newest = entry.id;
        if (entry.kind !== "pi.assistant") continue;

        const message = entry.model?.[0];
        const content = Array.isArray(message?.content) ? message.content : [];
        // Text emitted alongside a tool call is progress chatter, not an answer.
        if (content.some((block) => block.type === "toolCall")) continue;

        const text = textOf(entry);
        if (!text) continue;

        await options.onAnswer(chatId, text, replyTargets.get(chatId)).catch((error: unknown) => {
          log.error("could not deliver answer", { chatId, error });
        });
      }
    });
  }

  const provider = options.modelProvider ?? "eien";

  /**
   * Conversations keep the agent settings they were created with, so after a
   * model or prompt change the stored model can point at a model the registry no
   * longer has (a run then fails `no_model`). Bring those settings up to date.
   */
  async function syncAgent(conversation: Conversation): Promise<void> {
    const agent = await conversation.agent(CHORD);
    const stale =
      agent.model?.provider !== provider ||
      agent.model?.modelId !== options.modelId ||
      agent.instructions !== options.system ||
      agent.cwd !== sandbox.root ||
      agent.maxTurns !== env.MAX_AGENT_STEPS;
    if (!stale) return;

    await conversation.configure(
      {
        model: { provider, modelId: options.modelId },
        instructions: options.system,
        cwd: sandbox.root,
        maxTurns: env.MAX_AGENT_STEPS,
      },
      CHORD,
    );
  }

  async function conversationFor(chatId: string): Promise<Conversation> {
    const existing = chatMap.get(chatId);
    if (existing !== undefined) {
      const conversation = await harness.conversation(
        existing as unknown as ConversationId,
        CHORD,
      );
      if (conversation) {
        await syncAgent(conversation);
        await watchConversation(conversation, chatId);
        return conversation;
      }
    }

    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider, modelId: options.modelId },
          extensions: [toolsExtension, subagentExtension],
          instructions: options.system,
          cwd: sandbox.root,
          maxTurns: env.MAX_AGENT_STEPS,
        },
      },
      CHORD,
    );

    chatMap.set(chatId, conversation.id as unknown as number);
    await saveMap();
    await watchConversation(conversation, chatId);
    return conversation;
  }

  // Reattach watchers for every known chat and let pending durable work run
  // again after a restart (sleeps, reporters, interrupted generations).
  for (const [chatId, conversationId] of chatMap) {
    const conversation = await harness.conversation(
      conversationId as unknown as ConversationId,
      CHORD,
    );
    if (conversation) {
      await syncAgent(conversation);
      await watchConversation(conversation, chatId);
    }
  }
  harness.resume();
  log.info("durable runtime ready", { chats: chatMap.size });

  return {
    isBusy: (chatId) => busy.has(chatId),

    async run(ctx, chatId, text, requestId) {
      const conversation = await conversationFor(chatId);
      contexts.set(conversation.id, ctx);
      const messageId = ctx.message?.message_id;
      if (messageId !== undefined) replyTargets.set(chatId, messageId);
      busy.add(chatId);

      try {
        const submission = await conversation.submit(
          { type: "input", content: text, requestId },
          CHORD,
        );
        const settled = await submission.wait(CHORD);

        // The watcher delivers the answer; only failures need a direct reply.
        if (settled.status === "done") return "";

        if (settled.reason === "turn_limit") {
          return "Hit the step limit. Send another message to continue.";
        }
        const detail =
          typeof settled.detail === "string"
            ? settled.detail
            : settled.detail === undefined
              ? undefined
              : JSON.stringify(settled.detail);
        return `Stopped (${settled.status}${settled.reason ? `: ${settled.reason}` : ""}${detail ? ` — ${detail}` : ""}).`;
      } finally {
        busy.delete(chatId);
        contexts.delete(conversation.id);
      }
    },

    async steer(chatId, text, requestId, replyTo) {
      const conversation = await conversationFor(chatId);
      if (replyTo !== undefined) replyTargets.set(chatId, replyTo);
      try {
        await conversation.submit(
          { type: "input", content: text, requestId, whenBusy: "steer", whenIdle: "reject" },
          CHORD,
        );
        return true;
      } catch (error) {
        if (!(error instanceof ConversationIdle)) {
          log.warn("steer rejected", { chatId, error });
          return false;
        }
        // No run to steer (it finished, or has not started yet): let the message
        // start the next turn instead of making the user send it again.
        await conversation.submit({ type: "input", content: text, requestId }, CHORD);
        return true;
      }
    },

    async reset(chatId) {
      const conversation = await conversationFor(chatId);
      await conversation.reset(undefined, CHORD);
    },

    async schedules(chatId) {
      const conversation = await conversationFor(chatId);
      // Copy inside the commit: document drafts die once it settles.
      const infos = await conversation.commit(async (tx) => {
        const items = (await tx.doc(Schedules, conversation.id)).items;
        return scheduleInfos(items);
      }, CHORD);
      return formatSchedules(infos, Date.now());
    },

    async cancelSchedule(chatId, name) {
      const conversation = await conversationFor(chatId);
      const taskId = await conversation.commit(async (tx) => {
        const doc = await tx.doc(Schedules, conversation.id);
        const found = doc.items[name];
        if (!found) return undefined;
        delete doc.items[name];
        return found.taskId;
      }, CHORD);
      if (taskId === undefined) return false;
      await harness.abortTask(taskId, CHORD).catch(() => undefined);
      return true;
    },
  };
}
