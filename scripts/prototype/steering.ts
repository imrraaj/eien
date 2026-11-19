import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { loadEnv } from "../packages/shared/src/index.ts";
import {
  createModelsRegistry,
  resolveModelId,
} from "../packages/llm/src/index.ts";
import { sbxExec } from "../packages/sandbox/src/index.ts";

const env = loadEnv();
const sandbox = { name: env.SBX_NAME };
const context = BACKGROUND_CONTEXT;
const modelId = resolveModelId(env);

const bash = defineTool({
  name: "bash",
  description: "Run a bash command inside the agent sandbox.",
  parameters: obj({ command: str() }),
  execute: async (args) => {
    const result = await sbxExec(sandbox, args.command, {
      cwd: env.SBX_WORKDIR,
      timeoutMs: 120_000,
    });
    return { output: [{ type: "text", text: `exit ${result.exitCode}\n${result.output}` }] };
  },
});

const registry = createRegistry();
const toolsExtension = defineExtension({
  name: "eien-tools",
  tools: [bash],
  sections: [
    {
      text: `You are eien. Work inside the sandbox workspace ${env.SBX_WORKDIR}. Be concise.`,
    },
  ],
});
registry.install(toolsExtension);

const storage = await openNodeJsonlStorage("/tmp/opencode/durable-probe", context);
const harness = await Harness.open(
  storage,
  { models: createModelsRegistry(env), registry },
  context,
);
const root = await harness.root(context, {
  agent: {
    model: { provider: "eien", modelId },
    extensions: [toolsExtension],
    cwd: env.SBX_WORKDIR,
    maxTurns: 10,
  },
});

console.log("root conversation:", root.id);

const submission = await root.submit(
  {
    type: "input",
    content:
      "Run `sleep 15` with bash, then answer with the word READY. Do not do anything else.",
  },
  context,
);

// Steering: this must land after the current tool round.
await Bun.sleep(4_000);
const steer = await root.submit(
  { type: "input", content: "Also include the word STEERED in your answer.", whenBusy: "steer" },
  context,
);
console.log("steer accepted:", !(steer instanceof Error));

const settled = await submission.wait(context);
console.log("status:", settled.status);
console.log("answer:", "answer" in settled ? settled.answer : settled);

const page = await root.entries({}, 100, undefined, context);
console.log("transcript:", page.items.map((entry) => entry.kind).join(" → "));
for (const entry of page.items) {
  console.log(" -", JSON.stringify(entry).slice(0, 420));
}

await harness.close(context);
