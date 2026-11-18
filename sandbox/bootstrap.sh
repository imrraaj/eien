#!/usr/bin/env bash
# Create (or reuse) the always-on sandbox used by worker agents.
#
# The sandbox has no host workspace bind mount: repos live under /work inside
# the sandbox, one git worktree per worker. Credentials in here are limited to
# scoped git deploy keys — never LLM or Google credentials.
set -euo pipefail

cd "$(dirname "$0")"
SBX_NAME="${SBX_NAME:-agent-1}"

if sbx inspect "$SBX_NAME" >/dev/null 2>&1; then
  echo "sandbox '$SBX_NAME' already exists"
else
  echo "creating sandbox '$SBX_NAME'"
  sbx create --name "$SBX_NAME" shell
fi

./policy.sh

echo "configuring sandbox '$SBX_NAME'"
sbx exec "$SBX_NAME" bash -lc '
  set -euo pipefail
  mkdir -p /work
  git config --global user.name "agent-bot"
  git config --global user.email "agent-bot@localhost"
  git config --global init.defaultBranch main
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null || true
  chmod 600 ~/.ssh/known_hosts 2>/dev/null || true
  git --version
'

cat <<EOF

Sandbox ready: $SBX_NAME
Next steps (manual, once per repo):
  1. Add a scoped deploy key inside the sandbox:
       sbx exec $SBX_NAME -- bash -lc 'ssh-keygen -t ed25519 -C agent-bot -f ~/.ssh/id_<repo> -N ""'
       sbx exec $SBX_NAME -- cat ~/.ssh/id_<repo>.pub
     then register the public key as a deploy key with write access on the repo.
  2. Add a Host alias in ~/.ssh/config inside the sandbox so each repo uses
     its own key.
  3. Verify: sbx exec $SBX_NAME -- git ls-remote git@github.com:<owner>/<repo>.git
EOF
