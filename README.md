# eien — always-on coding agent

A personal coding agent reachable over Telegram. It uses **pi-durable** for the
durable turn/tool loop and grammY for Telegram. Tools run inside the `sbx`
sandbox VM: `bash`, `read`, `write`, `edit`, `web_search`, `web_fetch`,
`send_file`, `spawn_agent`.

See [`always-on-agent-plan.md`](./always-on-agent-plan.md) for the full design.
Temporal orchestration is intentionally deferred.

## Status

- [x] Docker Compose: Postgres, Temporal, Temporal UI, admin tools
- [x] Sandbox `agent-1` with scoped egress, git identity, `/work`
- [x] pi-ai client for any OpenAI-compatible endpoint
- [x] Telegram bot with allowlist, `/reset`, `/stop`, `/model`, `/status`
- [x] Works in groups when mentioned (`@botname ...`) or replied to
- [x] Sandbox coding tools (`bash`, `read`, `write`, `edit`), path-confined to `/work`
- [x] Web tools (`web_search`, `web_fetch`) via Exa's keyless hosted MCP
- [x] File exchange: receive Telegram attachments into `/work/uploads`, send results with `send_file`
- [x] Markdown replies rendered as Telegram HTML (bold, code, links, quotes, tables)
- [x] `subagent` workers are owned background conversations that report back
- [x] Durable conversations and runs in JSONL storage (`state/harness`)
- [x] Native steering: messages sent mid-run land after the current tool round
- [ ] Schedules and cron jobs (next)
- [ ] Postgres storage backend

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

Commands: `/reset`, `/stop`, `/model`, `/status`, `/help`. The bot uses long
polling, so no inbound ports are needed.

`/stop` aborts the running turn and kills processes started under `/work`.
Completed files are left in place.

### Users

`ALLOWED_TELEGRAM_USER_IDS` takes a comma-separated list of **numeric** Telegram
user IDs:

```dotenv
ALLOWED_TELEGRAM_USER_IDS=111111111,222222222
```

Restart the bot after editing. Anyone not in the list is ignored. All allowed
users share the same sandbox and `/work`, but each private chat has its own
history; groups share one history per group chat.

History is **durable**: each chat maps to a conversation in `state/harness`
(JSONL), so it survives restarts. `/reset` starts a fresh context. `state/` is
local runtime data and is not committed.

### Long tasks

One run may use up to `MAX_AGENT_STEPS` model turns (default and hard cap 100).
Single bash commands may run up to 15 minutes. A run interrupted by a restart
resumes from its last committed step.

If a run is still going after a minute, the bot posts a short
`Still working on it …` message. Faster replies skip it; short turns just show
the typing indicator.

Messages sent while a run is running are **steers**: the bot replies "Queued"
immediately and pi-durable places the message after the current tool round, then
the agent continues with your correction. The Telegram handler never waits for
the turn, so new messages and `/stop` are read while the agent works. A long
single tool call still has to finish before the steer is read.

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
| `subagent` | host + sandbox | Spawn/steer/stop persistent background workers |
| `schedule` | host | Durable one-shot or repeating timers in this chat |

### Subagents

The `subagent` tool manages **persistent background workers**; it never blocks
the current turn.

| Action | Effect |
|---|---|
| `spawn` (name, message) | creates a child conversation + background reporter, returns at once |
| `send` (name, message) | steers a working worker, or `followUp: true` for after its current answer |
| `stop` (name) | aborts that worker's current run |
| `status` (name?) | working / idle |

When a worker finishes, a durable reporter posts its answer back into the main
conversation as a follow-up message; the main agent then replies to the user.
Workers survive restarts and are separate from the parent's step budget. Give
parallel workers separate directories.

### Schedules

`schedule` is a durable timer owned by the chat — no worker, no second
conversation. `schedule({ name, prompt, delay: "2m" })` stores a task that
sleeps, then submits `prompt` back into the conversation, where the agent
answers it normally. Add `every: "15m"` to repeat; missed repeats are skipped,
not replayed.

| Call | Effect |
|---|---|
| `schedule({ name, prompt, delay, every? })` | create (names are unique per chat) |
| `schedule({ action: "list" })` | same list as `/schedules` |
| `schedule({ action: "cancel", name })` | stop and delete it |

Ad-hoc cancellation needs no model: `/schedules` lists `name — in 12m, every 15m
— preview`, and `/unschedule joke` removes it. Cancelling deletes the doc entry
and aborts the task; if a fire races the cancel, the task sees the entry gone
and exits. Delays are single-unit (`30s`, `2m`, `1h`, `2d`), max 30 days, and a
repeat cannot be shorter than 10 seconds.


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
packages/gateway/             grammY bot, pi-durable runtime (harness.ts), prompt
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
