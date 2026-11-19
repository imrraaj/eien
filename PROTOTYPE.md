# pi-durable prototype

Spike for replacing the hand-rolled turn loop with `@earendil-works/pi-durable`.

## Verified

Run from the repo root (needs `.env`):

```bash
bun .tmp/probe.ts          # steering lands after the current tool round
bun .tmp/tool-probe.ts     # sandbox bash tool through sbx exec
bun .tmp/subagent-probe.ts # child conversation returns its answer
```

Results:

- Our OpenAI-compatible provider works unchanged: `createModelsRegistry(env)` is
  now exported from `@eien/llm` and handed to `Harness.open({ models })`.
- `defineTool` → `sbx exec` works; the result must be
  `{ output: [{ type: "text", text }] }` (`output` is a content list, not a string).
- Steering: submitting with `whenBusy: "steer"` while a 15 s tool ran placed the
  `pi.user` entry **after** `pi.tool-result` and before the final answer — the
  same semantics as our `Steering` class, but durable.
- Subagent: a tool created a child conversation with
  `ownership: { kind: "task", taskId }`, drove it with
  `api.conversation(id).submit(...)`, and returned the child's answer as the
  tool result. Read the answer with `api.commit((tx) => tx.entry(answerId))`.
- Storage: JSONL (`/tmp/opencode/durable-probe*`) persists across process runs.

## Migration map

| Current | pi-durable |
|---|---|
| `runAgentTurn` loop | `pi.generation` + `pi.tool` tasks |
| `steering.ts` | `submit(..., { whenBusy: "steer" })` |
| `spawn_agent` + `createLimiter` | tool that creates an owned child conversation |
| `ConversationStore` | SQLite or JSONL storage |
| `/stop` | `root.abort()` |
| `MAX_AGENT_STEPS` | `maxTurns` per conversation |

Still ours: Telegram polling/HTML/files, the sbx tool implementations,
allowlist, ack messages, and the gateway wiring.

## Open questions

- SQLite backend under Bun (`openNodeSqliteStorage`) — untested; JSONL works.
- Restart mid-tool: `replay: "safe"` for idempotent tools; `bash` is not safe.
- The API is marked experimental (v1.5.2).
