#!/usr/bin/env bash
# One-time host setup and deploy: gateway container + sandbox container.
#
# The gateway reaches the sandbox over SSH on a private compose network. No
# Docker socket and no host paths are mounted into either service.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
KEY_DIR="$ROOT/deploy/keys"

die() {
  echo "error: $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || die "docker is not installed."
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon as $(id -un); is the user in the docker group?"
command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen is missing (install openssh-client)."

if [[ ! -f .env ]]; then
  cp .env.example .env
  cat >&2 <<'EOF'

Created .env from .env.example. Fill in at least:

  TELEGRAM_BOT_TOKEN
  ALLOWED_TELEGRAM_USER_IDS
  LLM_BASE_URL / LLM_API_KEY / MODEL_MAIN

If the model server runs on this host, use
  LLM_BASE_URL=http://host.docker.internal:9931/v1
because 127.0.0.1 inside the container is the container itself.

Then run this script again.
EOF
  exit 1
fi

echo "==> preparing state directory"
mkdir -p state
[[ -w state ]] || die "$ROOT/state is not writable by $(id -un)."

echo "==> preparing SSH keys in deploy/keys"
umask 077
install -d -m 700 "$KEY_DIR"

if [[ ! -f "$KEY_DIR/id_ed25519" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C eien-sandbox -f "$KEY_DIR/id_ed25519"
fi
if [[ ! -f "$KEY_DIR/ssh_host_ed25519_key" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C eien-sandbox-host -f "$KEY_DIR/ssh_host_ed25519_key"
fi

chmod 600 "$KEY_DIR/id_ed25519" "$KEY_DIR/ssh_host_ed25519_key"
chmod 644 "$KEY_DIR/id_ed25519.pub" "$KEY_DIR/ssh_host_ed25519_key.pub"

# Pin the host key the container will serve, under the compose service name.
host_key="$(ssh-keygen -y -f "$KEY_DIR/ssh_host_ed25519_key" | awk '{print $1" "$2}')"
printf 'sandbox %s\n' "$host_key" > "$KEY_DIR/known_hosts"
chmod 644 "$KEY_DIR/known_hosts"

echo "==> writing deploy/compose.env"
cat > deploy/compose.env <<EOF
HOST_UID=$(id -u)
HOST_GID=$(id -g)
EOF

echo "==> building and starting the stack"
docker compose --env-file deploy/compose.env -f docker-compose.bot.yml up -d --build
docker compose --env-file deploy/compose.env -f docker-compose.bot.yml ps

cat <<EOF

Gateway is up. Follow logs with:
  docker compose --env-file deploy/compose.env -f docker-compose.bot.yml logs -f --tail=50

Stop it with:
  ./deploy/down.sh

State lives in $ROOT/state; the sandbox workspace is the sandbox-work volume.
Keys live in $KEY_DIR and are gitignored: back them up if you want to keep the
same sandbox host key across redeploys.
EOF
