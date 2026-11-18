#!/usr/bin/env bash
# Sandbox network allowlist. Rules are scoped to one sandbox, so the sandbox
# cannot widen another sandbox's egress (and vice versa).
#
# Git + package registries + runtime download hosts only. No LLM keys, no
# Google credentials, no Temporal access from inside the sandbox.
set -euo pipefail

SBX_NAME="${SBX_NAME:-agent-1}"

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
)

for host in "${HOSTS[@]}"; do
  echo "allow $host"
  sbx policy allow network --sandbox "$SBX_NAME" "$host"
done
