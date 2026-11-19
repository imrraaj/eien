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
- [x] Works in groups when mentioned (`@botname ...`) or replied to
- [x] Sandbox coding tools (`bash`, `read`, `write`, `edit`), path-confined to `/work`
- [x] Web tools (`web_search`, `web_fetch`) via Exa's keyless hosted MCP
- [x] File exchange: receive Telegram attachments into `/work/uploads`, send results with `send_file`
- [x] Markdown replies rendered as Telegram HTML (bold, code, links, quotes, tables)
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

### Users

`ALLOWED_TELEGRAM_USER_IDS` takes a comma-separated list of **numeric** Telegram
user IDs:

```dotenv
ALLOWED_TELEGRAM_USER_IDS=111111111,222222222
```

Restart the bot after editing. Anyone not in the list is ignored. All allowed
users share the same sandbox and `/work`, but each private chat has its own
history; groups share one history per group chat.

History is **in memory only**: the last 40 messages (or ~48 K characters) per
conversation, lost on restart, cleared by `/reset`. Postgres-backed history is
the planned next step.

### Long tasks

One message may use up to `MAX_AGENT_STEPS` model steps (default and hard cap
100, each step may batch several tool calls). Single bash commands may run up to
15 minutes. At the limit the bot asks the model for a no-tools summary rather
than stopping silently; send any follow-up message to continue. Turns are still
synchronous, so a very long task keeps one "typing" indicator going until it
finishes or the process restarts.

If a turn is still running after ~10 seconds (or starts using tools after 3
seconds), the bot first posts a short `On it — …` acknowledgement quoting the
request, so slow work is visible. Fast replies skip the acknowledgement.

### Groups

Add the bot to a group and address it directly:

```
@yourbot how much is bitcoin right now?
```

It also answers when you reply to one of its messages, and for
`/status@yourbot`. Other group messages are ignored.

Group context is shared by the chat, while the user allowlist still applies.
Telegram's default privacy mode already delivers mentions/commands; to let the
bot see all group messages (for replies and context), disable privacy mode for
the bot in BotFather (`/setprivacy`).

### Tools

| Tool | Runs where | Purpose |
|---|---|---|
| `bash`, `read`, `write`, `edit` | sandbox VM | Coding work in `/work` |
| `send_file` | host + sandbox | Upload a workspace file to the chat (≤50 MB) |
| `web_search` | host | Current information via Exa MCP (keyless) |
| `web_fetch` | host | Read a URL as markdown/text |

Incoming photos, videos, audio, voice notes, and documents are downloaded into
`/work/uploads` and referenced in the prompt, so the agent can transcode or
convert them. The sandbox ships with `ffmpeg`, ImageMagick, `pandoc`, poppler,
`python3`, `git`, `curl`, and `jq`; more can be installed with `apt-get`/`pip`.
Telegram's Bot API caps downloads at 20 MB and bot uploads at 50 MB.

Web results are treated as untrusted data by the system prompt. `EXA_API_KEY` is
optional and only raises Exa limits.

## Sandbox

```bash
./sandbox/bootstrap.sh
sbx exec agent-1 -- bash -lc 'pwd'
```

Creates `agent-1`, applies the egress policy, sets git identity and
`known_hosts`, and makes `/work` writable by the sandbox user. Tools are confined
to `/work`; absolute paths elsewhere are rejected.

Egress is **open** by default while testing (`SANDBOX_ALLOW_ALL=1`). Set
`SANDBOX_ALLOW_ALL=0 ./sandbox/policy.sh` to switch back to the curated allowlist
(git, registries, runtime hosts, price APIs).

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
