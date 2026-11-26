import {
    DeliveryFailed,
    type Address,
    type Author,
    type InboundEvent,
    type InboundSink,
    type InputService,
    type OutboundMessage,
    type OutputService,
} from "@eien/io";
import { Result } from "better-result";
import { errorText, formatBytes, type Logger } from "@eien/shared";
import { Bot, InputFile, type Api, type Context } from "grammy";
import { createReadStream } from "node:fs";
import { downloadAttachment } from "./attachments.ts";
import { authorFrom } from "./author.ts";
import { htmlToPlainText, TELEGRAM_CHUNK_LIMIT, toTelegramChunks } from "./markdown.ts";
import { groupGate, type GroupGateInput } from "./mentions.ts";
import { splitMessage, hasContent } from "./text.ts";

/** Bot API uploads stop at 50 MB. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Only a genuinely long run gets a message; short ones just show typing. */
const SLOW_RUN_MS = 60_000;
const TYPING_REFRESH_MS = 4_500;

const SLOW_TEXT = "Still on it. I'll post the result here when it's done.";
const QUEUED_TEXT = "Got it, I'll fold that in at my next step.";
const THINKING_TEXT = "Thinking…";
const STEERED_TEXT = "Folded into the current reply.";
/** The agent's marker for "this was not addressed to me; stay out of it". */
const NO_REPLY = "NO_REPLY";

const PROMPT_HINT = [
    "You are chatting on Telegram. Your Markdown is rendered to Telegram HTML: bold, italics, inline code, code blocks, links, and quotes work; keep tables small.",
    "In a group, answer only the message addressed to you and keep it short.",
    "In a group, if a message is not asking you to answer or do some work — punctuation or an acknowledgement, or people discussing or quoting your answer — reply with exactly NO_REPLY and nothing else. Do not use tools for it.",
    "Each group message starts with [sender: display name (@username), user id: ...]. The display name can be changed by the user; the numeric id is the identity. Answer the person who asked.",
    `send_file can deliver files up to ${formatBytes(MAX_UPLOAD_BYTES)}.`,
].join(" ");

export interface TelegramOptions {
    token: string;
    /** Numeric Telegram user IDs allowed to talk to the bot. */
    allowedUsers: ReadonlySet<string>;
    /** Free-text names that address the bot in groups. Defaults to "eien" and "eienbot". */
    botNames?: readonly string[];
    log: Logger;
}

/** Telegram over long polling: an input and an output service in one. */
export type TelegramService = InputService & OutputService;

async function sendChunks(api: Api, chat: string, text: string, replyTo: number | undefined): Promise<void> {
    let quote = replyTo;
    for (const chunk of toTelegramChunks(text, TELEGRAM_CHUNK_LIMIT)) {
        const reply =
            quote === undefined ? {} : { reply_parameters: { message_id: quote, allow_sending_without_reply: true } };
        quote = undefined;
        try {
            await api.sendMessage(chat, chunk, { parse_mode: "HTML", ...reply });
        } catch {
            // Telegram rejected the markup: resend as readable plain text.
            for (const plain of splitMessage(htmlToPlainText(chunk))) await api.sendMessage(chat, plain);
        }
    }
}

export function createTelegramService(options: TelegramOptions): TelegramService {
    const { token, allowedUsers, botNames, log } = options;
    const bot = new Bot(token);
    /** The newest message each chat sent us, quoted by the next answer. */
    const replyTargets = new Map<string, number>();
    /** "Thinking…" placeholders waiting to be edited into an answer, oldest first per chat. */
    const thinking = new Map<string, number[]>();
    /** Typing loops and slow-run notices for chats with work in flight. */
    const working = new Map<string, () => void>();
    let sink: InboundSink | undefined;
    let polling: Promise<void> | undefined;

    const addressOf = (ctx: Context): Address => ({ service: "telegram", chat: String(ctx.chat!.id) });

    /** Group messages carry who sent them; private chats already identify the person. */
    const groupAuthor = (ctx: Context): Author | undefined =>
        ctx.chat?.type === "private" || !ctx.from ? undefined : authorFrom(ctx.from);

    /** Post the immediate "Thinking…" reply the answer will later replace. */
    async function postThinking(chat: string, replyTo: number | undefined): Promise<number | undefined> {
        const reply =
            replyTo === undefined
                ? {}
                : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } };
        try {
            const sent = await bot.api.sendMessage(chat, THINKING_TEXT, reply);
            const pending = thinking.get(chat) ?? [];
            pending.push(sent.message_id);
            thinking.set(chat, pending);
            return sent.message_id;
        } catch (error) {
            log.warn("could not post thinking placeholder", { chat, error });
            return undefined;
        }
    }

    /** Claim the oldest placeholder, if any, so the next answer edits it instead of sending fresh. */
    function takeThinking(chat: string): number | undefined {
        const pending = thinking.get(chat);
        const id = pending?.shift();
        if (id === undefined) return undefined;
        if (pending!.length === 0) thinking.delete(chat);
        return id;
    }

    /** Claim the newest placeholder: the one posted for the message that just steered. */
    function takeNewestThinking(chat: string): number | undefined {
        const pending = thinking.get(chat);
        const id = pending?.pop();
        if (id === undefined) return undefined;
        if (pending!.length === 0) thinking.delete(chat);
        return id;
    }

    function hasThinking(chat: string): boolean {
        return (thinking.get(chat)?.length ?? 0) > 0;
    }

    /** Drop placeholders a run never answered, but give a late watcher time to claim them first. */
    function scheduleThinkingCleanup(chat: string): void {
        const snapshot = thinking.get(chat);
        if (!snapshot?.length) return;
        const ids = new Set(snapshot);
        setTimeout(() => {
            const pending = thinking.get(chat);
            if (!pending) return;
            const left = pending.filter((id) => ids.has(id));
            const kept = pending.filter((id) => !ids.has(id));
            if (kept.length === 0) thinking.delete(chat);
            else thinking.set(chat, kept);
            for (const id of left) void bot.api.deleteMessage(chat, id).catch(() => undefined);
        }, 15_000);
    }

    /** Edit a placeholder to the given text. Returns false when Telegram refuses. */
    async function editThinking(chat: string, messageId: number, text: string, html: boolean): Promise<boolean> {
        try {
            await bot.api.editMessageText(chat, messageId, text, html ? { parse_mode: "HTML" } : {});
            return true;
        } catch (error) {
            // Rewriting a message with identical text is harmless, not a failure.
            return !html ? errorText(error).includes("message is not modified") : false;
        }
    }

    async function sendAnswer(chat: string, text: string): Promise<void> {
        // Accept "NO_REPLY", "**NO_REPLY**", or "NO_REPLY." as the same decline marker.
        if (text.replace(/[^A-Za-z]/g, "").toUpperCase() === NO_REPLY) {
            // The run declined to answer: drop its placeholder instead of sending it.
            const placeholder = takeThinking(chat);
            if (placeholder !== undefined) await bot.api.deleteMessage(chat, placeholder).catch(() => undefined);
            return;
        }
        const placeholder = takeThinking(chat);
        if (placeholder === undefined) return sendChunks(bot.api, chat, text, replyTargets.get(chat));

        const [first = "", ...rest] = toTelegramChunks(text, TELEGRAM_CHUNK_LIMIT);
        if (first === "") {
            await bot.api.deleteMessage(chat, placeholder).catch(() => undefined);
            return;
        }

        // Prefer HTML, fall back to plain text, and only then give up on the placeholder.
        const edited =
            (await editThinking(chat, placeholder, first, true)) ||
            (await editThinking(chat, placeholder, htmlToPlainText(first), false));
        if (!edited) {
            await bot.api.deleteMessage(chat, placeholder).catch(() => undefined);
            return sendChunks(bot.api, chat, text, replyTargets.get(chat));
        }
        for (const chunk of rest) {
            try {
                await bot.api.sendMessage(chat, chunk, { parse_mode: "HTML" });
            } catch {
                for (const plain of splitMessage(htmlToPlainText(chunk))) await bot.api.sendMessage(chat, plain);
            }
        }
    }

    function startWorking(chat: string): void {
        if (working.has(chat)) return;
        const typing = () => void bot.api.sendChatAction(chat, "typing").catch(() => undefined);
        typing();
        const timer = setInterval(typing, TYPING_REFRESH_MS);
        const slow = setTimeout(() => void bot.api.sendMessage(chat, SLOW_TEXT).catch(() => undefined), SLOW_RUN_MS);
        working.set(chat, () => {
            clearInterval(timer);
            clearTimeout(slow);
        });
    }

    function stopWorking(chat: string): void {
        working.get(chat)?.();
        working.delete(chat);
    }

    async function emit(ctx: Context, event: InboundEvent): Promise<void> {
        const chat = event.from.chat;
        if (ctx.message) replyTargets.set(chat, ctx.message.message_id);
        // A reply to a bot message is the user's signal to fold this into the run in flight.
        const outbound: InboundEvent =
            event.kind === "message"
                ? { ...event, replyToBot: ctx.message?.reply_to_message?.from?.id === ctx.me.id }
                : event;
        if (outbound.kind === "message") await postThinking(chat, ctx.message?.message_id);
        try {
            await sink?.(outbound);
        } catch (error) {
            log.error("inbound event failed", { from: outbound.from, error });
            const text = `Something broke: ${errorText(error).slice(0, 500)}`;
            const placeholder = takeThinking(chat);
            if (placeholder === undefined) await ctx.reply(text).catch(() => undefined);
            else if (!(await editThinking(chat, placeholder, text, false)))
                await bot.api.deleteMessage(chat, placeholder).catch(() => undefined);
        }
    }

    bot.use(async (ctx, next) => {
        const user = ctx.from?.id;
        if (user === undefined || !allowedUsers.has(String(user))) {
            log.warn("blocked non-allowlisted user", { telegramUserId: user, chatType: ctx.chat?.type });
            return;
        }
        await next();
    });

    /** Group messages count only when they mention, name, or reply to the bot; returns the text addressed to it. */
    function addressedText(ctx: Context, text: string, entities: GroupGateInput["entities"]): string | undefined {
        const gate = groupGate({
            isGroup: ctx.chat?.type !== "private",
            text,
            botUsername: ctx.me.username,
            botId: ctx.me.id,
            entities,
            replyToBot: ctx.message?.reply_to_message?.from?.id === ctx.me.id,
            botNames,
        });
        return gate.respond ? gate.text.trim() : undefined;
    }

    bot.on("message:text", async (ctx) => {
        const text = addressedText(ctx, ctx.message.text, ctx.message.entities);
        if (text === undefined) return;
        // Punctuation or emoji alone (a "." used to quote the bot) is not a request.
        if (!text.startsWith("/") && !hasContent(text)) return;
        const from = addressOf(ctx);
        const id = `telegram:${ctx.update.update_id}`;

        if (!text.startsWith("/")) {
            await emit(ctx, { kind: "message", from, id, text, attachments: [], author: groupAuthor(ctx) });
            return;
        }

        const [head = "", ...args] = text.split(/\s+/);
        const name = head.slice(1).split("@")[0]!.toLowerCase();
        if (name === "id") {
            // Telegram-only: who is talking, from where.
            await ctx.reply(`chat: ${ctx.chat.id}\ntype: ${ctx.chat.type}\nyou: ${ctx.from.id}`);
            return;
        }
        await emit(ctx, { kind: "command", from, id, name, args });
    });

    bot.on(
        ["message:document", "message:photo", "message:video", "message:audio", "message:voice", "message:video_note"],
        async (ctx) => {
            const text = addressedText(ctx, ctx.message.caption ?? "", ctx.message.caption_entities);
            if (text === undefined) return;

            const downloaded = await downloadAttachment(ctx, token);
            if (downloaded.isErr()) {
                await ctx
                    .reply(`Could not receive that file: ${downloaded.error.message.slice(0, 500)}`)
                    .catch(() => undefined);
                return;
            }
            const attachment = downloaded.value;
            if (!attachment) {
                await ctx.reply("Unsupported attachment type.");
                return;
            }
            const id = `telegram:${ctx.update.update_id}`;
            await emit(ctx, {
                kind: "message",
                from: addressOf(ctx),
                id,
                text,
                attachments: [attachment],
                author: groupAuthor(ctx),
            });
        },
    );

    bot.on("callback_query:data", async (ctx) => {
        const chat = ctx.chat?.id;
        if (chat === undefined) return;
        const chatId = String(chat);
        // Stop the button's spinner before doing any work.
        await ctx.answerCallbackQuery().catch(() => undefined);

        const event = {
            kind: "callback",
            from: { service: "telegram", chat: chatId },
            id: `telegram:callback:${ctx.update.update_id}`,
            data: ctx.callbackQuery.data,
        } as const;
        try {
            await sink?.(event);
        } catch (error) {
            log.error("callback failed", { from: event.from, error });
            await ctx.reply(`Something broke: ${errorText(error).slice(0, 500)}`).catch(() => undefined);
        }

        // A picker is one-shot: drop its buttons so the same choice cannot be replayed.
        const messageId = ctx.callbackQuery.message?.message_id;
        if (messageId !== undefined) await bot.api.editMessageReplyMarkup(chatId, messageId).catch(() => undefined);
    });

    /** Send one message through the Bot API; throws whatever grammY throws. */
    async function deliver(chat: string, message: OutboundMessage): Promise<void> {
        switch (message.kind) {
            case "text":
                return sendAnswer(chat, message.text);
            case "choices": {
                const keyboard = message.choices.map((choice) => [
                    {
                        text: choice.label.length > 60 ? `${choice.label.slice(0, 59)}…` : choice.label,
                        callback_data: choice.data.slice(0, 64),
                    },
                ]);
                const replyTo = replyTargets.get(chat);
                await bot.api.sendMessage(chat, message.text, {
                    reply_markup: { inline_keyboard: keyboard },
                    ...(replyTo === undefined
                        ? {}
                        : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
                });
                return;
            }
            case "file": {
                // A file replaces the pending placeholder: keep its caption there when there is one.
                const placeholder = takeThinking(chat);
                if (placeholder !== undefined) {
                    const applied =
                        message.caption === undefined
                            ? false
                            : await editThinking(chat, placeholder, message.caption, false);
                    if (!applied) await bot.api.deleteMessage(chat, placeholder).catch(() => undefined);
                }
                await bot.api.sendDocument(chat, new InputFile(createReadStream(message.localPath), message.name), {
                    caption: message.caption,
                });
                return;
            }
            case "status":
                if (message.status === "idle") {
                    stopWorking(chat);
                    scheduleThinkingCleanup(chat);
                } else if (message.status === "steered") {
                    // This input joined the run in flight; its own placeholder gets no answer.
                    const placeholder = takeNewestThinking(chat);
                    if (placeholder !== undefined) {
                        if (!(await editThinking(chat, placeholder, STEERED_TEXT, false)))
                            await bot.api.deleteMessage(chat, placeholder).catch(() => undefined);
                    }
                } else {
                    startWorking(chat);
                    if (message.status === "queued" && !hasThinking(chat)) await bot.api.sendMessage(chat, QUEUED_TEXT);
                }
                return;
        }
    }

    bot.catch((error) =>
        log.error("unhandled bot error", { updateId: error.ctx.update.update_id, error: error.error }),
    );

    return {
        name: "telegram",
        promptHint: PROMPT_HINT,

        start(next) {
            sink = next;
            return new Promise((resolve, reject) => {
                polling = bot.start({
                    allowed_updates: ["message", "callback_query"],
                    onStart: (info) => {
                        log.info("telegram online", { username: info.username });
                        if (!info.can_read_all_group_messages) {
                            log.warn(
                                "group privacy is on: the bot only sees commands, mentions, and replies in groups",
                            );
                        }
                        resolve();
                    },
                });
                polling.catch(reject);
            });
        },

        async stop() {
            for (const chat of [...working.keys()]) stopWorking(chat);
            await bot.stop();
            await polling?.catch(() => undefined);
        },

        async send(chat: string, message: OutboundMessage) {
            if (message.kind === "file" && message.size > MAX_UPLOAD_BYTES) {
                return Result.err(
                    new DeliveryFailed({
                        service: "telegram",
                        reason: "too_large",
                        message: `file is ${formatBytes(message.size)}; Telegram allows at most ${formatBytes(MAX_UPLOAD_BYTES)}`,
                    }),
                );
            }
            return Result.tryPromise({
                try: () => deliver(chat, message),
                catch: (cause) =>
                    new DeliveryFailed({
                        service: "telegram",
                        reason: "failed",
                        message: `Telegram rejected it: ${errorText(cause)}`,
                        cause,
                    }),
            });
        },
    };
}
