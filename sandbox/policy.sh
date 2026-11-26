#!/usr/bin/env bash
# Sandbox network allowlist. Rules are scoped to one sandbox, so the sandbox
# cannot widen another sandbox's egress (and vice versa).
#
# Git + package registries + runtime download hosts only. No LLM keys or
# credentials inside the sandbox.
set -euo pipefail

SBX_NAME="${SBX_NAME:-agent-1}"

# Testing mode: allow all egress. Set SANDBOX_ALLOW_ALL=0 to use the allowlist below.
if [[ "${SANDBOX_ALLOW_ALL:-1}" == "1" ]]; then
  echo "allowing all sandbox egress (testing mode)"
  if sbx policy allow network --sandbox "$SBX_NAME" "**" >/dev/null 2>&1; then
    echo "allow **"
  else
    echo "skip ** (already allowed or failed)"
  fi
  exit 0
fi

HOSTS=(
  # Git over SSH/HTTPS
  github.com
  ssh.github.com
  "*.githubusercontent.com"
  # Node / Bun
  nodejs.org
  registry.npmjs.org
  npmjs.org
  bun.sh
  # Python
  pypi.org
  files.pythonhosted.org
  python.org
  # Common Linux packages (apt)
  deb.debian.org
  security.debian.org
  archive.ubuntu.com
  security.ubuntu.com
  # Go / Rust toolchains, used by many repos
  proxy.golang.org
  sum.golang.org
  static.rust-lang.org
  crates.io
  index.crates.io
  # Market / crypto price APIs (read-only endpoints)
  api.coingecko.com
  api.binance.com
  api.kraken.com
  api.coinbase.com
  api.coinpaprika.com
  api.cryptocompare.com
  api.bybit.com
  www.okx.com
  query1.finance.yahoo.com
)

for host in "${HOSTS[@]}"; do
  if sbx policy allow network --sandbox "$SBX_NAME" "$host" >/dev/null 2>&1; then
    echo "allow $host"
  else
    echo "skip $host (already allowed or failed)"
  fi
done
