import { DeliveryFailed, type Address, type InboundEvent, type InboundSink, type InputService, type OutboundMessage, type OutputService } from "@eien/io";
import { Result } from "better-result";
import { formatBytes, type Logger } from "@eien/shared";
import { Bot, InputFile, type Api, type Context } from "grammy";
import { createReadStream } from "node:fs";
import { downloadAttachment } from "./attachments.ts";
import { htmlToPlainText, TELEGRAM_CHUNK_LIMIT, toTelegramChunks } from "./markdown.ts";
import { groupGate, type GroupGateInput } from "./mentions.ts";
import { splitMessage } from "./text.ts";

/** Bot API uploads stop at 50 MB. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Only a genuinely long run gets a message; short ones just show typing. */
const SLOW_RUN_MS = 60_000;
const TYPING_REFRESH_MS = 4_500;

const SLOW_TEXT = "Still on it. I'll post the result here when it's done.";
const QUEUED_TEXT = "Got it, I'll fold that in at my next step.";

const PROMPT_HINT = [
  "You are chatting on Telegram. Your Markdown is rendered to Telegram HTML: bold, italics, inline code, code blocks, links, and quotes work; keep tables small.",
  "In a group, answer only the message addressed to you and keep it short.",
  `send_file can deliver files up to ${formatBytes(MAX_UPLOAD_BYTES)}.`,
].join(" ");

export interface TelegramOptions {
  token: string;
  /** Numeric Telegram user IDs allowed to talk to the bot. */
  allowedUsers: ReadonlySet<string>;
  log: Logger;
}

/** Telegram over long polling: an input and an output service in one. */
export type TelegramService = InputService & OutputService;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sendChunks(api: Api, chat: string, text: string, replyTo: number | undefined): Promise<void> {
  let quote = replyTo;
  for (const chunk of toTelegramChunks(text, TELEGRAM_CHUNK_LIMIT)) {
    const reply = quote === undefined ? {} : { reply_parameters: { message_id: quote, allow_sending_without_reply: true } };
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
  const { token, allowedUsers, log } = options;
  const bot = new Bot(token);
  /** The newest message each chat sent us, quoted by the next answer. */
  const replyTargets = new Map<string, number>();
  /** Typing loops and slow-run notices for chats with work in flight. */
  const working = new Map<string, () => void>();
  let sink: InboundSink | undefined;
  let polling: Promise<void> | undefined;

  const addressOf = (ctx: Context): Address => ({ service: "telegram", chat: String(ctx.chat!.id) });

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
    if (ctx.message) replyTargets.set(event.from.chat, ctx.message.message_id);
    try {
      await sink?.(event);
    } catch (error) {
      log.error("inbound event failed", { from: event.from, error });
      await ctx.reply(`Something broke: ${errorText(error).slice(0, 500)}`).catch(() => undefined);
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

  /** Group messages count only when they mention or reply to the bot; returns the text addressed to it. */
  function addressedText(ctx: Context, text: string, entities: GroupGateInput["entities"]): string | undefined {
    const gate = groupGate({
      isGroup: ctx.chat?.type !== "private",
      text,
      botUsername: ctx.me.username,
      botId: ctx.me.id,
      entities,
      replyToBot: ctx.message?.reply_to_message?.from?.id === ctx.me.id,
    });
    return gate.respond ? gate.text.trim() : undefined;
  }

  bot.on("message:text", async (ctx) => {
    const text = addressedText(ctx, ctx.message.text, ctx.message.entities);
    if (text === undefined) return;
    const from = addressOf(ctx);
    const id = `telegram:${ctx.update.update_id}`;

    if (!text.startsWith("/")) {
      await emit(ctx, { kind: "message", from, id, text, attachments: [] });
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

      let attachment;
      try {
        attachment = await downloadAttachment(ctx, token);
      } catch (error) {
        await ctx.reply(`Could not receive that file: ${errorText(error).slice(0, 500)}`).catch(() => undefined);
        return;
      }
      if (!attachment) {
        await ctx.reply("Unsupported attachment type.");
        return;
      }
      const id = `telegram:${ctx.update.update_id}`;
      await emit(ctx, { kind: "message", from: addressOf(ctx), id, text, attachments: [attachment] });
    },
  );

  /** Send one message through the Bot API; throws whatever grammY throws. */
  async function deliver(chat: string, message: OutboundMessage): Promise<void> {
    switch (message.kind) {
      case "text":
        return sendChunks(bot.api, chat, message.text, replyTargets.get(chat));
      case "file":
        await bot.api.sendDocument(chat, new InputFile(createReadStream(message.localPath), message.name), {
          caption: message.caption,
        });
        return;
      case "status":
        if (message.status === "idle") stopWorking(chat);
        else startWorking(chat);
        if (message.status === "queued") await bot.api.sendMessage(chat, QUEUED_TEXT);
        return;
    }
  }

  bot.catch((error) => log.error("unhandled bot error", { updateId: error.ctx.update.update_id, error: error.error }));

  return {
    name: "telegram",
    promptHint: PROMPT_HINT,

    start(next) {
      sink = next;
      return new Promise((resolve, reject) => {
        polling = bot.start({
          allowed_updates: ["message"],
          onStart: (info) => {
            log.info("telegram online", { username: info.username });
            if (!info.can_read_all_group_messages) {
              log.warn("group privacy is on: the bot only sees commands, mentions, and replies in groups");
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
          new DeliveryFailed({ service: "telegram", reason: "failed", message: `Telegram rejected it: ${errorText(cause)}`, cause }),
      });
    },
  };
}
