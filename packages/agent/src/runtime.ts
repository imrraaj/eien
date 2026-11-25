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
    type DeliveryFailed,
    type OutboundMessage,
} from "@eien/io";
import { type createModelsRegistry } from "@eien/llm";
import type { Sandbox } from "@eien/sandbox";
import type { Logger } from "@eien/shared";
import { Result } from "better-result";
import type { CommandFailed } from "@eien/sandbox";
import type { WebOptions } from "./web.ts";
import { Chats, Delivery } from "./chats.ts";
import { answerText, callsTools } from "./entries.ts";
import type { ScheduleInfo } from "./schedule-text.ts";
import { Schedule, Schedules, removeSchedule, scheduleInfos, scheduleTool } from "./schedules.ts";
import { openSqliteStorage } from "./sqlite.ts";
import { SubagentExtension } from "./subagents.ts";
import { createWorkTools } from "./tools.ts";
import { NoChat, exportFile, intake } from "./transfer.ts";

const CHORD = BACKGROUND_CONTEXT;

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
    /** System prompt for chats on a service. */
    instructions: (service: string) => string;
    log: Logger;
}

export interface ModelRef {
    provider: string;
    modelId: string;
}

/** The durable agent loop. It knows addresses, never the services behind them. */
export interface AgentRuntime {
    /**
     * Start a run, or steer the running one. Attachments go into the sandbox first;
     * failing to store one is the only expected error. Resolves once the message is durably admitted.
     */
    prompt(
        from: Address,
        text: string,
        requestId: string,
        attachments?: readonly Attachment[],
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

export async function createAgentRuntime(options: RuntimeOptions): Promise<AgentRuntime> {
    const { sandbox, outbox, log } = options;
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
        tools: [...createWorkTools(sandbox, options.web, deliverFile), scheduleTool],
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

    const agentFor = (service: string) =>
        ({
            model: { provider: currentModel.provider, modelId: currentModel.modelId },
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

    /** The chat's conversation, created and mapped in one commit the first time the chat speaks. */
    async function openOrCreate(to: Address): Promise<Conversation> {
        const key = addressKey(to);
        const id = await harness.commit(async (tx) => {
            const chats = await tx.doc(Chats);
            const known = chats.conversations[key];
            if (known !== undefined) return known;
            const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
            await configure(tx, created.id, {
                ...agentFor(to.service),
                extensions: [toolsExtension, SubagentExtension],
            });
            chats.conversations[key] = created.id;
            return created.id;
        }, CHORD);
        const conversation = await harness.conversation(id, CHORD);
        if (!conversation) throw new Error(`conversation ${id} for ${key} is missing`);
        return attach(conversation, to);
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
    const known = await harness.commit(async (tx) => Object.entries((await tx.doc(Chats)).conversations), CHORD);
    for (const [key, id] of known) {
        const to = parseAddressKey(key);
        const conversation = to && (await harness.conversation(id, CHORD));
        if (to && conversation) conversations.set(key, attach(conversation, to));
    }
    await Promise.all(conversations.values());
    harness.resume();
    log.info("durable runtime ready", { chats: conversations.size });

    return {
        async prompt(from, text, requestId, attachments = []) {
            const stored = await intake(sandbox, text, attachments);
            if (stored.isErr()) return stored;
            const content = stored.value;
            const conversation = await conversationFor(from);
            const admitted = await conversation.commit(async (tx) => {
                const busy = (await tx.doc(LiveDoc, conversation.id)).run !== undefined;
                const id = await conversation.submit(tx, { type: "input", content, requestId, whenBusy: "steer" });
                return { busy, id };
            }, CHORD);

            await send(from, { kind: "status", status: admitted.busy ? "queued" : "working" });
            const submission = await harness.submission(admitted.id, CHORD);
            if (submission) void track(from, submission.wait(CHORD));
            return Result.ok(undefined);
        },

        async reset(chat) {
            await (await conversationFor(chat)).reset(undefined, CHORD);
        },

        async setModel(model) {
            currentModel = model;
            await Promise.all(
                [...conversations.values()].map(async (pending) => {
                    const conversation = await pending;
                    const to = addresses.get(conversation.id);
                    if (to !== undefined) await syncAgent(conversation, to.service);
                }),
            );
        },

        async schedules(chat) {
            const conversation = await conversationFor(chat);
            // Copy inside the commit: document drafts die once it settles.
            return conversation.commit(
                async (tx) => scheduleInfos((await tx.doc(Schedules, conversation.id)).items),
                CHORD,
            );
        },

        async cancelSchedule(chat, name) {
            const conversation = await conversationFor(chat);
            return conversation.commit((tx) => removeSchedule(tx, conversation.id, name), CHORD);
        },

        close: () => harness.close(CHORD),
    };
}
