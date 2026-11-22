import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  LiveDoc,
  createRegistry,
  defineExtension,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type EntryId,
  type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { addressKey, parseAddressKey, type Address, type Attachment, type OutboundMessage } from "@eien/io";
import { PROVIDER_ID, type createModelsRegistry } from "@eien/llm";
import { statSandboxFile, type Sandbox } from "@eien/sandbox";
import { formatBytes, type Logger } from "@eien/shared";
import type { WebOptions } from "@eien/tools";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Chats, Delivery } from "./chats.ts";
import { answerText, callsTools } from "./entries.ts";
import type { ScheduleInfo } from "./schedule-text.ts";
import { Schedule, Schedules, createScheduleTool, scheduleInfos } from "./schedules.ts";
import { openSqliteStorage } from "./sqlite.ts";
import { SubagentExtension } from "./subagents.ts";
import { createWorkTools } from "./tools.ts";
import { ingestAttachments } from "./uploads.ts";

const CHORD = BACKGROUND_CONTEXT;

/** Where the runtime sends what the agent says. `OutputRouter` from `@eien/io` is one. */
export interface Outbox {
  send(to: Address, message: OutboundMessage): Promise<void>;
}

export interface RuntimeOptions {
  storagePath: string;
  models: ReturnType<typeof createModelsRegistry>;
  modelId: string;
  maxTurns: number;
  sandbox: Sandbox;
  web: WebOptions;
  outbox: Outbox;
  /** System prompt for chats on a service. */
  instructions: (service: string) => string;
  log: Logger;
}

/** The durable agent loop. It knows addresses, never the services behind them. */
export interface AgentRuntime {
  /**
   * Start a run, or steer the running one. Attachments go into the sandbox first.
   * Resolves once the message is durably admitted.
   */
  prompt(from: Address, text: string, requestId: string, attachments?: readonly Attachment[]): Promise<void>;
  reset(chat: Address): Promise<void>;
  schedules(chat: Address): Promise<ScheduleInfo[]>;
  /** False when there is no schedule by that name. */
  cancelSchedule(chat: Address, name: string): Promise<boolean>;
  close(): Promise<void>;
}

function failureText(settled: SettledSubmissionRecord): string | undefined {
  if (settled.status === "done" || settled.reason === "aborted") return undefined;
  if (settled.reason === "turn_limit") return "Hit the step limit. Send another message to continue.";
  const detail =
    settled.detail === undefined
      ? ""
      : `: ${typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail)}`;
  return `That run failed (${settled.reason}${detail}).`;
}

export async function createAgentRuntime(options: RuntimeOptions): Promise<AgentRuntime> {
  const { sandbox, outbox, log } = options;

  /** Open conversations by address key, and the reverse for tools that only know the conversation. */
  const conversations = new Map<string, Promise<Conversation>>();
  const addresses = new Map<ConversationId, Address>();
  /** Unsettled submissions per chat; the chat goes idle when this reaches zero. */
  const inFlight = new Map<string, number>();

  const send = (to: Address, message: OutboundMessage) =>
    outbox.send(to, message).catch((error: unknown) => log.error("could not deliver", { to, kind: message.kind, error }));

  async function deliverFile(conversationId: ConversationId, remotePath: string, caption?: string): Promise<string> {
    const to = addresses.get(conversationId);
    if (!to) throw new Error("this conversation has no chat to send files to");

    const info = await statSandboxFile(sandbox, remotePath);
    if (!info.type.includes("regular")) throw new Error(`${remotePath} is not a regular file (${info.type})`);

    const dir = await mkdtemp(join(tmpdir(), "eien-out-"));
    const name = basename(remotePath) || "file";
    try {
      const localPath = join(dir, name);
      await sandbox.copyOut(remotePath, localPath);
      await outbox.send(to, { kind: "file", localPath, name, size: info.size, caption });
      return `sent ${name} (${formatBytes(info.size)}) to the chat`;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // Bound late: the schedule tool aborts through the Harness it is installed in.
  let harness: Harness | undefined;
  const toolsExtension = defineExtension({
    name: "eien-tools",
    tasks: [Schedule],
    tools: [
      ...createWorkTools(sandbox, options.web, deliverFile),
      createScheduleTool((id, context) => harness!.abortTask(id, context)),
    ],
  });
  const registry = createRegistry();
  registry.install(toolsExtension);
  registry.install(SubagentExtension);

  const opened = await Harness.open(
    await openSqliteStorage(options.storagePath),
    { models: options.models, registry, onReport: (report) => log.error("durable report", { report }) },
    CHORD,
  );
  harness = opened;

  // A failed session never recovers by itself; exit so the supervisor restarts us.
  void opened.closed.then((end) => {
    if (end.kind !== "failed") return;
    log.error("durable storage failed; exiting", { error: end.error });
    setTimeout(() => process.exit(1), 100);
  });

  const agentFor = (service: string) =>
    ({
      model: { provider: PROVIDER_ID, modelId: options.modelId },
      instructions: options.instructions(service),
      cwd: sandbox.root,
      maxTurns: options.maxTurns,
    }) satisfies AgentChange;

  /** Conversations keep the settings they were created with; bring them up to date after a config change. */
  async function syncAgent(conversation: Conversation, service: string): Promise<void> {
    const want = agentFor(service);
    const have = await conversation.agent(CHORD);
    const stale =
      have.model?.provider !== want.model.provider ||
      have.model?.modelId !== want.model.modelId ||
      have.instructions !== want.instructions ||
      have.cwd !== want.cwd ||
      have.maxTurns !== want.maxTurns;
    if (stale) await conversation.configure(want, CHORD);
  }

  /** Forward finished answers to the chat, from the last one delivered, and record each delivery. */
  async function deliverAnswers(conversation: Conversation, to: Address): Promise<void> {
    let delivered = await conversation.commit(async (tx) => (await tx.doc(Delivery, conversation.id)).delivered, CHORD);
    const watch = await conversation.watch(CHORD, { from: (delivered + 1) as EntryId });

    watch.start(async (call) => {
      if (call.kind !== "value") return;
      for (const entry of call.value.entries) {
        if (entry.id <= delivered) continue;
        delivered = entry.id;
        if (entry.kind !== "pi.assistant" || callsTools(entry)) continue;
        const text = answerText(entry);
        if (!text) continue;

        await send(to, { kind: "text", text });
        await conversation.commit(async (tx) => {
          const doc = await tx.doc(Delivery, conversation.id);
          doc.delivered = Math.max(doc.delivered, entry.id);
        }, CHORD);
      }
    });
  }

  async function attach(conversation: Conversation, to: Address): Promise<Conversation> {
    addresses.set(conversation.id, to);
    await syncAgent(conversation, to.service);
    await deliverAnswers(conversation, to);
    return conversation;
  }

  async function openOrCreate(to: Address): Promise<Conversation> {
    const key = addressKey(to);
    const known = await opened.commit(async (tx) => (await tx.doc(Chats)).conversations[key], CHORD);
    const existing = known === undefined ? undefined : await opened.conversation(known, CHORD);
    if (existing) return attach(existing, to);

    const created = await opened.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { ...agentFor(to.service), extensions: [toolsExtension, SubagentExtension] },
      },
      CHORD,
    );
    await opened.commit(async (tx) => {
      (await tx.doc(Chats)).conversations[key] = created.id;
    }, CHORD);
    return attach(created, to);
  }

  /** One open per chat, even when messages race in before the first open finishes. */
  function conversationFor(to: Address): Promise<Conversation> {
    const key = addressKey(to);
    let conversation = conversations.get(key);
    if (!conversation) {
      conversation = openOrCreate(to);
      conversations.set(key, conversation);
      conversation.catch(() => conversations.delete(key));
    }
    return conversation;
  }

  async function track(to: Address, settled: Promise<SettledSubmissionRecord>): Promise<void> {
    const key = addressKey(to);
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    try {
      const failure = failureText(await settled);
      if (failure) await send(to, { kind: "text", text: failure });
    } catch (error) {
      log.error("run crashed", { to, error });
      await send(to, { kind: "text", text: "That run crashed. Check the logs." });
    } finally {
      const left = (inFlight.get(key) ?? 1) - 1;
      if (left > 0) inFlight.set(key, left);
      else {
        inFlight.delete(key);
        await send(to, { kind: "status", status: "idle" });
      }
    }
  }

  // Reattach every known chat, then let work the last process left run again.
  const known = await opened.commit(async (tx) => Object.entries((await tx.doc(Chats)).conversations), CHORD);
  for (const [key, id] of known) {
    const to = parseAddressKey(key);
    const conversation = to && (await opened.conversation(id, CHORD));
    if (to && conversation) conversations.set(key, attach(conversation, to));
  }
  await Promise.all(conversations.values());
  opened.resume();
  log.info("durable runtime ready", { chats: conversations.size });

  return {
    async prompt(from, text, requestId, attachments = []) {
      const notes = await ingestAttachments(sandbox, attachments);
      const content = [text || (notes.length > 0 ? "The user sent this without instructions." : ""), ...notes].join("\n\n");
      const conversation = await conversationFor(from);
      const admitted = await conversation.commit(async (tx) => {
        const busy = (await tx.doc(LiveDoc, conversation.id)).run !== undefined;
        const id = await conversation.submit(tx, { type: "input", content, requestId, whenBusy: "steer" });
        return { busy, id };
      }, CHORD);

      await send(from, { kind: "status", status: admitted.busy ? "queued" : "working" });
      const submission = await opened.submission(admitted.id, CHORD);
      if (submission) void track(from, submission.wait(CHORD));
    },

    async reset(chat) {
      await (await conversationFor(chat)).reset(undefined, CHORD);
    },

    async schedules(chat) {
      const conversation = await conversationFor(chat);
      // Copy inside the commit: document drafts die once it settles.
      return conversation.commit(async (tx) => scheduleInfos((await tx.doc(Schedules, conversation.id)).items), CHORD);
    },

    async cancelSchedule(chat, name) {
      const conversation = await conversationFor(chat);
      const taskId = await conversation.commit(async (tx) => {
        const doc = await tx.doc(Schedules, conversation.id);
        const found = doc.items[name];
        if (!found) return undefined;
        delete doc.items[name];
        return found.taskId;
      }, CHORD);
      if (taskId === undefined) return false;
      await opened.abortTask(taskId, CHORD).catch(() => undefined);
      return true;
    },

    close: () => opened.close(CHORD),
  };
}
