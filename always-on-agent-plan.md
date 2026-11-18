# Always-On Coding Agent: Build Plan

A self-hosted, always-on personal agent you chat with on Telegram. A **main agent** talks to you and hands work to **worker agents** (child workflows) that operate on git repos inside a **Docker `sbx` sandbox**. Everything is durable on **Temporal**: crashes, restarts and multi-day waits for your approval are safe.

---

## 1. Decisions (locked)

| Area | Decision |
|---|---|
| Language | TypeScript (Node 22+), pnpm workspaces |
| Orchestration | Temporal (self-hosted via docker compose) |
| LLM | OpenRouter (OpenAI-compatible API). Models set via env, not hardcoded |
| Chat | Telegram via **grammY**: inline keyboards (yes/no, options), native polls when useful |
| Code execution | One always-on local `sbx` sandbox, one git worktree per worker |
| Git | Git access only (clone/commit/push over SSH deploy keys or HTTPS token). **No GitHub API** (no PR creation/review API yet) |
| Google | Google API via CLI, run **on the host by the brain worker**, never inside the sandbox |
| Users | Only you (Telegram user-ID allowlist). Design keyed by `userId` so friends can be added later |
| App DB | Postgres in the same compose (separate DB from Temporal's) |
| Deployments | Out of scope |
| Webhooks | None for now |
| Limits | None for now (keep a max-concurrent-workers setting, default 3) |

---

## 2. Architecture

```
┌──────────────────────────────── SERVER ────────────────────────────────┐
│                                                                        │
│  docker compose                                                        │
│   ├─ postgresql        (temporal DB + app DB "agent")                  │
│   ├─ temporal          (server)                                        │
│   ├─ temporal-ui       (http://localhost:8080)                         │
│   └─ temporal-admin-tools                                              │
│                                                                        │
│  host processes (systemd / pm2)                                        │
│   ├─ gateway           grammY bot (long polling, no inbound ports)     │
│   │                    Telegram update → Temporal client               │
│   │                    (signalWithStart / executeUpdate)               │
│   │                                                                    │
│   └─ brain-worker      Temporal worker, task queue "brain"             │
│                        workflows: mainAgent, workerAgent, reminder     │
│                        activities: llm, telegram send, db, memory,     │
│                                    sandbox (sbx exec), google cli      │
│                        holds ALL secrets (env)                         │
│                                                                        │
│  sbx sandbox "agent-1" (microVM, always on)                            │
│   /work/<repo>/                  base clone                            │
│   /work/<repo>/.trees/<workerId> git worktree per worker               │
│   git credentials (deploy keys) only, no LLM / Google keys             │
└────────────────────────────────────────────────────────────────────────┘
```

**Why the brain runs on the host and not in compose:** it shells out to the host `sbx` CLI. Containerize it later if you move tools to an in-sandbox worker (Phase 8).

### Where secrets live (and why the LLM never sees them)

- **The brain-worker process env holds** the OpenRouter key, Telegram token, Google CLI credentials and DB URL. Activities read them from `process.env`.
- **Secrets never go into prompts, tool results or the sandbox.** The model only sees tool *names, arguments and results*.
- **The gateway needs only** the Telegram token + Temporal address.
- **The sandbox holds only** git credentials (scoped deploy keys). Anything inside the sandbox is reachable by the agent's `bash`, so treat it as readable by the model.
- **Google CLI runs as a host-side activity** behind structured tools (`email_draft`, `email_send`). The agent never gets a shell where the Google credentials are.

---

## 3. Repo layout

```
agent-bot/
├─ docker-compose.yml
├─ .env.example
├─ package.json / pnpm-workspace.yaml / tsconfig.base.json
├─ packages/
│  ├─ shared/            types, ids, config (zod-validated env), logger
│  ├─ db/                postgres client, migrations (drizzle or kysely)
│  ├─ llm/               OpenRouter client, tool schema helpers, token counting
│  ├─ workflows/         mainAgent, workerAgent, reminder (deterministic code ONLY)
│  ├─ activities/        llm, telegram, db, memory, sandbox, google, git
│  ├─ tools/             tool definitions + policy (approval rules) per agent kind
│  ├─ brain-worker/      Temporal Worker bootstrap (registers workflows + activities)
│  └─ gateway/           grammY bot → Temporal client
├─ sandbox/
│  ├─ bootstrap.sh       create sandbox, network policy, base tools
│  └─ policy.sh          sbx policy allow network … rules
└─ docs/
```

---

## 4. Infrastructure (Phase 0)

### docker-compose.yml
Start from the official `temporalio/docker-compose` (Postgres variant) and add the app DB:

- `postgresql`: one instance, databases `temporal`, `temporal_visibility`, `agent`
- `temporal`: server, using Postgres
- `temporal-ui`: port 8080
- `temporal-admin-tools`
- Named volumes for Postgres data. **Back up nightly** (`pg_dump`).

Before writing the compose file, check the official repo for the current recommended images and tags.

### .env.example
```
# Temporal
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default

# App DB
DATABASE_URL=postgres://agent:agent@localhost:5432/agent

# OpenRouter
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
MODEL_MAIN=            # orchestrator model
MODEL_WORKER=          # coding model
MODEL_CHEAP=           # summaries / compaction / titles

# Telegram
TELEGRAM_BOT_TOKEN=
ALLOWED_TELEGRAM_USER_IDS=   # comma separated

# Sandbox
SBX_NAME=agent-1
MAX_CONCURRENT_WORKERS=3

# Google CLI (host-side only)
GOOGLE_CLI_BIN=
GOOGLE_CLI_CONFIG_DIR=
```

### Sandbox bootstrap
- Create the `sbx` sandbox `agent-1` (always on, local).
- Network allowlist: `github.com` (+ `*.githubusercontent.com`), and the package registries (npm, pypi, etc.). The agent installs runtimes itself, so allow the runtime download hosts too (nodejs.org, etc.). Extend as needed.
- Add SSH deploy keys (one per repo, write access) and `known_hosts`.
- Set git identity: `git config --global user.name "agent-bot"`.

**Done when:** `docker compose up -d` works, the Temporal UI loads, and `sbx exec agent-1 -- git ls-remote <repo>` works.

---

## 5. Core concepts

### IDs
- `userId`: Telegram user ID (string)
- Main workflow ID: `main-<userId>` (one per user, lives forever via continue-as-new)
- Worker workflow ID: `worker-<userId>-<shortId>`
- Question ID: `q<base36>` (short, so it fits in Telegram's 64-byte `callback_data`)

### App DB tables (Postgres)
| Table | Purpose |
|---|---|
| `conversations` | `id, userId, kind(main/worker), workflowId, status` |
| `entries` | Transcript: `conversationId, seq, role, content(jsonb), tokens, createdAt, idempotencyKey UNIQUE`, plus `tsvector` for search |
| `compactions` | `conversationId, uptoSeq, summary` |
| `blobs` | Large tool outputs (logs, diffs): `id, conversationId, content` |
| `memory` | `userId, scope(user/bot/repo), key(repo name or null), content, updatedAt`, size-capped |
| `repos` | Registry: `userId, name, remote, path, defaultBranch, install, test, notes, status` |
| `workers` | `id, userId, kind, repo, goal, branch, status, blockedOn, lastReport` |
| `questions` | `id, userId, workerId, kind(question/approval), text, options, status, answer, answeredBy, telegramMsgId, expiresAt` |
| `reminders` | `id, userId, scheduleId, text, spec` |
| `processed_updates` | Telegram `update_id` dedupe |

**Rule:** workflows hold only IDs and small state. Transcripts and big outputs live in Postgres. Every insert done by an activity carries an `idempotencyKey` (`workflowId:turn:step`), so activity retries never duplicate rows.

---

## 6. Workflows

### 6.1 `mainAgent(userId)`: the orchestrator

**Inputs (signals/updates):**
- `userMessage` signal `{text, msgId}`: from the gateway via `signalWithStart`
- `workerEvent` signal `{workerId, type: report|question|failed, payload}`
- `questionAnswered` signal `{qid, answer}` (passive: recorded, doesn't trigger a run)
- `reminderFired` signal `{reminderId, text}`

**Loop:**
```
state: inbox[], running=false, steerBuffer[]
on signal → push to inbox (user messages arriving mid-run go to steerBuffer)
loop forever:
  await condition(inbox.length > 0)
  batch = drain(inbox)                     // collect rapid messages into one turn
  runTurn(batch):
    repeat:
      res = await act.llmStep({conversationId, turn, step, steer: drain(steerBuffer)})
      if res.toolCalls empty → await act.sendTelegram(final text); break
      for each toolCall → dispatchTool(toolCall)   // policy check, activities, child wf
  if workflowInfo().continueAsNewSuggested → continueAsNew(state snapshot)
```

**Rules:**
- **Main never runs long work.** Coding, repo setup and builds go to a worker.
- Short tools are fine (memory, registry lookup, list workers, reminders, email draft).
- A user message during a run is a **steer**: it's injected into the next `llmStep` at the next tool-round boundary.

**Main's tools:**
| Tool | Notes |
|---|---|
| `spawn_worker({kind: setup\|implement\|review\|task, repo, goal})` | Starts a child workflow (`ParentClosePolicy.ABANDON`), enforces the concurrency cap (queues the rest) |
| `list_workers()` / `get_worker(id)` | From DB |
| `message_worker({id, text, mode: steer\|followup})` | Signal to the worker |
| `cancel_worker({id})` | Cancel the child workflow; withdraws its open questions |
| `answer_question({qid, answer})` | Only `kind=question`. **Rejected for approvals** |
| `ask_user({text, options?, kind})` | Main's own questions (same flow as workers) |
| `memory_write({scope, key?, op: add\|patch\|remove, text})` / `memory_search(query)` | Size-capped memory + transcript FTS |
| `repo_registry_get/list` | Read-only for main |
| `reminder_create/list/delete` | Temporal Schedules |
| `email_draft({to, subject, body})` | Host activity; returns a draft ID + preview |
| `email_send({draftId})` | **Always gated by approval (enforced in workflow code)** |

### 6.2 `workerAgent({userId, workerId, kind, repo, goal})`: does the work

**Startup:** ensure a worktree exists at `/work/<repo>/.trees/<workerId>` on branch `bot/<workerId>-<slug>`. A `setup` worker creates the base clone instead.

**Loop:** same LLM step loop as main, using `MODEL_WORKER` and worker tools.

**Signals/updates:**
- `steer` / `followup` signals from main
- `answer` **update** `{qid, answer, answeredBy}`: validates the question is pending and returns `accepted | already_answered | expired`
- Cancellation: clean up worktree processes, withdraw questions

**Finish:** call `report_to_main({summary, branch?, commits?})`. This signals main with `workerEvent`. The worker stays resumable: the workflow completes, but its conversation and worktree remain, so a later "continue worker 14" starts a new run with the same `workerId` and history.

**Worker tools:**
| Tool | Replay/idempotency notes |
|---|---|
| `bash({cmd, cwd?, timeoutSec?})` | Via `sbx exec`. Output truncated; full output saved to `blobs`. Keyed by `callId` (see §8) |
| `bash_bg({cmd})` / `bg_status({pid})` / `bg_kill` | For long builds/tests: pid + log file in the worktree; polled with a heartbeating activity |
| `read({path, range?})`, `write`, `edit({path, old, new})`, `grep`, `glob` | Paths restricted to the worker's worktree (+ read-only base clone) |
| `git_status`, `git_diff`, `git_commit({message})` | Safe |
| `git_push({branch})` | Allowed for `bot/*` branches. **The default branch needs approval** |
| `registry_update({...})` | Setup worker writes install/test commands and notes |
| `ask_user({text, options?, kind})` | See §7 |
| `note_assumption({text})` | Non-blocking: continue, and list the assumptions in the final report |
| `report_to_main({summary, ...})` | Ends the run |

**Kinds:**
- `setup`: clone, detect the stack, install the runtime (the agent installs languages itself), get the tests running, write `registry` + `AGENTS.md`.
- `implement`: branch → change → test → commit → push `bot/*` branch → report the branch name (you open the PR, since there's no GitHub API yet).
- `review`: check out the given branch/commit read-only → run tests → write the review → **send the review to you** in Telegram (no GitHub API to post it yet).
- `task`: anything else in the sandbox.

### 6.3 `reminder({userId, reminderId, text})`
Started by a **Temporal Schedule** that `reminder_create` creates (`spec` from natural language, parsed by the LLM into a cron or interval + timezone; `overlap: SKIP`). Signals main with `reminderFired`. Main sends the reminder, adding context if relevant.

---

## 7. Asking the user and approvals

### Flow
```
worker: ask_user(...)
  → act.createQuestion   (DB row status=pending, idempotent on memo'd qid)
  → signal main workerEvent{type: question, qid}
  → await condition(() => answered, expiresAt)     // durable; can wait days
main: decides
  → kind=question & answerable from memory → answer_question (direct)
  → else act.sendTelegram(question with buttons)   → status=delivered, store msgId
you: tap a button
  gateway: callback_query "a:<qid>:<optionIdx>"
    → verify from.id is allowed (approvals: must be the owner)
    → client.workflow.getHandle(workerWfId).executeUpdate("answer", {...})
    → answerCallbackQuery + edit message ("✅ Approved")
    → signal main questionAnswered (passive)
worker resumes → if waited > 1h: re-verify repo state (git fetch, status) before acting
```

### Telegram UX (grammY)
- **Yes/No and approvals:** `InlineKeyboard` with `[✅ Yes] [❌ No]` (approvals: `[Approve] [Deny]`). `callback_data = "a:<qid>:<idx>"` (64-byte max).
- **Multiple choice:** inline keyboard with up to ~8 options, plus `[Other…]`. "Other" uses `ForceReply` and routes the reply by `reply_to_message.message_id → qid`.
- **Native polls:** `sendPoll` (non-anonymous, so the gateway gets `poll_answer` updates). Map `poll_id → qid`. Use for multi-select questions; buttons cover most cases.
- **Free text in the main chat:** goes to main as a normal message; main uses `answer_question` (never for approvals).
- **After answering:** edit the original message to show the outcome and remove the buttons, so a double tap is harmless.
- **`/pending`:** lists open questions. **`/status`:** lists workers.

### Approval rules (in `tools/policy.ts`, enforced in workflow code)
| Action | Rule |
|---|---|
| `email_send` | Always approval. The preview shows to, subject and body |
| `git_push` to default branch | Approval |
| `git push --force` anywhere | Approval |
| Destructive bash (`rm -rf` outside the worktree, etc.) | Deny, or approval via a simple pattern check (expand later) |
| Everything else | Allowed |

Approvals are valid **only** if `answeredBy` is the owner's Telegram ID and the answer came through the gateway's button handler. Main can't answer approvals. Approvals are tied to a **hash of the previewed content**; if the draft or diff changed, ask again.

### Timeouts
- **Reminder:** after 24h a gentle reminder message (workflow timer).
- **Expiry:** questions get the `default` answer if one was provided; approvals expire as **denied** (default 7 days, configurable per question).
- **Late answer:** reply "q7 expired; worker #14 used X. Redo?"

---

## 8. LLM and tool execution details

### `act.llmStep`
1. Load context from the DB: system prompt + memory snapshot (user/bot/repo) + latest compaction summary + entries since the compaction + steer messages.
2. Call OpenRouter (OpenAI-compatible chat completions with `tools`). Use `pi-ai` if it supports OpenRouter well (verify), otherwise the `openai` SDK with `baseURL`.
3. Save the assistant entry (idempotency key `wf:turn:step`). If an entry with that key already exists (retry after a crash), **return the saved result instead of calling the model again**.
4. Return `{text?, toolCalls[]}` (small). Large content stays in the DB.
- Retry policy: exponential backoff, limited attempts, non-retryable on 4xx validation errors.

### `act.sandboxExec` (via `sbx exec`)
- Wrap the command:
  ```
  mkdir -p /work/.calls
  if [ -f /work/.calls/<callId>.done ]; then cat /work/.calls/<callId>.out; exit; fi
  ( <cmd> ) > /work/.calls/<callId>.out 2>&1; echo $? > /work/.calls/<callId>.done
  ```
  An activity retry returns the cached result instead of re-running, which matters for `git push`.
- Truncate output (e.g. head and tail 8 KB), save the full output to `blobs`, and return a `blobRef`.
- For long commands, use `bash_bg` + a heartbeating poll activity.

### Prompt caching
Keep the system prompt + tool list stable and append new content at the end. OpenRouter passes caching through for providers that support it.

---

## 9. Memory and compaction

- **Memory (always in the prompt, small):** `user` (~1.5k chars), `bot` (~2k), `repo:<name>` (~2k, only when working on that repo). Writes go through `memory_write`. If an edit would go over the cap, it errors, forcing the agent to consolidate.
- **History (searchable, on demand):** all entries in Postgres with FTS. `memory_search` returns the actual messages and can page around a hit.
- **Compaction:** when context passes ~50% of the model window:
  1. **Pre-flush:** one LLM step: "Save anything worth remembering via memory_write."
  2. Summarize the middle with `MODEL_CHEAP`. Keep the system prompt, the first exchange and the last ~20K tokens.
  3. Insert a `compactions` row. Entries are never deleted.
- **Main's context stays small:** workers send summaries only; main uses `get_worker(id)` to pull details.

---

## 10. Gateway (grammY)

- Long polling. `bot.use(allowlist)` drops anyone not in `ALLOWED_TELEGRAM_USER_IDS`.
- Dedupe by `update_id` (`processed_updates`).
- Text message → `signalWithStart(mainAgent, {workflowId: "main-"+userId, signal: userMessage})`.
- `callback_query` → parse `a:<qid>:<idx>` → look up the question → `executeUpdate` on the worker (or main) → `answerCallbackQuery` → edit the message.
- `poll_answer` → map `poll_id` → same path.
- Commands: `/status`, `/pending`, `/cancel <workerId>`, `/reminders`.
- Outbound sends happen in the brain's `act.sendTelegram` (not the gateway), so they are retried and durable. Convert Markdown to Telegram MarkdownV2 or HTML; split messages over 4096 characters.

---

## 11. Build phases (with "done when" tests)

### Phase 0: Infrastructure
Compose (Temporal + UI + Postgres), monorepo scaffold, env validation, sandbox bootstrap.
**Done when:** the Temporal UI is up; `sbx exec` can clone a repo.

### Phase 1: Chat that survives restarts
Gateway + `mainAgent` + `llmStep` + `sendTelegram` + transcript in Postgres. No tools yet.
**Done when:** you chat → `docker compose restart` + kill the brain-worker mid-reply → it replies once (not twice) and remembers the conversation.

### Phase 2: Workers and sandbox tools
`spawn_worker`, `workerAgent`, worktrees, bash/read/write/edit/grep/git tools, `report_to_main`, concurrency cap.
**Done when:** "clone X and set it up" → setup worker → registry entry → main reports. Two `implement` workers run in parallel on the same repo without conflicts. Kill the brain mid-`bash` → resumes without re-running a completed command.

### Phase 3: Asking the user and approvals
`ask_user`, questions table, inline keyboards, polls, ForceReply "Other", the `answer` update, approval policy, timeouts, `/pending`.
**Done when:** a worker asks → you answer **2 days later** after a full server reboot → it continues. A double tap is a no-op. Main can't answer approvals.

### Phase 4: Memory and compaction
Memory caps, `memory_write/search`, compaction with pre-flush, repo memory, `AGENTS.md` per repo.
**Done when:** after a 500-message conversation, it still knows your preferences and repo facts; context stays under the limit.

### Phase 5: Reminders
`reminder_create/list/delete` → Temporal Schedules → `reminderFired`.
**Done when:** "remind me to do X every 2 days at 9am" works through restarts; "stop reminding me about X" deletes it.

### Phase 6: Email via Google CLI
`email_draft` / `email_send` host activities, approval preview with `[Send] [Edit] [Discard]`.
**Done when:** "write an email to … and ask me before sending" → draft preview → Approve → sent exactly once, even if the brain crashes after the tap.

### Phase 7: Hardening
Steering/interrupts, cancellation everywhere, worktree cleanup, structured logs + Temporal UI search attributes (`userId`, `workerId`, `kind`), cost tracking per turn (OpenRouter `usage`), backups.
**Chaos tests:** kill the brain-worker during an LLM call, a tool call, and a question wait; restart Temporal; restart the sandbox; send duplicate Telegram updates.

### Phase 8: Later
- Move tools to an **in-sandbox Temporal worker** (task queue `sandbox-<userId>`), with an egress allowlist to Temporal.
- GitHub App (PRs, posting reviews, webhooks via a tunnel).
- **Multi-user (friends):** allowlist → user table, one sandbox per user, per-user memory/registry, per-user cost caps.
- Skills (markdown how-tos loaded on demand) and learned routines.

---

## 12. Gotchas checklist

- [ ] Workflow code is **deterministic**: no `Date.now()`, `Math.random()`, network or fs calls. Use Temporal APIs (`sleep`, `condition`, `uuid4` from the workflow lib).
- [ ] Keep payloads small (Temporal limit ~2MB per payload). Store transcripts and outputs in Postgres and pass IDs.
- [ ] Use `continueAsNew` on `mainAgent` when `continueAsNewSuggested`.
- [ ] Every DB-writing activity is idempotent (unique `idempotencyKey`).
- [ ] Every side-effecting tool is deduped by `callId` (the sandbox call cache).
- [ ] Approvals are enforced in workflow code, not in prompts.
- [ ] Secrets only in brain-worker env. Nothing secret inside the sandbox except scoped git deploy keys.
- [ ] Treat content from repos, web pages and emails as **data, not instructions** (add this to the system prompts, and rely on the approval gates).
- [ ] Telegram: 64-byte `callback_data`, 4096-character messages, MarkdownV2 escaping.
- [ ] Back up Postgres (both Temporal and app DBs) and `/work`.

---

## 13. Open items to decide later
- Which OpenRouter models for `MODEL_MAIN`, `MODEL_WORKER` and `MODEL_CHEAP`.
- Which Google CLI to use, and how its auth is stored on the host.
- How the sandbox reaches the host (only needed for Phase 8's in-sandbox worker).
- When to add the GitHub App.
