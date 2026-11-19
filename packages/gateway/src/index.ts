import { createLlm, type Message } from "@eien/llm";
import { sandboxTools, runTool } from "@eien/tools";
import { createLogger, loadEnv } from "@eien/shared";
import { Bot, type Context } from "grammy";
import { runAgentTurn } from "./agent.ts";
import { ConversationStore } from "./history.ts";
import { splitMessage } from "./text.ts";

const MAX_INPUT_CHARS = 8_000;

function defaultSystemPrompt(sandboxName: string, root: string): string {
  return [
    "You are eien, a pragmatic coding agent reachable over Telegram.",
    `You operate inside a sandbox VM named "${sandboxName}". The workspace is ${root}.`,
    "Use the bash, read, write, and edit tools for all work. They execute inside the sandbox, never on the host.",
    "The sandbox has network access to git hosting, package registries, and runtime download hosts only.",
    "Start by inspecting the workspace (pwd, ls) when you are unsure of its state.",
    "Keep commands non-interactive and bounded; long commands should use timeouts.",
    "Never claim to have run something you did not run. Report failures and non-zero exit codes honestly.",
    "Prefer small, verifiable steps and test your changes.",
    "Reply concisely. Summarize what you did and the important output; do not dump whole files.",
  ].join("\n");
}

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

async function replyInChunks(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await ctx.reply(chunk);
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

  const llm = createLlm(env);
  const modelId = llm.modelId("main");
  const systemPrompt =
    env.SYSTEM_PROMPT ?? defaultSystemPrompt(env.SBX_NAME, env.SBX_WORKDIR);
  const sandbox = { name: env.SBX_NAME };
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

  async function runTurn(
    userId: string,
    messages: Message[],
  ): Promise<{ messages: Message[]; text: string }> {
    return runAgentTurn({
      llm,
      messages,
      system: systemPrompt,
      tools: sandboxTools,
      maxSteps: env.MAX_AGENT_STEPS,
      timeoutMs: env.LLM_TIMEOUT_MS,
      sessionId: `telegram-${userId}`,
      executeTool: (call) => runTool(call, { sandbox, root: env.SBX_WORKDIR }),
      onToolCall: (call, result) => {
        log.info("tool call", {
          telegramUserId: userId,
          tool: call.name,
          isError: result.isError,
          ms: result.ms,
        });
      },
    });
  }

  async function handleCommand(
    ctx: Context,
    text: string,
    userId: string,
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
            "/model — show the active model",
            "/status — sandbox and limits",
            "/help — this message",
          ].join("\n"),
        );
        return;
      case "reset":
        history.reset(userId);
        await ctx.reply("Context cleared.");
        return;
      case "model":
        await ctx.reply(`Model: ${modelId}`);
        return;
      case "status":
        await ctx.reply(
          [
            `sandbox: ${env.SBX_NAME}`,
            `workdir: ${env.SBX_WORKDIR}`,
            `model: ${modelId}`,
            `max steps/turn: ${env.MAX_AGENT_STEPS}`,
          ].join("\n"),
        );
        return;
      default:
        await ctx.reply("Unknown command. Try /help.");
    }
  }

  bot.on("message:text", async (ctx) => {
    const userId = String(ctx.from.id);
    const text = ctx.message.text.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      await handleCommand(ctx, text, userId);
      return;
    }

    if (text.length > MAX_INPUT_CHARS) {
      await ctx.reply(
        `Message too long (${text.length} chars). The limit is ${MAX_INPUT_CHARS}.`,
      );
      return;
    }

    const userMessage: Message = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    const messages = [...history.get(userId), userMessage];
    const stopTyping = startTyping(ctx);
    const startedAt = Date.now();

    try {
      const result = await runTurn(userId, messages);
      history.set(userId, result.messages);
      await replyInChunks(ctx, result.text || "(the model returned no text)");
      log.info("turn complete", {
        telegramUserId: userId,
        ms: Date.now() - startedAt,
        messageCount: result.messages.length,
      });
    } catch (error) {
      log.error("turn failed", {
        telegramUserId: userId,
        model: modelId,
        ms: Date.now() - startedAt,
        error,
      });
      await ctx
        .reply(`Model call failed:\n${errorText(error).slice(0, 800)}`)
        .catch(() => undefined);
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
    sandbox: env.SBX_NAME,
    workdir: env.SBX_WORKDIR,
    allowedUsers: allowedUsers.size,
  });

  await bot.start({
    allowed_updates: ["message"],
    onStart: (info) => log.info("gateway online", { username: info.username }),
  });
}

main().catch((error: unknown) => {
  console.error(errorText(error));
  process.exit(1);
});
