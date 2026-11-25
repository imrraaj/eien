# eien: always-on coding agent

A personal coding agent you talk to over Telegram (a web app is next). The agent
loop runs on **pi-durable** with SQLite storage, so runs, schedules, and
background workers survive restarts. Tools run inside a small **Docker**
sandbox: one long-lived Linux container, with each command executed through
`docker exec`. No KVM or SSH server is required: `bash`, `read`, `write`,
`edit`, `send_file`, `web_search`, `web_fetch`, `subagent`, `schedule`, and the
control-plane memory tools.

## Architecture

```
 Telegram ─┐                                         ┌─> Telegram
 Web (soon)┼─> InputHub ─> gateway ─> agent runtime ─> OutputRouter ┼─> Web (soon)
 ...      ─┘   (@eien/io)  commands    (@eien/agent)   (@eien/io)  └─> ...
                                         │
                                         ├─ pi-durable + SQLite (state/eien.sqlite)
                                         └─ sandbox (Docker container, or sbx microVM)
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
cp .env.example .env                 # shared: LLM + Telegram
cp .env.docker.example .env.docker   # or .env.sbx.example
bun install
./sandbox/bootstrap.sh               # build the image and create the container
bun run bot:docker
```

`bun run bot:docker` loads `.env` then `.env.docker`; `bun run bot:sbx` loads
`.env` then `.env.sbx`. `bot:docker:dev` and `bot:sbx:dev` are the watch
variants. `bun run bot` loads only `.env`.

`bootstrap.sh` reads `.env.docker`; `bootstrap-sbx.sh` reads `.env.sbx`. The
Docker bootstrap needs a running daemon and a user that can talk to it (the
`docker` group). Add `INSTALL_BROWSER=0` to skip Chrome (about 1 GB). For a VPS,
`./deploy/setup.sh` does this and installs a systemd service.

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

To use several providers (and switch with `/setmodel`), create
`state/models.json` next to `eien.sqlite`; `models.example.json` shows the
format. Each provider needs `baseUrl` and either `apiKey` or `apiKeyEnv` (an env
var name). The selected model is `provider/model-id` and persists in
`state/model.json`. Without `models.json` the single `LLM_*` endpoint above is
used.

## Models

`/models` renders every catalog model as a one-tap Telegram button, with `*` on
the active one. Tapping a button switches immediately for all chats and
remembers the choice across restarts (a new message confirms it).
`/setmodel <ref>` does the same from text. A bare model id works when it is
unambiguous; otherwise use `provider/model-id`. Edit `state/models.json` and
restart to add providers, models, or keys.

## Environment

Validated by `packages/shared/src/env.ts`; empty values count as unset. Secrets
stay in the gateway process, never in prompts, tool results, or the sandbox.

Three files, all gitignored:

- `.env` is shared: LLM, Telegram, `STATE_DIR`, logging.
- `.env.docker` is loaded after `.env` by `bun run bot:docker`, `sandbox/bootstrap.sh`, and the systemd deploy.
- `.env.sbx` is loaded after `.env` by `bun run bot:sbx` and `sandbox/bootstrap-sbx.sh`.

Tracked examples are `.env.example`, `.env.docker.example`, and
`.env.sbx.example`. Shell environment variables win over all three files.

| Variable                     | Default                | Purpose                                              |
| ---------------------------- | ---------------------- | ---------------------------------------------------- |
| `STATE_DIR`                  | `state`                | holds `eien.sqlite`                                  |
| `MEMORY_PATH`                | `$STATE_DIR/memory.md` | control-plane memory file                            |
| `MEMORY_MAX_BYTES`           | `65536`                | memory file cap                                      |
| `MAX_AGENT_STEPS`            | `100`                  | model turns per run (hard cap 100)                   |
| `SOUL_PATH`                  | bundled `SOUL.md`      | persona file                                         |
| `SYSTEM_PROMPT`              | unset                  | replaces persona and operating manual entirely       |
| `SANDBOX_DRIVER`             | `docker`               | `docker` (no KVM) or `sbx` (Docker Sandboxes on KVM) |
| `SANDBOX_DOCKER_IMAGE`       | `eien/sandbox:local`   | image built by `sandbox/bootstrap.sh`                |
| `SANDBOX_DOCKER_NETWORK`     | `bridge`               | `bridge` or `none` for the sandbox network           |
| `SBX_NAME`, `SBX_WORKDIR`    | `agent-1`, `/work`     | container name and workspace                         |
| `EXA_MCP_URL`, `EXA_API_KEY` | Exa hosted MCP, unset  | web tools; the key only raises limits                |
| `LOG_LEVEL`                  | `info`                 | `debug`, `info`, `warn`, `error`                     |

## Using it

Commands: `/reset`, `/schedules`, `/unschedule <name>`, `/model`, `/models`,
`/setmodel <ref>`, `/status`, `/help`. Telegram also has `/id`, which shows chat
and user IDs.

**Users.** This is a single-user deployment: one bot token, one allowlist, one
sandbox and one `/work`. Set `ALLOWED_TELEGRAM_USER_IDS` to just your numeric
Telegram user ID; anyone else is ignored. Each private chat has its own
conversation, and a group shares one.

**Groups.** The bot answers when named (`eien` or `eienbot` anywhere in the
message), mentioned (`@yourbot ...`), replied to, and for commands. Names are
matched as whole words, case-insensitively, and only the addressing occurrence
is stripped. Telegram's privacy mode already delivers mentions and replies;
disable it in BotFather (`/setprivacy`) if the bot should see every group
message.

**Feedback.** As soon as a message is accepted the bot replies with a
"Thinking…" placeholder and edits that same message with the answer when the
run finishes, so long runs don't look stalled.

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
back. The image has `ffmpeg`, ImageMagick, `pandoc`, poppler, `python3`, `git`,
`curl`, `jq`, and `ripgrep`. Install Python packages with `pip install --user`
and Node CLIs with `npm install -g` (it writes to `~/.npm-global`); the sandbox
runs as an unprivileged user, so `apt-get` is not available.

## Persona

`packages/agent/SOUL.md` defines who the bot is: voice, length, how it handles
disagreement and uncertainty. It is kept apart from the operating manual (tools,
sandbox, scheduling) in `packages/agent/src/prompt.ts`, so the voice can change
without touching the mechanics. Point `SOUL_PATH` at your own file to replace it.

The system prompt is built as: persona, operating manual, then the service's
prompt hint.

## Tools

| Tool                                            | Runs where      | Purpose                                       |
| ----------------------------------------------- | --------------- | --------------------------------------------- |
| `bash`, `read`, `write`, `edit`                 | sandbox         | coding work in `/work` (paths confined there) |
| `send_file`                                     | sandbox to chat | send a workspace file to the current chat     |
| `web_search`, `web_fetch`                       | host            | current information via Exa's hosted MCP      |
| `subagent`                                      | host            | persistent background workers                 |
| `schedule`                                      | host            | durable one-shot or repeating timers          |
| `memory_read`, `memory_write`, `memory_replace` | control plane   | persistent memory file, outside the sandbox   |

Web and repo content is treated as untrusted data by the prompt.

### Memory

Persistent memory is a single file on the control plane, outside the sandbox.
The model reaches it only through three tools:

- `memory_read` returns the file.
- `memory_write` appends by default, or rewrites the whole file with `mode: "replace"`.
- `memory_replace` updates exactly one matching block, without rewriting everything.

The file defaults to `$STATE_DIR/memory.md` (`MEMORY_PATH` overrides it) and is
capped at `MEMORY_MAX_BYTES` (64 KiB by default). Reads and writes are
serialized, so concurrent chats and subagents cannot lose updates. The prompt
tells the model to store durable preferences, project rules, and recurring
instructions, and never to store secrets or instructions copied from untrusted
content. The sandbox cannot see the file.

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

The default backend is **Docker**. `sandbox/Dockerfile` builds a small Debian
image with the toolchain, Node 22, and optionally agent-browser with Chrome. The
gateway starts one long-lived container (`SBX_NAME`, default `agent-1`) and runs
each command as `docker exec -w /work <container> bash -lc ...`.

The container is the persistent part. Files live in its writable layer and
background processes, including agent-browser's Chrome and dev servers, keep
running between tool calls. The container runs as the unprivileged `agent`
user, with all capabilities dropped, `no-new-privileges`, and a 1 GB
`/dev/shm`.

```bash
./sandbox/bootstrap.sh                    # reads .env.docker, builds, creates
INSTALL_BROWSER=0 ./sandbox/bootstrap.sh  # smaller image, no Chrome
RECREATE=1 ./sandbox/bootstrap.sh         # replace container (destroys /work)
bun run bot:docker                        # loads .env + .env.docker
```

Network access is Docker's bridge by default (`SANDBOX_DOCKER_NETWORK=bridge`);
set it to `none` to isolate the sandbox. There is no per-host allowlist like
`sbx policy`; use a firewall or the `sbx` backend if you need that. `/work` is
inside the container, not a host mount: stopping or restarting the gateway
keeps it, but `RECREATE=1` or `docker rm` loses it.

Docker shares the host kernel. It is a good fit for a single-user personal
agent; do not expose it to hostile users. The gateway needs the Docker socket,
which is root-equivalent on the host.

On a host with KVM, the Docker Sandboxes backend is still available:

```bash
./sandbox/bootstrap-sbx.sh   # reads .env.sbx
SANDBOX_ALLOW_ALL=0 ./sandbox/policy.sh
bun run bot:sbx              # loads .env + .env.sbx
```

## VPS deployment

`deploy/setup.sh` installs Docker if needed, builds the image and container,
writes `/etc/systemd/system/eien.service`, and starts the gateway as the
invoking user. The unit loads `.env`, then `.env.docker`, then
`/var/lib/eien/runtime.env`. It gets Docker socket access through
`SupplementaryGroups=docker`. It needs Debian/Ubuntu-style `apt`, `systemd`,
Docker, and `bun`. No inbound ports are opened: Telegram uses long polling.

```bash
sudo ./deploy/setup.sh
./deploy/down.sh        # stops the gateway; the sandbox container is kept
journalctl -u eien -f
```

For a model server on the same VPS, `LLM_BASE_URL=http://127.0.0.1:9931/v1`
works because the gateway runs on the host.

## Layout

```
packages/io/          input/output contracts, InputHub, OutputRouter
packages/agent/       durable runtime, tools, schedules, subagents, SQLite adapter, SOUL.md
packages/telegram/    Telegram input + output service
packages/gateway/     composition root and commands
packages/llm/         pi-ai model registry for an OpenAI-compatible endpoint
packages/sandbox/     docker and sbx backends, file helpers, path confinement
packages/shared/      env schema, logger, formatting
tests/                tests, one folder per package
sandbox/              Docker sandbox image, sbx bootstrap and egress policy
deploy/               systemd setup and teardown
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
