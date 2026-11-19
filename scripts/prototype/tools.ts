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
import { createModelsRegistry } from "../packages/llm/src/index.ts";
import { sbxExec } from "../packages/sandbox/src/index.ts";

const env = loadEnv();
const sandbox = { name: env.SBX_NAME };
const context = BACKGROUND_CONTEXT;
const modelId = env.MODEL_MAIN ?? env.LLM_MODEL ?? "";

const bash = defineTool({
  name: "bash",
  description: "Run a bash command inside the agent sandbox.",
  parameters: obj({ command: str() }),
  execute: async (args) => {
    console.log("tool execute:", args.command);
    const result = await sbxExec(sandbox, args.command, {
      cwd: env.SBX_WORKDIR,
      timeoutMs: 60_000,
    });
    console.log("tool exit:", result.exitCode, result.output.slice(0, 100));
    return { output: [{ type: "text", text: `exit ${result.exitCode}\n${result.output}` }] };
  },
});

const registry = createRegistry();
const toolsExtension = defineExtension({ name: "eien-tools", tools: [bash] });
registry.install(toolsExtension);

const storage = await openNodeJsonlStorage("/tmp/opencode/durable-probe2", context);
const harness = await Harness.open(
  storage,
  {
    models: createModelsRegistry(env),
    registry,
    onReport: (report) => console.log("REPORT:", JSON.stringify(report).slice(0, 600)),
  },
  context,
);
const root = await harness.root(context, {
  agent: {
    model: { provider: "eien", modelId },
    extensions: [toolsExtension],
    cwd: env.SBX_WORKDIR,
    maxTurns: 5,
  },
});

const submission = await root.submit(
  {
    type: "input",
    content:
      "Use the bash tool to run `echo hello-$((40+2))`. Then reply with exactly the command's output.",
  },
  context,
);

const settled = await submission.wait(context);
console.log("status:", settled.status, "answerId:", "answer" in settled ? settled.answer : "-");

const page = await root.entries({}, 100, undefined, context);
for (const entry of page.items) {
  const data = entry as unknown as { kind?: string; id?: number };
  console.log("entry:", data.kind, data.id, JSON.stringify(entry).slice(0, 220));
}

await harness.close(context);
