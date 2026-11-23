import {
    AssistantEntry,
    LiveDoc,
    configure,
    defineDoc,
    defineExtension,
    defineTask,
    defineTool,
    type ConversationId,
    type EntryId,
    type TaskId,
} from "@earendil-works/pi-durable";
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { answerText } from "./entries.ts";

type SubagentRecord = { conversationId: ConversationId; reported: EntryId[] };

const Subagents = defineDoc<{ agents: Record<string, SubagentRecord>; reporters: Record<string, TaskId> }>({
    checkpointWhen: () => false,
    kind: "eien.subagents",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ agents: {}, reporters: {} }),
});

const terminal = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const aborted = { status: "terminal", outcome: { status: "aborted" } } as const;
const background = { ownership: { kind: "conversation" }, background: true } as const;

/** Background boundary so a subagent outlives the turn that spawned it. */
const Anchor = defineTask<null, { phase: "done" }, null>({
    name: "eien.subagent-anchor",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: { done: (_input, runtime, context) => runtime.commit(() => terminal, context) },
    abort: (_input, runtime, context) => runtime.commit(() => aborted, context),
});

type ReporterInput = { name: string; conversationId: ConversationId; message: string; followUp: boolean };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

/** Deliver one message to a subagent and report its answer back to the parent. */
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

                const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[name];
                if (!agent || agent.reported.includes(settled.answer)) return next();
                agent.reported.push(settled.answer);

                const text = answerText(await tx.entry(AssistantEntry, settled.answer));
                return next(`[subagent ${name} finished] ${text || "(no report)"}`);
            }, context);
        },

        report: async (reporter, runtime, context) => {
            const report = reporter.state.checkpoint.report;
            if (report !== undefined) {
                const parent = await runtime.conversation(runtime.conversationId, context);
                await parent?.submit(
                    {
                        type: "input",
                        content: report,
                        whenBusy: "followUp",
                        requestId: `subagent-report:${reporter.id}`,
                    },
                    context,
                );
            }
            await runtime.commit(() => terminal, context);
        },
    },
    abort: (_input, runtime, context) => runtime.commit(() => aborted, context),
});

const subagentTool = defineTool({
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
            ...(conversationId === undefined || name === undefined ? {} : { details: { name, conversationId } }),
        });

        const agents = (await api.snapshot(Subagents, api.conversationId, callContext))?.agents ?? {};
        const find = (each: string) => (Object.hasOwn(agents, each) ? agents[each] : undefined);

        if (action === "status") {
            const lines: string[] = [];
            for (const each of name === undefined ? Object.keys(agents) : [name]) {
                const found = find(each);
                if (!found) continue;
                const busy = (await api.snapshot(LiveDoc, found.conversationId, callContext))?.run !== undefined;
                lines.push(`${each}: ${busy ? "working" : "idle"}`);
            }
            return reply(lines.length === 0 ? "No subagents." : lines.join("\n"));
        }

        if (name === undefined) return reply(`${action} needs a name.`);
        const agent = find(name);

        if (action === "stop") {
            if (!agent) return reply(`No subagent named ${name}.`);
            const target = await api.conversation(agent.conversationId, callContext);
            await target?.abort(callContext);
            return reply(`Stopped ${name}.`, agent.conversationId);
        }
        if (action === "send" && !agent) return reply(`No subagent named ${name}.`);

        if (message === undefined) return reply(`${action} needs a message.`);

        const outcome = await api.commit(async (tx) => {
            const state = await tx.doc(Subagents, api.conversationId);

            if (action === "spawn") {
                if (Object.hasOwn(state.agents, name)) return { text: `${name} already exists; use send.` };
                const anchor = await tx.createTask(Anchor, null, background);
                const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
                await configure(tx, child.id, {
                    extensions: { remove: [SubagentExtension] },
                    instructions: `You are the subagent "${name}". Work autonomously and answer the main agent's requests with a concise report.`,
                });
                state.agents[name] = { conversationId: child.id, reported: [] };
            }

            const conversationId = state.agents[name]!.conversationId;
            const input = { name, conversationId, message, followUp: action === "send" && followUp === true };
            state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
            return { text: action === "send" ? `Sent to ${name}.` : `Started ${name}.`, conversationId };
        }, callContext);

        return reply(outcome.text, outcome.conversationId);
    },
});

/** Persistent background workers. Children get every extension but this one, so they cannot spawn more. */
export const SubagentExtension = defineExtension({
    name: "eien-subagents",
    tasks: [Anchor, Reporter],
    tools: [subagentTool],
});
