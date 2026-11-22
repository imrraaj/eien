import {
    defineDoc,
    defineTask,
    defineTool,
    type ConversationId,
    type TaskId,
    type Tx,
} from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { Result, TaggedError } from "better-result";
import { formatDuration, formatSchedules, parseDelay, type ScheduleInfo } from "./schedule-text.ts";
import { fromResult, toolResult } from "./tool-result.ts";

const MAX_DELAY_MS = 30 * 86_400_000;
const MIN_REPEAT_MS = 10_000;

type ScheduleInput = { name: string; prompt: string; at: number; everyMs?: number };
type ScheduleState = { phase: "wait"; at: number } | { phase: "deliver"; at: number };
type ScheduleEntry = { taskId: TaskId; prompt: string; everyMs?: number; nextAt: number };

/** Named schedules in a conversation, so they can be listed and cancelled. */
export const Schedules = defineDoc<{ items: Record<string, ScheduleEntry> }>({
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
 * repeating schedule, sleep again. Cancelling only deletes the doc entry: a task
 * that wakes and finds none ends itself, and a stored sleep costs nothing meanwhile.
 */
export const Schedule = defineTask<ScheduleInput, ScheduleState, null>({
    name: "eien.schedule",
    version: 1,
    initial: (input) => ({ phase: "wait", at: input.at }),
    phases: {
        wait: (task, runtime, context) =>
            runtime.sleepUntil(task.state.checkpoint.at, { phase: "deliver", at: task.state.checkpoint.at }, context),

        deliver: async (task, runtime, context) => {
            const due = task.state.checkpoint.at;
            const { name, prompt, everyMs } = task.input;

            // A cancelled schedule's name may be reused; only the entry this task created counts.
            const live = (await runtime.snapshot(Schedules, runtime.conversationId, context))?.items[name];
            if (live?.taskId === runtime.taskId) {
                const main = await runtime.conversation(runtime.conversationId, context);
                await main?.submit(
                    {
                        type: "input",
                        content: prompt,
                        whenBusy: "followUp",
                        requestId: `schedule:${runtime.taskId}:${due}`,
                    },
                    context,
                );
            }

            // Skip repeats missed while the process was down instead of firing them all.
            const next = Math.max(runtime.now(), due + (everyMs ?? 0));
            await runtime.commit(async (tx) => {
                const doc = await tx.doc(Schedules, runtime.conversationId);
                const current = doc.items[name];
                if (current?.taskId !== runtime.taskId) return { status: "terminal", outcome: { status: "aborted" } };
                if (everyMs === undefined) {
                    delete doc.items[name];
                    return { status: "terminal", outcome: { status: "completed", result: null } };
                }
                current.nextAt = next;
                return { status: "running", checkpoint: { phase: "wait", at: next } };
            }, context);
        },
    },
    abort: (_task, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export function scheduleInfos(items: Readonly<Record<string, ScheduleEntry>>): ScheduleInfo[] {
    return Object.entries(items).map(([name, item]) => ({
        name,
        prompt: item.prompt,
        everyMs: item.everyMs,
        nextAt: item.nextAt,
    }));
}

/** The model's schedule request does not make sense: bad delay, missing prompt, taken name. */
export class ScheduleRejected extends TaggedError("ScheduleRejected")<{ message: string }> {}

export interface ScheduleRequest {
    name: string;
    prompt?: string;
    delay?: string;
    every?: string;
}

export interface SchedulePlan {
    name: string;
    prompt: string;
    delayMs: number;
    everyMs?: number;
}

/** Validate an add request against the names already taken. Pure, so it is tested on its own. */
export function planSchedule(
    request: ScheduleRequest,
    taken: ReadonlySet<string>,
): Result<SchedulePlan, ScheduleRejected> {
    const reject = (message: string) => Result.err(new ScheduleRejected({ message }));
    const { name, prompt } = request;

    if (prompt === undefined) return reject("add needs a prompt.");
    const delayMs = parseDelay(request.delay ?? "");
    if (delayMs === undefined) return reject(`invalid delay "${request.delay ?? ""}"; use e.g. 30s, 2m, 1h`);
    if (delayMs > MAX_DELAY_MS) return reject("delay is too long (max 30 days)");

    const everyMs = request.every === undefined ? undefined : parseDelay(request.every);
    if (request.every !== undefined && everyMs === undefined) {
        return reject(`invalid repeat "${request.every}"; use e.g. 15m, 1h`);
    }
    if (everyMs !== undefined && everyMs < MIN_REPEAT_MS)
        return reject("a repeating schedule must be at least 10s apart");
    if (taken.has(name)) return reject(`"${name}" already exists; cancel it first or pick another name.`);

    return Result.ok({ name, prompt, delayMs, everyMs });
}

/** Cancel a schedule in the caller's commit. False when there is none by that name. */
export async function removeSchedule(tx: Tx, conversationId: ConversationId, name: string): Promise<boolean> {
    const doc = await tx.doc(Schedules, conversationId);
    if (!Object.hasOwn(doc.items, name)) return false;
    delete doc.items[name];
    return true;
}

export const scheduleTool = defineTool({
    name: "schedule",
    description:
        'Durable timers for this chat. action=add (default): schedule({ name, prompt, delay, every? }) runs the prompt later; with every it repeats. action=cancel stops one by name, action=list shows them. Delays look like "30s", "2m", "1h". Survives restarts.',
    parameters: obj({
        action: opt(oneOf(["add", "list", "cancel"])),
        name: opt(str()),
        delay: opt(str()),
        every: opt(str()),
        prompt: opt(str()),
    }),
    execute: async (args, api, callContext) => {
        const action = args.action ?? "add";
        const items = (await api.snapshot(Schedules, api.conversationId, callContext))?.items ?? {};
        if (action === "list") return toolResult(formatSchedules(scheduleInfos(items), api.now()));

        const name = args.name?.trim();
        if (!name) return toolResult(`${action} needs a name.`, true);

        if (action === "cancel") {
            const removed = await api.commit((tx) => removeSchedule(tx, api.conversationId, name), callContext);
            return removed ? toolResult(`Cancelled ${name}.`) : toolResult(`No schedule named ${name}.`, true);
        }

        const planned = planSchedule({ ...args, name }, new Set(Object.keys(items)));
        if (planned.isErr()) return fromResult(planned);
        const { prompt, delayMs, everyMs } = planned.value;

        const at = api.now() + delayMs;
        await api.commit(async (tx) => {
            const doc = await tx.doc(Schedules, api.conversationId);
            // A concurrent add of the same name: refuse rather than orphan a sleeping task.
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
                ? `Scheduled "${name}" in ${formatDuration(delayMs)}.`
                : `Scheduled "${name}" every ${formatDuration(everyMs)}, first in ${formatDuration(delayMs)}.`,
        );
    },
});
