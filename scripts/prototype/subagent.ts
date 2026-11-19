import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { loadEnv } from "../../packages/shared/src/index.ts";
import { createModelsRegistry } from "../../packages/llm/src/index.ts";
import { sbxExec } from "../../packages/sandbox/src/index.ts";

const env = loadEnv();
const sandbox = { name: env.SBX_NAME };
const context = BACKGROUND_CONTEXT;
const modelId = env.MODEL_MAIN ?? env.LLM_MODEL ?? "";

const bash = defineTool({
  name: "bash",
  description: "Run a bash command inside the agent sandbox.",
  parameters: obj({ command: str() }),
  execute: async (args) => {
    const result = await sbxExec(sandbox, args.command, {
      cwd: env.SBX_WORKDIR,
      timeoutMs: 60_000,
    });
    return {
      output: [{ type: "text" as const, text: `exit ${result.exitCode}\n${result.output}` }],
    };
  },
});

const subagent = defineTool({
  name: "subagent",
  description: "Delegate a self-contained task to a child conversation and get its answer.",
  parameters: obj({ task: str() }),
  execute: async (args, api, ctx) => {
    const childId = await api.commit(async (tx) => {
      const created = await tx.createConversation({
        ownership: { kind: "task", taskId: api.taskId },
      });
      return created.id;
    }, ctx);

    const child = await api.conversation(childId);
    if (!child) throw new Error("child conversation missing");

    const submission = await child.submit({ type: "input", content: args.task }, ctx);
    const settled = await submission.wait(ctx);
    if (settled.status !== "done") {
      return { output: [{ type: "text" as const, text: `child ${settled.status}` }] };
    }

    const entry = (await api.commit((tx) => tx.entry(settled.answer), ctx)) as unknown as {
      model?: Array<{ content?: Array<{ type: string; text?: string }> }>;
    } | undefined;
    const text = (entry.model?.[0]?.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();

    return {
      output: [{ type: "text" as const, text: text || "(child returned no text)" }],
      details: { childConversationId: childId },
    };
  },
});

const registry = createRegistry();
const ext = defineExtension({ name: "eien-tools", tools: [bash, subagent] });
registry.install(ext);

const storage = await openNodeJsonlStorage("/tmp/opencode/durable-probe3", context);
const harness = await Harness.open(
  storage,
  {
    models: createModelsRegistry(env),
    registry,
    onReport: (report) => console.log("REPORT:", JSON.stringify(report).slice(0, 400)),
  },
  context,
);
const root = await harness.root(context, {
  agent: { model: { provider: "eien", modelId }, extensions: [ext], cwd: env.SBX_WORKDIR },
});

const submission = await root.submit(
  {
    type: "input",
    content:
      "Call the subagent tool once, asking it to run `echo child-says-hi` with its bash tool and report the output. Then reply with the subagent's output verbatim.",
  },
  context,
);
const settled = await submission.wait(context);
console.log("parent status:", settled.status);

const page = await root.entries({}, 20, undefined, context);
for (const entry of page.items) {
  const record = entry as unknown as { kind?: string; model?: Array<{ content?: Array<{ type: string; text?: string }> }> };
  if (record.kind === "pi.tool-result") {
    console.log("parent tool result:", JSON.stringify(record.model).slice(0, 300));
  }
}
console.log("parent answer entry:", settled.status === "done" ? settled.answer : "-");

await harness.close(context);
