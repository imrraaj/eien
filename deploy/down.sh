#!/usr/bin/env bash
# Stop the gateway container. Leaves the sandbox, its files, and ./data alone.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f deploy/compose.env ]]; then
  docker compose --env-file deploy/compose.env -f docker-compose.bot.yml down "$@"
else
  docker compose -f docker-compose.bot.yml down "$@"
fi
