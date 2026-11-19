# eien — always-on coding agent

A personal coding agent reachable over Telegram. The current MVP uses **pi-ai**
(the SDK under Pi) for the model/tool loop and grammY for Telegram. Tools run
inside the `sbx` sandbox VM: `bash`, `read`, `write`, `edit`.

See [`always-on-agent-plan.md`](./always-on-agent-plan.md) for the full design.
Temporal orchestration is intentionally deferred.

## Status

- [x] Docker Compose: Postgres, Temporal, Temporal UI, admin tools
- [x] Sandbox `agent-1` with scoped egress, git identity, `/work`
- [x] pi-ai client for any OpenAI-compatible endpoint
- [x] Telegram bot with allowlist, per-user history, `/reset`, `/model`, `/status`
- [x] Sandbox coding tools (`bash`, `read`, `write`, `edit`), path-confined to `/work`
- [ ] Durable workflows, child workers, schedules (next: Temporal)
- [ ] Postgres transcripts and memory

## Quick start

```bash
cp .env.example .env      # fill in LLM + Telegram values
bun install
bun run up                # optional for now, Temporal stack
./sandbox/bootstrap.sh    # create the agent-1 sandbox
bun run bot
```

Required in `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=...
ALLOWED_TELEGRAM_USER_IDS=123456789   # comma-separated numeric IDs

LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=...
MODEL_MAIN=...                        # or LLM_MODEL
```

Any OpenAI-compatible endpoint works (`LLM_BASE_URL`). OpenRouter attribution
headers are only added for openrouter.ai.

Commands: `/reset`, `/model`, `/status`, `/help`. The bot uses long polling, so
no inbound ports are needed.

## Sandbox

```bash
./sandbox/bootstrap.sh
sbx exec agent-1 -- bash -lc 'pwd'
```

Creates `agent-1`, applies a scoped network allowlist (git, npm/pypi, runtime
hosts), sets git identity and `known_hosts`, and makes `/work` writable by the
sandbox user. Tools are confined to `/work`; absolute paths elsewhere are
rejected.

## Layout

```
docker-compose.yml            Temporal + Postgres + UI (unused by the MVP bot)
docker/initdb/                first-boot SQL (creates the `agent` DB)
docker/dynamicconfig/         Temporal dev dynamic config
packages/shared/              env schema, logger
packages/llm/                 pi-ai client, provider-agnostic
packages/sandbox/             sbx exec + file helpers, path confinement
packages/tools/               tool schemas and dispatcher
packages/gateway/             grammY bot, in-memory history, agent turn loop
sandbox/                      sbx bootstrap + network policy
```

## Checks

```bash
bun run check    # tsc --noEmit + bun test
```

## Environment

Validated by `packages/shared/src/env.ts`; empty values are treated as unset.
`.env` is gitignored and `.env.example` holds placeholders only. Secrets stay in
the gateway process — never in prompts, tool results, or the sandbox.

History is in memory for now, so restarting the bot clears conversations.
