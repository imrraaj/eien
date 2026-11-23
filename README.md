# eien: always-on coding agent

A personal coding agent you talk to over Telegram (a web app is next). The agent
loop runs on **pi-durable** with SQLite storage, so runs, schedules, and
background workers survive restarts. Tools run inside a sandbox: `bash`, `read`,
`write`, `edit`, `send_file`, `web_search`, `web_fetch`, `subagent`, `schedule`.

## Architecture

```
 Telegram ─┐                                         ┌─> Telegram
 Web (soon)┼─> InputHub ─> gateway ─> agent runtime ─> OutputRouter ┼─> Web (soon)
 ...      ─┘   (@eien/io)  commands    (@eien/agent)   (@eien/io)  └─> ...
                                         │
                                         ├─ pi-durable + SQLite (state/eien.sqlite)
                                         └─ sandbox (sbx microVM or ssh container)
```

The agent loop knows only **addresses** (`{ service, chat }`), never the
services behind them. Every service limit lives in its own service: Telegram's
message chunking, HTML rendering, 20 MB downloads, 50 MB uploads, and typing
indicators are all in `@eien/telegram`.

- **Input services** implement `InputService` (`start(sink)`, `stop()`) and emit
  `message` or `command` events. Attachments arrive as host temp files; the
  runtime copies them into `/work/uploads`.
- **Output services** implement `OutputService` (`send(chat, message)`) and
  receive `text`, `file`, and `status` (`working`, `queued`, `idle`) messages.
  A limit they cannot meet (a file too large, say) comes back as a typed
  `DeliveryFailed`, never a throw.
  Each renders them its own way or ignores them. A service can also contribute
  a `promptHint`, which is added to the system prompt for its chats.
- The `OutputRouter` strips em dashes from everything the bot sends, whatever
  the service.

Adding a service means implementing one or both interfaces and registering it in
`packages/gateway/src/index.ts`:

```ts
outputs.add(web); // before the runtime opens, so its prompt hint applies
await inputs.add(web);
```

## Quick start

```bash
cp .env.example .env      # fill in LLM + Telegram values
bun install
./sandbox/bootstrap.sh    # create the agent-1 sbx sandbox
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

Any OpenAI-compatible endpoint works. OpenRouter attribution headers are only
added for openrouter.ai. The bot uses long polling, so no inbound ports are
needed.

## Environment

Validated by `packages/shared/src/env.ts`; empty values count as unset. `.env`
is gitignored and `.env.example` holds placeholders only. Secrets stay in the
gateway process, never in prompts, tool results, or the sandbox.

| Variable                     | Default               | Purpose                                            |
| ---------------------------- | --------------------- | -------------------------------------------------- |
| `STATE_DIR`                  | `state`               | holds `eien.sqlite`                                |
| `MAX_AGENT_STEPS`            | `100`                 | model turns per run (hard cap 100)                 |
| `SOUL_PATH`                  | bundled `SOUL.md`     | persona file                                       |
| `SYSTEM_PROMPT`              | unset                 | replaces persona and operating manual entirely     |
| `SANDBOX_DRIVER`             | `sbx`                 | `sbx` (host Docker Sandboxes) or `ssh` (container) |
| `SBX_NAME`, `SBX_WORKDIR`    | `agent-1`, `/work`    | sandbox name and workspace                         |
| `EXA_MCP_URL`, `EXA_API_KEY` | Exa hosted MCP, unset | web tools; the key only raises limits              |
| `LOG_LEVEL`                  | `info`                | `debug`, `info`, `warn`, `error`                   |

## Using it

Commands: `/reset`, `/schedules`, `/unschedule <name>`, `/model`, `/status`,
`/help`. Telegram also has `/id`, which shows chat and user IDs.

**Users.** `ALLOWED_TELEGRAM_USER_IDS` takes numeric Telegram user IDs; anyone
else is ignored. All users share one sandbox and `/work`. Each private chat has
its own conversation, and a group shares one.

**Groups.** The bot answers when mentioned (`@yourbot ...`), when replied to,
and for commands. Telegram's privacy mode already delivers those; disable it in
BotFather (`/setprivacy`) if the bot should see every group message.

**Steering.** A message sent while a run is working steers it: the bot says it
will fold it in, and pi-durable places the message after the current tool round.
A single long tool call still has to finish first.

**Long runs.** Short runs only show typing. A run still going after a minute
gets a "still on it" message. Single bash commands may run up to 15 minutes.

**Durability.** Conversations, the chat map, and a per-chat delivery marker live
in `state/eien.sqlite`. A run interrupted by a restart resumes from its last
committed step, and answers are delivered exactly where the last process left
off: none dropped, none repeated.

**Files.** Photos, videos, audio, voice notes, and documents are saved to
`/work/uploads` and referenced in the prompt. `send_file` sends a workspace file
back. The sandbox has `ffmpeg`, ImageMagick, `pandoc`, poppler, `python3`, `git`,
`curl`, and `jq`; more installs with `apt-get` or `pip`.

## Persona

`packages/agent/SOUL.md` defines who the bot is: voice, length, how it handles
disagreement and uncertainty. It is kept apart from the operating manual (tools,
sandbox, scheduling) in `packages/agent/src/prompt.ts`, so the voice can change
without touching the mechanics. Point `SOUL_PATH` at your own file to replace it.

The system prompt is built as: persona, operating manual, then the service's
prompt hint.

## Tools

| Tool                            | Runs where      | Purpose                                       |
| ------------------------------- | --------------- | --------------------------------------------- |
| `bash`, `read`, `write`, `edit` | sandbox         | coding work in `/work` (paths confined there) |
| `send_file`                     | sandbox to chat | send a workspace file to the current chat     |
| `web_search`, `web_fetch`       | host            | current information via Exa's hosted MCP      |
| `subagent`                      | host            | persistent background workers                 |
| `schedule`                      | host            | durable one-shot or repeating timers          |

Web and repo content is treated as untrusted data by the prompt.

### Browser

The sandbox has Vercel's [agent-browser](https://github.com/vercel-labs/agent-browser)
CLI with a headless Chrome, and the agent drives it through `bash`: `open` a URL,
`snapshot -i` to get interactive elements as `@e1`-style refs, then `click`,
`fill`, `press`, `get text`, or `screenshot`. It covers what `web_fetch` cannot:
JavaScript-heavy pages, multi-step flows, and forms. Screenshots reach the chat
through `send_file`.

It is a CLI rather than a tool on purpose: its text snapshots are already built
for agents, and the CLI ships its own version-matched guide
(`agent-browser skills get core`). The prompt tells the agent never to enter
secrets it was not given and to ask before anything irreversible, such as
purchases, payments, or sending messages.

### Subagents

| Action                  | Effect                                                                    |
| ----------------------- | ------------------------------------------------------------------------- |
| `spawn` (name, message) | creates a child conversation and returns at once                          |
| `send` (name, message)  | steers a worker, or with `followUp: true` queues after its current answer |
| `stop` (name)           | aborts the worker's current run                                           |
| `status` (name?)        | working or idle                                                           |

A durable reporter posts each worker answer back to the main conversation, and
the main agent relays it. Workers survive restarts, have their own step budget,
and cannot spawn workers of their own.

### Schedules

`schedule({ name, prompt, delay: "2m" })` stores a task that sleeps, then submits
`prompt` back into the chat. `every: "15m"` repeats it; repeats missed while the
process was down are skipped, not replayed. Delays are single-unit (`30s`, `2m`,
`1h`, `2d`), at most 30 days; repeats are at least 10 seconds apart.

`/schedules` lists them and `/unschedule <name>` cancels one without a model
turn. Cancelling deletes the schedule's entry; its sleeping task ends itself
when it wakes, and a new schedule may reuse the name straight away.

## Sandbox

```bash
./sandbox/bootstrap.sh
sbx exec agent-1 -- bash -lc 'pwd'
```

Creates `agent-1`, applies the egress policy, makes `/work` writable, and
installs the media tools plus agent-browser with Chrome (about 200 MB).
Egress is open by default while testing (`SANDBOX_ALLOW_ALL=1`); run
`SANDBOX_ALLOW_ALL=0 ./sandbox/policy.sh` for the curated allowlist.

## Docker demo

`docker-compose.bot.yml` runs the gateway plus a plain sandbox container reached
over SSH (`SANDBOX_DRIVER=ssh`). It is a demonstration setup: the container has
weaker isolation than an `sbx` microVM and open egress.

```bash
./deploy/setup.sh       # generates SSH keys, builds, starts
./deploy/down.sh        # stops; ./state and the sandbox volume are kept
```

Neither container gets the Docker socket. For a model server on the host, use
`LLM_BASE_URL=http://host.docker.internal:9931/v1`.

## Layout

```
packages/io/          input/output contracts, InputHub, OutputRouter
packages/agent/       durable runtime, tools, schedules, subagents, SQLite adapter, SOUL.md
packages/telegram/    Telegram input + output service
packages/gateway/     composition root and commands
packages/llm/         pi-ai model registry for an OpenAI-compatible endpoint
packages/sandbox/     sbx and ssh backends, file helpers, path confinement
packages/shared/      env schema, logger, formatting
tests/                tests, one folder per package
sandbox/              sbx bootstrap, egress policy, demo container image
deploy/               Docker demo setup and teardown
```

## Errors and validation

- **Expected failures are values.** Anything a caller can act on returns a
  `better-result` `Result` with a `TaggedError`: sandbox paths and commands
  (`InvalidPath`, `CommandFailed`, `EditFailed`), the web client (`InvalidWebInput`,
  `WebFailed`), delivery (`DeliveryFailed`), schedules (`ScheduleRejected`),
  attachment downloads (`DownloadFailed`).
- **Tools reach the model through one adapter,** `fromResult` in
  `packages/agent/src/tool-result.ts`: `Ok` becomes the tool output, `Err` a tool
  error carrying its message.
- **Bugs and bad config still throw:** a missing token, a relative workspace root,
  a duplicate service name, a missing binary. pi-durable task phases also throw by
  contract.
- **Untrusted data is parsed, not cast:** Zod for env and Exa responses, pi-schema
  for tool arguments (pi-durable builds the model's tool schemas from it).

## Checks

```bash
bun run check    # tsc --noEmit + bun test
```

The suite includes pi-durable's storage conformance tests for the SQLite adapter
and an end-to-end runtime test against a fake model server, covering restarts
and duplicate requests.
