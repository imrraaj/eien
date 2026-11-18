# eien — always-on coding agent

Self-hosted personal agent: Telegram chat, a main orchestrator agent, and worker
agents that operate on git repos inside an `sbx` sandbox. All orchestration runs
on Temporal, so crashes and multi-day approval waits are durable.

See [`always-on-agent-plan.md`](./always-on-agent-plan.md) for the full design.

> **Tooling note:** the plan says pnpm; this repo uses **Bun** workspaces
> (per the machine/agent conventions) — `bun install`, `bun run <script>`.

## Status — Phase 0 (infrastructure)

- [x] Git repo + Bun workspace scaffold
- [x] Docker Compose: Postgres, Temporal, Temporal UI, admin tools
- [x] Separate `agent` app database created on first boot
- [x] Zod-validated env schema + structured logger (`packages/shared`)
- [ ] Sandbox created and reachable (`sandbox/bootstrap.sh`)

## Quick start

```bash
cp .env.example .env      # fill in keys later; compose starts without them
bun install
bun run up                # docker compose up -d
bun run ps
```

| Service | URL / address |
|---|---|
| Temporal frontend | `localhost:7233` |
| Temporal UI | http://localhost:8080 |
| Postgres | `localhost:5432` (`temporal` + `agent` databases) |

Verify:

```bash
docker compose exec temporal-admin-tools temporal operator cluster health
psql postgres://agent:agent@localhost:5432/agent -c 'select current_database()'
# or:
docker compose exec postgresql psql -U agent -d agent -c 'select 1'
```

Temporal CLI shortcuts:

```bash
bun run temporal:cli -- namespace list
bun run temporal:cli -- workflow list
```

Stop / reset:

```bash
bun run down              # keep volumes
docker compose down -v    # wipe Postgres (recreates both DBs on next up)
```

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
packages/shared/              env schema, logger (more packages in later phases)
sandbox/                      sbx bootstrap + network policy
docs/                         notes and runbooks
```

Planned packages (`db`, `llm`, `workflows`, `activities`, `tools`,
`brain-worker`, `gateway`) land in later phases, one per build phase.

## Environment

All configuration is read from process env and validated by
`packages/shared/src/env.ts`. `.env` is gitignored; `.env.example` holds
placeholders only. Secrets belong only in the brain-worker/gateway host
processes — never in prompts, tool results, or the sandbox.
