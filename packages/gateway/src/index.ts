import { createLogger, loadEnv } from "@eien/shared";
import { createLlm, type ModelMessage } from "@eien/llm";
import { Bot, type Context } from "grammy";
import { ConversationStore } from "./history.ts";
import { splitMessage } from "./text.ts";

const MAX_INPUT_CHARS = 8_000;

const DEFAULT_SYSTEM_PROMPT = [
  "You are eien, a pragmatic engineering assistant chatting over Telegram.",
  "Be concise. Plain text with occasional code blocks is fine.",
  "You have no tools in this version: never claim to have run commands,",
  "read files, or changed anything.",
].join(" ");

const HELP_TEXT = [
  "Send me any message and I will ask the configured model.",
  "",
  "/reset — clear this chat's context",
  "/model — show the active model",
  "/help — this message",
].join("\n");

function errorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function userFacingError(error: unknown): string {
  const status = errorStatus(error);
  if (status === 429) {
    return "The model provider is rate limiting this key. Try again in a moment.";
  }
  if (status === 401 || status === 403) {
    return "The model provider rejected the API key. Check LLM_API_KEY in .env.";
  }
  if (status !== undefined && status >= 500) {
    return `The model provider returned an error (HTTP ${status}). Try again.`;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "The model call timed out. Try a shorter request.";
  }
  return "The model call failed. Check the gateway logs for details.";
}

function startTyping(ctx: Context): () => void {
  const send = () => {
    void ctx.replyWithChatAction("typing").catch(() => undefined);
  };
  send();
  const timer = setInterval(send, 4_500);
  return () => clearInterval(timer);
}

async function replyInChunks(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await ctx.reply(chunk);
  }
}

async function handleCommand(
  ctx: Context,
  text: string,
  history: ConversationStore,
  userId: string,
  model: string,
): Promise<void> {
  const command = text.split(/\s+/)[0]?.slice(1).split("@")[0] ?? "";

  switch (command) {
    case "start":
      await ctx.reply(
        "Hi. I am eien. Send me a message and I will pass it to the configured model.",
      );
      return;
    case "help":
      await ctx.reply(HELP_TEXT);
      return;
    case "reset":
      history.reset(userId);
      await ctx.reply("Context cleared.");
      return;
    case "model":
      await ctx.reply(`Model: ${model}`);
      return;
    default:
      await ctx.reply("Unknown command. Try /help.");
  }
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

  // Fails fast on a missing key/model, before Telegram starts polling.
  const llm = createLlm(env);
  const modelId = llm.modelId("main");
  const systemPrompt = env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT;

  const history = new ConversationStore();
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

  bot.on("message:text", async (ctx) => {
    const userId = String(ctx.from.id);
    const text = ctx.message.text.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      await handleCommand(ctx, text, history, userId, modelId);
      return;
    }

    if (text.length > MAX_INPUT_CHARS) {
      await ctx.reply(
        `Message too long (${text.length} chars). The limit is ${MAX_INPUT_CHARS}.`,
      );
      return;
    }

    const userMessage: ModelMessage = { role: "user", content: text };
    const messages = [...history.get(userId), userMessage];

    const stopTyping = startTyping(ctx);
    const startedAt = Date.now();

    try {
      const result = await llm.chat({
        kind: "main",
        system: systemPrompt,
        messages,
        abortSignal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
      });

      history.set(userId, [
        ...messages,
        { role: "assistant", content: result.text },
      ]);

      await replyInChunks(ctx, result.text || "(the model returned an empty reply)");

      log.info("turn complete", {
        telegramUserId: userId,
        model: result.model,
        finishReason: result.finishReason,
        ms: Date.now() - startedAt,
        usage: result.usage,
      });
    } catch (error) {
      log.error("turn failed", {
        telegramUserId: userId,
        model: modelId,
        ms: Date.now() - startedAt,
        error,
      });
      await ctx.reply(userFacingError(error)).catch(() => undefined);
    } finally {
      stopTyping();
    }
  });

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
    allowedUsers: allowedUsers.size,
  });

  await bot.start({
    allowed_updates: ["message"],
    onStart: (info) => log.info("gateway online", { username: info.username }),
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
