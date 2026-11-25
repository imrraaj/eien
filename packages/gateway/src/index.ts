import { buildInstructions, createAgentRuntime, formatSchedules, loadSoul, operatingManual } from "@eien/agent";
import { InputHub, OutputRouter, type Address, type InboundEvent } from "@eien/io";
import { createModelsRegistry, resolveModelId } from "@eien/llm";
import { createSandbox, type SandboxConfig } from "@eien/sandbox";
import { createLogger, loadEnv, type Env } from "@eien/shared";
import { createTelegramService } from "@eien/telegram";

const MAX_INPUT_CHARS = 8_000;

const HELP = [
    "Send me a task; I work in the sandbox with bash, read, write, and edit.",
    "",
    "/reset: clear this chat's context",
    "/schedules: list reminders and repeating tasks",
    "/unschedule <name>: cancel one",
    "/model: show the active model",
    "/status: sandbox and limits",
    "/help: this message",
].join("\n");

function sandboxConfig(env: Env): SandboxConfig {
    if (env.SANDBOX_DRIVER === "docker") {
        return {
            driver: "docker",
            name: env.SBX_NAME,
            root: env.SBX_WORKDIR,
            docker: {
                image: env.SANDBOX_DOCKER_IMAGE,
                network: env.SANDBOX_DOCKER_NETWORK,
            },
        };
    }
    return { driver: "sbx", name: env.SBX_NAME, root: env.SBX_WORKDIR };
}

async function main(): Promise<void> {
    const env = loadEnv();
    const log = createLogger({ level: env.LOG_LEVEL, bindings: { service: "gateway" } });
    if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
    if (env.ALLOWED_TELEGRAM_USER_IDS.length === 0) {
        throw new Error("ALLOWED_TELEGRAM_USER_IDS is empty. Set your numeric Telegram user ID to lock the bot down.");
    }

    const modelId = resolveModelId(env);
    const sandbox = createSandbox(sandboxConfig(env));
    const storagePath = `${env.STATE_DIR}/eien.sqlite`;
    const base =
        env.SYSTEM_PROMPT ?? `${await loadSoul(env.SOUL_PATH)}\n\n${operatingManual(sandbox.name, sandbox.root)}`;

    // Services register before the runtime opens, so reattached chats get their prompt hints.
    const outputs = new OutputRouter();
    const telegram = createTelegramService({
        token: env.TELEGRAM_BOT_TOKEN,
        allowedUsers: new Set(env.ALLOWED_TELEGRAM_USER_IDS),
        log,
    });
    outputs.add(telegram);

    const runtime = await createAgentRuntime({
        storagePath,
        models: createModelsRegistry(env),
        modelId,
        maxTurns: env.MAX_AGENT_STEPS,
        sandbox,
        web: { mcpUrl: env.EXA_MCP_URL, exaApiKey: env.EXA_API_KEY },
        outbox: outputs,
        instructions: (service) => buildInstructions(base, outputs.promptHint(service)),
        log,
    });

    async function reply(to: Address, text: string): Promise<void> {
        const sent = await outputs.send(to, { kind: "text", text });
        if (sent.isErr()) log.warn("could not reply", { to, error: sent.error });
    }

    async function command(from: Address, name: string, args: readonly string[]): Promise<void> {
        switch (name) {
            case "start":
            case "help":
                return reply(from, HELP);
            case "reset":
                await runtime.reset(from);
                return reply(from, "Context cleared.");
            case "schedules":
                return reply(from, formatSchedules(await runtime.schedules(from), Date.now()));
            case "unschedule": {
                const target = args[0];
                if (!target) return reply(from, "Usage: /unschedule <name>");
                const cancelled = await runtime.cancelSchedule(from, target);
                return reply(from, cancelled ? `Cancelled "${target}".` : `No schedule named "${target}".`);
            }
            case "model":
                return reply(from, `Model: ${modelId}`);
            case "status":
                return reply(
                    from,
                    [
                        `sandbox: ${sandbox.driver} (${sandbox.name}, ${sandbox.root})`,
                        `model: ${modelId}`,
                        `max turns/run: ${env.MAX_AGENT_STEPS}`,
                        `storage: ${storagePath}`,
                    ].join("\n"),
                );
            default:
                return reply(from, "Unknown command. Try /help.");
        }
    }

    async function handle(event: InboundEvent): Promise<void> {
        if (event.kind === "command") return command(event.from, event.name, event.args);
        if (event.text.length > MAX_INPUT_CHARS) {
            return reply(event.from, `Message too long (${event.text.length} chars). The limit is ${MAX_INPUT_CHARS}.`);
        }
        if (!event.text && event.attachments.length === 0) return reply(event.from, "How can I help?");
        const admitted = await runtime.prompt(event.from, event.text, event.id, event.attachments);
        if (admitted.isErr()) await reply(event.from, `Could not store the attachment: ${admitted.error.message}`);
    }

    const inputs = new InputHub(handle);
    let stopping = false;
    const shutdown = async (signal: string) => {
        if (stopping) return;
        stopping = true;
        log.info("shutting down", { signal });
        await inputs.stopAll();
        await runtime.close();
        await sandbox.close?.();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));

    await inputs.add(telegram);
    log.info("gateway online", {
        model: modelId,
        sandbox: `${sandbox.driver} (${sandbox.name})`,
        storage: storagePath,
    });
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
