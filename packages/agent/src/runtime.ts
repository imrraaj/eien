import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    Harness,
    LiveDoc,
    configure,
    createRegistry,
    defineExtension,
    type AgentChange,
    type Conversation,
    type ConversationId,
    type EntryId,
    type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import {
    addressKey,
    parseAddressKey,
    type Address,
    type Attachment,
    type Author,
    type ConversationFeed,
    type DeliveryFailed,
    type FeedItem,
    type OutboundMessage,
} from "@eien/io";
import { type createModelsRegistry } from "@eien/llm";
import type { Sandbox } from "@eien/sandbox";
import type { Logger } from "@eien/shared";
import { Result } from "better-result";
import type { CommandFailed } from "@eien/sandbox";
import { dirname, join } from "node:path";
import type { WebOptions } from "./web.ts";
import { Chats, Delivery } from "./chats.ts";
import { answerText, callsTools } from "./entries.ts";
import { toFeedItem, toLiveState } from "./feed.ts";
import { MemoryStore, createMemoryTools } from "./memory.ts";
import type { ScheduleInfo } from "./schedule-text.ts";
import { Schedule, Schedules, removeSchedule, scheduleInfos, scheduleTool } from "./schedules.ts";
import { openSqliteStorage } from "./sqlite.ts";
import { SubagentExtension } from "./subagents.ts";
import { createWorkTools } from "./tools.ts";
import { NoChat, exportFile, intake } from "./transfer.ts";

const CHORD = BACKGROUND_CONTEXT;
const HISTORY_PAGE = 50;

/** Where the runtime sends what the agent says. `OutputRouter` from `@eien/io` is one. */
export interface Outbox {
    send(to: Address, message: OutboundMessage): Promise<Result<void, DeliveryFailed>>;
}

export interface RuntimeOptions {
    storagePath: string;
    models: ReturnType<typeof createModelsRegistry>;
    /** Provider and model the agent starts on. */
    model: ModelRef;
    maxTurns: number;
    sandbox: Sandbox;
    web: WebOptions;
    outbox: Outbox;
    /** Durable control-plane memory; defaults to memory.md next to the SQLite file. */
    memory?: MemoryStore;
    /** System prompt for chats on a service, given the current memory contents. */
    instructions: (service: string, memory: string) => string;
    log: Logger;
}

export interface ModelRef {
    provider: string;
    modelId: string;
}

/** How to handle an input that arrives while a run is already in flight. */
export interface PromptOptions {
    /** The user replied to the bot: fold this into the running turn instead of queueing a new run. */
    steer?: boolean;
    /** Who sent a shared-chat message; omitted for private chats. */
    author?: Author;
}

/** The durable agent loop. It knows addresses, never the services behind them. */
export interface AgentRuntime extends ConversationFeed {
    /**
     * Start a run, or steer the running one. Attachments go into the sandbox first;
     * failing to store one is the only expected error. Resolves once the message is durably admitted.
     */
    prompt(
        from: Address,
        text: string,
        requestId: string,
        attachments?: readonly Attachment[],
        options?: PromptOptions,
    ): Promise<Result<void, CommandFailed>>;
    reset(chat: Address): Promise<void>;
    /** Switch every open conversation to another model in the registry. */
    setModel(model: ModelRef): Promise<void>;
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

/** Prefix a shared-chat message with stable sender metadata; the id is authoritative. */
function attributed(text: string, author?: Author): string {
    if (!author) return text;
    const handle = author.username ? ` (@${author.username})` : "";
    return `[sender: ${author.name}${handle}, user id: ${author.id}]\n\n${text}`;
}

export async function createAgentRuntime(options: RuntimeOptions): Promise<AgentRuntime> {
    const { sandbox, outbox, log } = options;
    const memory = options.memory ?? new MemoryStore(join(dirname(options.storagePath), "memory.md"));

    /** Current memory for the system prompt; a read failure degrades to no injected memory. */
    async function memoryForPrompt(): Promise<string> {
        const read = await memory.read();
        if (read.isErr()) {
            log.warn("could not read memory for the prompt", { error: read.error });
            return "";
        }
        return read.value;
    }
    /** The active model; `/setmodel` updates it and reconfigures every open conversation. */
    let currentModel: ModelRef = options.model;

    /** Open conversations by address key, and the reverse for tools that only know the conversation. */
    const conversations = new Map<string, Promise<Conversation>>();
    const addresses = new Map<ConversationId, Address>();
    /** Unsettled submissions per chat; the chat goes idle when this reaches zero. */
    const inFlight = new Map<string, number>();

    /** Send and log a failed delivery; for messages nobody can act on beyond that. */
    async function send(to: Address, message: OutboundMessage): Promise<void> {
        const sent = await outbox.send(to, message);
        if (sent.isErr()) log.error("could not deliver", { to, kind: message.kind, error: sent.error });
    }

    async function deliverFile(conversationId: ConversationId, path: string, caption?: string) {
        const to = addresses.get(conversationId);
        if (!to) return Result.err(new NoChat({ message: "this conversation has no chat to send files to" }));
        return exportFile(sandbox, path, caption, (message) => outbox.send(to, message));
    }

    const toolsExtension = defineExtension({
        name: "eien-tools",
        tasks: [Schedule],
        tools: [...createWorkTools(sandbox, options.web, deliverFile), ...createMemoryTools(memory), scheduleTool],
    });
    const registry = createRegistry();
    registry.install(toolsExtension);
    registry.install(SubagentExtension);

    const harness = await Harness.open(
        await openSqliteStorage(options.storagePath),
        { models: options.models, registry, onReport: (report) => log.error("durable report", { report }) },
        CHORD,
    );

    // A failed session never recovers by itself; exit so the supervisor restarts us.
    void harness.closed.then((end) => {
        if (end.kind !== "failed") return;
        log.error("durable storage failed; exiting", { error: end.error });
        setTimeout(() => process.exit(1), 100);
    });

    const agentFor = (service: string, memoryText: string) =>
        ({
            model: { provider: currentModel.provider, modelId: currentModel.modelId },
            instructions: options.instructions(service, memoryText),
            cwd: sandbox.root,
            maxTurns: options.maxTurns,
        }) satisfies AgentChange;

    /** Conversations keep the settings they were created with; bring them up to date after a config change. */
    async function syncAgent(conversation: Conversation, service: string, memoryText: string): Promise<void> {
        const want = agentFor(service, memoryText);
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
        let delivered = await conversation.commit(
            async (tx) => (await tx.doc(Delivery, conversation.id)).delivered,
            CHORD,
        );
        const watch = await conversation.watch(CHORD, { from: (delivered + 1) as EntryId });

        watch.start(async (call) => {
            if (call.kind !== "value") return;
            for (const entry of call.value.entries) {
                if (entry.id <= delivered) continue;
                delivered = entry.id;
                if (entry.kind !== "pi.assistant" || callsTools(entry)) continue;
                const text = answerText(entry);
                if (!text) continue;

                await send(to, { kind: "text", text, entry: entry.id });
                await conversation.commit(async (tx) => {
                    const doc = await tx.doc(Delivery, conversation.id);
                    doc.delivered = Math.max(doc.delivered, entry.id);
                }, CHORD);
            }
        });
    }

    async function attach(conversation: Conversation, to: Address, memoryText: string): Promise<Conversation> {
        addresses.set(conversation.id, to);
        await syncAgent(conversation, to.service, memoryText);
        await deliverAnswers(conversation, to);
        return conversation;
    }

    /** The chat's conversation, created and mapped in one commit the first time the chat speaks. */
    async function openOrCreate(to: Address, memoryText: string): Promise<Conversation> {
        const key = addressKey(to);
        const id = await harness.commit(async (tx) => {
            const chats = await tx.doc(Chats);
            const known = chats.conversations[key];
            if (known !== undefined) return known;
            const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
            await configure(tx, created.id, {
                ...agentFor(to.service, memoryText),
                extensions: [toolsExtension, SubagentExtension],
            });
            chats.conversations[key] = created.id;
            return created.id;
        }, CHORD);
        const conversation = await harness.conversation(id, CHORD);
        if (!conversation) throw new Error(`conversation ${id} for ${key} is missing`);
        return attach(conversation, to, memoryText);
    }

    /** One open per chat, even when messages race in before the first open finishes. */
    function conversationFor(to: Address, memoryText: string): Promise<Conversation> {
        const key = addressKey(to);
        let conversation = conversations.get(key);
        if (!conversation) {
            conversation = openOrCreate(to, memoryText);
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
    const known = await harness.commit(async (tx) => Object.entries((await tx.doc(Chats)).conversations), CHORD);
    const bootMemory = await memoryForPrompt();
    for (const [key, id] of known) {
        const to = parseAddressKey(key);
        const conversation = to && (await harness.conversation(id, CHORD));
        if (to && conversation) conversations.set(key, attach(conversation, to, bootMemory));
    }
    await Promise.all(conversations.values());
    harness.resume();
    log.info("durable runtime ready", { chats: conversations.size });

    return {
        async prompt(from, text, requestId, attachments = [], options = {}) {
            const stored = await intake(sandbox, text, attachments);
            if (stored.isErr()) return stored;
            const content = attributed(stored.value, options.author);
            const memoryText = await memoryForPrompt();
            const conversation = await conversationFor(from, memoryText);
            await syncAgent(conversation, from.service, memoryText);
            const admitted = await conversation.commit(async (tx) => {
                const busy = (await tx.doc(LiveDoc, conversation.id)).run !== undefined;
                const id = await conversation.submit(tx, {
                    type: "input",
                    content,
                    requestId,
                    whenBusy: options.steer === true ? "steer" : "followUp",
                });
                return { busy, id };
            }, CHORD);

            const steered = admitted.busy && options.steer === true;
            await send(from, {
                kind: "status",
                status: steered ? "steered" : admitted.busy ? "queued" : "working",
            });
            const submission = await harness.submission(admitted.id, CHORD);
            if (submission) void track(from, submission.wait(CHORD));
            return Result.ok(undefined);
        },

        async reset(chat) {
            await (await conversationFor(chat, await memoryForPrompt())).reset(undefined, CHORD);
        },

        async setModel(model) {
            currentModel = model;
            const memoryText = await memoryForPrompt();
            await Promise.all(
                [...conversations.values()].map(async (pending) => {
                    const conversation = await pending;
                    const to = addresses.get(conversation.id);
                    if (to !== undefined) await syncAgent(conversation, to.service, memoryText);
                }),
            );
        },

        async schedules(chat) {
            const conversation = await conversationFor(chat, await memoryForPrompt());
            // Copy inside the commit: document drafts die once it settles.
            return conversation.commit(
                async (tx) => scheduleInfos((await tx.doc(Schedules, conversation.id)).items),
                CHORD,
            );
        },

        async cancelSchedule(chat, name) {
            const conversation = await conversationFor(chat, await memoryForPrompt());
            return conversation.commit((tx) => removeSchedule(tx, conversation.id, name), CHORD);
        },

        async history(from, { before, limit = HISTORY_PAGE } = {}) {
            const conversation = await conversationFor(from, await memoryForPrompt());
            const page = await conversation.entries(
                { order: "descending", ...(before === undefined ? {} : { maxEntryId: (before - 1) as EntryId }) },
                limit,
                undefined,
                CHORD,
            );
            const items = page.items.flatMap((entry) => toFeedItem(entry) ?? []).reverse();
            const oldest = page.items.at(-1)?.id;
            return { items, ...(page.next !== undefined && oldest !== undefined ? { before: oldest } : {}) };
        },

        async subscribe(from, after, listener) {
            const conversation = await conversationFor(from, await memoryForPrompt());
            const watch = await conversation.watch(CHORD, { from: (after + 1) as EntryId });
            let newest = after;
            let lastLive = "";

            /** Emit items past `newest` and the live state when it changed; repeats of a view emit nothing. */
            const emit = (view: typeof watch.value) => {
                const items: FeedItem[] = [];
                for (const entry of view.entries) {
                    if (entry.id <= newest) continue;
                    newest = entry.id;
                    const item = toFeedItem(entry);
                    if (item) items.push(item);
                }
                if (items.length > 0) listener({ kind: "items", items });

                const live = toLiveState(view.docs["pi.live"] as Parameters<typeof toLiveState>[0]);
                const serialized = JSON.stringify(live);
                if (serialized !== lastLive) {
                    lastLive = serialized;
                    listener({ kind: "live", live });
                }
            };

            // The watch reports changes only, so the current view goes out first.
            emit(watch.value);
            watch.start(async (call) => {
                if (call.kind === "value") emit(call.value);
            });
            return async () => void (await watch.stop());
        },

        close: () => harness.close(CHORD),
    };
}
