import { createLlm, createModelsRegistry } from "@eien/llm";
import { createLogger, loadEnv } from "@eien/shared";
import { createSandbox, type SandboxConfig } from "@eien/sandbox";
import { Bot, type Context } from "grammy";
import { ACK_TEXT } from "./ack.ts";
import {
  describeIngestedFile,
  ingestTelegramFile,
} from "./files.ts";
import { createAgentRuntime } from "./harness.ts";
import { groupGate } from "./mentions.ts";
import {
  htmlToPlainText,
  TELEGRAM_CHUNK_LIMIT,
  toTelegramChunks,
} from "./markdown.ts";
import { defaultSystemPrompt } from "./prompt.ts";
import { splitMessage } from "./text.ts";

const MAX_INPUT_CHARS = 8_000;
/** Only a genuinely long turn gets a message; short ones just show typing. */
const ACK_DELAY_MS = 60_000;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function startTyping(ctx: Context): () => void {
  const send = () => {
    void ctx.replyWithChatAction("typing").catch(() => undefined);
  };
  send();
  const timer = setInterval(send, 4_500);
  return () => clearInterval(timer);
}

async function sendInChunks(
  api: Context["api"],
  chatId: number | string,
  text: string,
  replyTo?: number,
): Promise<void> {
  let first = true;
  for (const chunk of toTelegramChunks(text, TELEGRAM_CHUNK_LIMIT)) {
    const reply = first && replyTo !== undefined ? { reply_parameters: { message_id: replyTo } } : {};
    first = false;
    try {
      await api.sendMessage(chatId, chunk, { parse_mode: "HTML", ...reply });
    } catch {
      // The quoted message may be gone; retry without the quote before falling back to plain text.
      if (replyTo !== undefined) {
        try {
          await api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
          continue;
        } catch {
          // Fall through to the plain-text path.
        }
      }
      // Telegram rejected the markup: resend as readable plain text.
      for (const plain of splitMessage(htmlToPlainText(chunk))) {
        await api.sendMessage(chatId, plain);
      }
    }
  }
}

async function replyInChunks(ctx: Context, text: string): Promise<void> {
  if (ctx.chat) await sendInChunks(ctx.api, ctx.chat.id, text);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({
    level: env.LOG_LEVEL,
    bindings: { service: "gateway" },
  });

  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not set. Add it to .env before starting the gateway.",
    );
  }

  const allowedUsers = new Set(env.ALLOWED_TELEGRAM_USER_IDS);
  if (allowedUsers.size === 0) {
    throw new Error(
      "ALLOWED_TELEGRAM_USER_IDS is empty. Set your numeric Telegram user ID to lock the bot down.",
    );
  }

  const llm = createLlm(env);
  const modelId = llm.modelId("main");
  const systemPrompt =
    env.SYSTEM_PROMPT ?? defaultSystemPrompt(env.SBX_NAME, env.SBX_WORKDIR);
  const sandboxConfig: SandboxConfig =
    env.SANDBOX_DRIVER === "ssh"
      ? {
          driver: "ssh",
          name: env.SBX_NAME,
          root: env.SBX_WORKDIR,
          ssh: {
            host: env.SANDBOX_SSH_HOST,
            user: env.SANDBOX_SSH_USER,
            port: env.SANDBOX_SSH_PORT,
            keyPath: env.SANDBOX_SSH_KEY,
            knownHostsPath: env.SANDBOX_SSH_KNOWN_HOSTS,
          },
        }
      : { driver: "sbx", name: env.SBX_NAME, root: env.SBX_WORKDIR };
  const sandbox = createSandbox(sandboxConfig);

  const runtime = await createAgentRuntime({
    env,
    modelId,
    models: createModelsRegistry(env),
    system: systemPrompt,
    storageDir: `${env.STATE_DIR}/harness`,
    chatMapPath: `${env.STATE_DIR}/chats.json`,
    sandbox,
    log,
    onAnswer: (chatId, text, replyTo) => sendInChunks(bot.api, chatId, text, replyTo),
  });

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.use(async (ctx, next) => {
    const telegramId = ctx.from?.id;
    if (telegramId === undefined || !allowedUsers.has(String(telegramId))) {
      log.warn("blocked non-allowlisted user", {
        telegramUserId: telegramId,
        chatType: ctx.chat?.type,
      });
      return;
    }
    await next();
  });

  async function handleCommand(
    ctx: Context,
    text: string,
    conversationId: string,
  ): Promise<void> {
    const command = text.split(/\s+/)[0]?.slice(1).split("@")[0] ?? "";

    switch (command) {
      case "start":
        await ctx.reply(
          `Hi. I am eien, running inside sandbox "${env.SBX_NAME}". Send me a coding task.`,
        );
        return;
      case "help":
        await ctx.reply(
          [
            "Send me a coding task; I will use bash/read/write/edit in the sandbox.",
            "",
            "/reset — clear this chat's context",
            "/schedules — list reminders and repeating tasks",
            "/unschedule <name> — cancel one",
            "/model — show the active model",
            "/status — sandbox and limits",
            "/id — show chat and user IDs",
            "/help — this message",
          ].join("\n"),
        );
        return;
      case "reset":
        await runtime.reset(conversationId);
        await ctx.reply("Context cleared.");
        return;
      case "schedules":
        await ctx.reply(await runtime.schedules(conversationId));
        return;
      case "unschedule": {
        const name = text.split(/\s+/)[1];
        if (!name) {
          await ctx.reply("Usage: /unschedule <name>");
          return;
        }
        const cancelled = await runtime.cancelSchedule(conversationId, name);
        await ctx.reply(cancelled ? `Cancelled "${name}".` : `No schedule named "${name}".`);
        return;
      }
      case "model":
        await ctx.reply(`Model: ${modelId}`);
        return;
      case "id":
        await ctx.reply(
          [
            `chat: ${ctx.chat?.id ?? "unknown"}`,
            `type: ${ctx.chat?.type ?? "unknown"}`,
            `you: ${ctx.from?.id ?? "unknown"}`,
          ].join("\n"),
        );
        return;
      case "status":
        await ctx.reply(
          [
            `sandbox: ${sandbox.driver} (${sandbox.name}, ${sandbox.root})`,
            `workdir: ${env.SBX_WORKDIR}`,
            `model: ${modelId}`,
            `max turns/run: ${env.MAX_AGENT_STEPS}`,
            `durable storage: ${env.STATE_DIR}/harness`,
          ].join("\n"),
        );
        return;
      default:
        await ctx.reply("Unknown command. Try /help.");
    }
  }

  /** Chats whose turn this process started and has not finished. */
  const activeTurns = new Set<string>();

  async function handlePrompt(
    ctx: Context,
    telegramUserId: string,
    prompt: string,
  ): Promise<void> {
    const conversationId = String(ctx.chat?.id ?? telegramUserId);

    if (!prompt) {
      await ctx.reply("How can I help?");
      return;
    }

    if (prompt.length > MAX_INPUT_CHARS) {
      await ctx.reply(
        `Message too long (${prompt.length} chars). The limit is ${MAX_INPUT_CHARS}.`,
      );
      return;
    }

    // A run is already going in this chat: steer it instead of blocking.
    if (activeTurns.has(conversationId) || runtime.isBusy(conversationId)) {
      const accepted = await runtime.steer(
        conversationId,
        prompt,
        `telegram:${ctx.update.update_id}`,
        ctx.message?.message_id,
      );
      log.info("steering message", { telegramUserId, chatId: conversationId, accepted });
      await ctx
        .reply(
          accepted
            ? "Queued — the agent will get to it at its next step."
            : "The run is finishing; send that again in a moment.",
        )
        .catch(() => undefined);
      return;
    }

    // grammY handles updates one at a time and awaits each handler, so awaiting the
    // whole turn here would make later messages wait in the polling loop instead of
    // steering. Start it, return, and let the next update through.
    activeTurns.add(conversationId);
    void runTurn(ctx, conversationId, prompt, telegramUserId)
      .catch((error: unknown) => log.error("turn crashed", { conversationId, error }))
      .finally(() => activeTurns.delete(conversationId));
  }

  async function runTurn(
    ctx: Context,
    conversationId: string,
    prompt: string,
    telegramUserId: string,
  ): Promise<void> {
    const stopTyping = startTyping(ctx);
    const startedAt = Date.now();
    let acknowledged = false;
    const acknowledge = () => {
      if (acknowledged) return;
      acknowledged = true;
      void ctx.reply(ACK_TEXT).catch(() => undefined);
    };
    const ackTimer = setTimeout(acknowledge, ACK_DELAY_MS);

    try {
      const text = await runtime.run(
        ctx,
        conversationId,
        prompt,
        `telegram:${ctx.update.update_id}`,
      );
      // Success is delivered by the conversation watcher; only failures come back here.
      if (text) await replyInChunks(ctx, text);
      log.info("turn complete", {
        telegramUserId,
        chatId: conversationId,
        chatType: ctx.chat?.type,
        ms: Date.now() - startedAt,
      });
    } catch (error) {
      log.error("turn failed", {
        telegramUserId,
        chatId: conversationId,
        model: modelId,
        ms: Date.now() - startedAt,
        error,
      });
      await ctx
        .reply(`Model call failed:\n${errorText(error).slice(0, 800)}`)
        .catch(() => undefined);
    } finally {
      clearTimeout(ackTimer);
      stopTyping();
    }
  }

  bot.on("message:text", async (ctx) => {
    const telegramUserId = String(ctx.from.id);
    const isGroup = ctx.chat.type !== "private";
    const repliedToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
    const gate = groupGate({
      isGroup,
      text: ctx.message.text,
      botUsername: ctx.me.username,
      botId: ctx.me.id,
      entities: ctx.message.entities,
      replyToBot: repliedToBot,
    });

    if (!gate.respond) {
      if (isGroup) {
        log.info("ignored group message", {
          chatId: String(ctx.chat.id),
          chatType: ctx.chat.type,
          fromId: telegramUserId,
          entities: ctx.message.entities?.map((entity) => entity.type) ?? [],
        });
      }
      return;
    }

    const text = gate.text.trim();

    if (text.startsWith("/")) {
      await handleCommand(ctx, text, String(ctx.chat.id));
      return;
    }

    await handlePrompt(ctx, telegramUserId, text);
  });

  bot.on(
    [
      "message:document",
      "message:photo",
      "message:video",
      "message:audio",
      "message:voice",
      "message:video_note",
    ],
    async (ctx) => {
      const telegramUserId = String(ctx.from.id);
      const isGroup = ctx.chat.type !== "private";
      const caption = ctx.message.caption ?? "";
      const gate = groupGate({
        isGroup,
        text: caption,
        botUsername: ctx.me.username,
        botId: ctx.me.id,
        entities: ctx.message.caption_entities,
        replyToBot: ctx.message.reply_to_message?.from?.id === ctx.me.id,
      });

      if (!gate.respond) return;

      const stopTyping = startTyping(ctx);
      try {
        const file = await ingestTelegramFile(
          ctx,
          sandbox,
          env.TELEGRAM_BOT_TOKEN ?? "",
        );
        if (!file) {
          await ctx.reply("Unsupported attachment type.");
          return;
        }

        const instruction = gate.text.trim() || "The user sent this file without instructions.";
        await handlePrompt(
          ctx,
          telegramUserId,
          `${instruction}\n\n${describeIngestedFile(file)}`,
        );
      } catch (error) {
        log.error("file ingestion failed", { telegramUserId, error });
        await ctx
          .reply(`Could not receive that file:\n${errorText(error).slice(0, 500)}`)
          .catch(() => undefined);
      } finally {
        stopTyping();
      }
    },
  );

  bot.catch((err) => {
    log.error("unhandled bot error", {
      updateId: err.ctx.update.update_id,
      error: err.error,
    });
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    await bot.stop();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  log.info("gateway starting", {
    model: modelId,
    sandbox: `${sandbox.driver} (${sandbox.name}, ${sandbox.root})`,
    workdir: env.SBX_WORKDIR,
    allowedUsers: allowedUsers.size,
    storage: `${env.STATE_DIR}/harness`,
  });

  await bot.start({
    allowed_updates: ["message"],
    onStart: (info) => {
      log.info("gateway online", {
        username: info.username,
        hint: `add the bot to a group, then address it as @${info.username}`,
      });
      if (!info.can_read_all_group_messages) {
        log.warn(
          "Telegram group privacy is ON: the bot only receives commands, mentions, and replies. Disable privacy mode in BotFather (/setprivacy) and re-add the bot to the group.",
          { canReadAllGroupMessages: false },
        );
      }
    },
  });
}

main().catch((error: unknown) => {
  console.error(errorText(error));
  process.exit(1);
});
