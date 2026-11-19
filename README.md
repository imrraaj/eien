# eien — always-on coding agent

Self-hosted personal agent: Telegram chat, a main orchestrator agent, and worker
agents that operate on git repos inside an `sbx` sandbox. All orchestration will
run on Temporal, so crashes and multi-day approval waits are durable.

See [`always-on-agent-plan.md`](./always-on-agent-plan.md) for the full design.

> **Tooling note:** the plan says pnpm; this repo uses **Bun** workspaces
> (per the machine/agent conventions) — `bun install`, `bun run <script>`.

## Status

- [x] **Phase 0** — git + Bun workspace, Docker Compose (Postgres, Temporal, UI,
      admin tools), separate `agent` DB, Zod env validation, logger.
- [x] **Chat slice** — Telegram bot (grammY) → any OpenAI-compatible LLM →
      reply, with allowlist, per-user history, `/reset`, `/model`.
- [ ] **Phase 1** — move the chat loop onto Temporal (`mainAgent` + `llmStep` +
      durable `sendTelegram`, transcript in Postgres).
- [ ] Sandbox created and reachable (`sandbox/bootstrap.sh`).

## Quick start

```bash
cp .env.example .env      # fill in LLM + Telegram values
bun install
bun run up                # docker compose up -d
```

| Service | URL / address |
|---|---|
| Temporal frontend | `localhost:7233` |
| Temporal UI | http://localhost:8080 |
| Postgres | `localhost:5432` (`temporal` + `agent` databases) |

Verify infrastructure:

```bash
docker compose exec temporal-admin-tools temporal operator cluster health
docker compose exec postgresql psql -U agent -d agent -c 'select 1'
```

Stop / reset:

```bash
bun run down              # keep volumes
docker compose down -v    # wipe Postgres (recreates both DBs on next up)
```

## Running the bot

Required in `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=...
ALLOWED_TELEGRAM_USER_IDS=123456789   # your numeric Telegram ID, comma-separated

LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=...
MODEL_MAIN=...                        # or LLM_MODEL for a single-model setup
```

```bash
bun run bot        # foreground
bun run bot:dev    # reload on file changes
```

Any OpenAI-compatible endpoint works — point `LLM_BASE_URL` at it. For
non-OpenRouter endpoints the OpenRouter attribution headers are omitted.

The bot uses long polling (no inbound ports). Unknown Telegram users are
dropped before their message reaches the model. History is **in memory** in
this slice; restarting the process clears it (next milestone moves it to
Postgres/Temporal).

## Sandbox

```bash
./sandbox/bootstrap.sh
```

Creates the `agent-1` sandbox, applies a scoped network allowlist (git,
npm/pypi, runtime hosts), sets git identity and `known_hosts`. Deploy keys are
added manually per repo — see the script output.

## Layout

```
docker-compose.yml            Temporal + Postgres + UI
docker/initdb/                first-boot SQL (creates the `agent` DB)
docker/dynamicconfig/         Temporal dev dynamic config
packages/shared/              env schema, logger
packages/llm/                 provider-agnostic OpenAI-compatible client (AI SDK)
packages/gateway/             grammY bot → LLM → reply
sandbox/                      sbx bootstrap + network policy
docs/                         notes and runbooks
```

Later phases add `db`, `workflows`, `activities`, `tools`, `brain-worker`.

## Checks

```bash
bun run check    # tsc --noEmit + bun test
```

## Environment

All configuration is read from process env and validated by
`packages/shared/src/env.ts`. Empty values are treated as unset. `.env` is
gitignored; `.env.example` holds placeholders only. Secrets belong only in the
brain-worker/gateway host processes — never in prompts, tool results, or the
sandbox.
