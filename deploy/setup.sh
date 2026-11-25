#!/usr/bin/env bash
# Install (or refresh) the gateway as a systemd service on a VPS.
#
# Uses a long-lived Docker container for the sandbox: no KVM, SSH server, or
# inbound port. The service runs as the invoking user (override with
# EIEN_USER=<name>) and gets access to the Docker socket through the docker
# group.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
SERVICE="eien"
TARGET_USER="${EIEN_USER:-${SUDO_USER:-$(id -un)}}"
DATA_DIR="${EIEN_DATA_DIR:-/var/lib/eien}"

# Docker settings live in .env.docker; create it on a fresh checkout.
if [[ ! -f .env.docker ]]; then
  cp .env.docker.example .env.docker
fi
if [[ -f .env.docker ]]; then
  set -a
  . ./.env.docker
  set +a
fi

IMAGE="${SANDBOX_DOCKER_IMAGE:-eien/sandbox:local}"
CONTAINER="${SBX_NAME:-agent-1}"

die() {
  echo "error: $*" >&2
  exit 1
}

[[ "$(uname -s)" == "Linux" ]] || die "this deployment targets Linux."
command -v systemctl >/dev/null 2>&1 || die "systemd is required (or run 'bun run bot' directly)."

if [[ "${EUID}" -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || die "sudo is required; run as root or install sudo."
  exec sudo -E env \
    EIEN_USER="$TARGET_USER" \
    EIEN_DATA_DIR="$DATA_DIR" \
    SANDBOX_DOCKER_IMAGE="$IMAGE" \
    SBX_NAME="$CONTAINER" \
    bash "$0" "$@"
fi

id "$TARGET_USER" >/dev/null 2>&1 || die "EIEN_USER '$TARGET_USER' does not exist."
if [[ "$TARGET_USER" == "root" && "${EIEN_USER:-}" != "root" ]]; then
  die "refusing to run the gateway as root. Re-run with EIEN_USER=<your user> (or EIEN_USER=root to override)."
fi
TARGET_GROUP="$(id -gn "$TARGET_USER")"

if [[ ! -f .env ]]; then
  cp .env.example .env
  cat >&2 <<'EOF'

Created .env from .env.example. Fill in at least:

  TELEGRAM_BOT_TOKEN
  ALLOWED_TELEGRAM_USER_IDS
  LLM_BASE_URL / LLM_API_KEY / MODEL_MAIN

Then run this script again.
EOF
  exit 1
fi

echo "==> checking Docker"
if ! command -v docker >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || die "install Docker first, or use a distribution package for it."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends docker.io
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon as root."

BUN="$(command -v bun || true)"
if [[ -z "$BUN" ]]; then
  if command -v sudo >/dev/null 2>&1; then
    BUN="$(sudo -u "$TARGET_USER" bash -lc 'command -v bun' 2>/dev/null || true)"
  elif command -v runuser >/dev/null 2>&1; then
    BUN="$(runuser -u "$TARGET_USER" -- bash -lc 'command -v bun' 2>/dev/null || true)"
  fi
fi
[[ -n "$BUN" ]] || die "bun is not installed. Install it from https://bun.sh and retry."
BUN="$(readlink -f "$BUN")"

echo "==> preparing $DATA_DIR"
install -d -m 700 -o "$TARGET_USER" -g "$TARGET_GROUP" "$DATA_DIR"
install -d -m 700 -o "$TARGET_USER" -g "$TARGET_GROUP" "$DATA_DIR/state" "$DATA_DIR/home"

echo "==> building the sandbox image and container"
SANDBOX_DOCKER_IMAGE="$IMAGE" \
  SBX_NAME="$CONTAINER" \
  INSTALL_BROWSER="${INSTALL_BROWSER:-1}" \
  "$ROOT/sandbox/bootstrap.sh"

echo "==> writing runtime overrides"
cat > "$DATA_DIR/runtime.env" <<EOF
STATE_DIR=$DATA_DIR/state
HOME=$DATA_DIR/home
SANDBOX_DRIVER=docker
SANDBOX_DOCKER_IMAGE=$IMAGE
SBX_NAME=$CONTAINER
SBX_WORKDIR=/work
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EOF
chown "$TARGET_USER:$TARGET_GROUP" "$DATA_DIR/runtime.env"
chmod 600 "$DATA_DIR/runtime.env"

echo "==> writing /etc/systemd/system/$SERVICE.service"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=eien always-on coding agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_GROUP
SupplementaryGroups=docker
WorkingDirectory=$ROOT
EnvironmentFile=$ROOT/.env
EnvironmentFile=$ROOT/.env.docker
EnvironmentFile=$DATA_DIR/runtime.env
ExecStart="$BUN" "$ROOT/packages/gateway/src/index.ts"
Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=30
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE"

cat <<EOF

eien is running as $TARGET_USER.
  logs:  journalctl -u $SERVICE -f
  stop:  ./deploy/down.sh

State lives in $DATA_DIR. The sandbox container "$CONTAINER" and its /work
filesystem stay in Docker across gateway restarts. Rebuild and replace it with:

  RECREATE=1 ./sandbox/bootstrap.sh

The gateway has access to the Docker socket (root-equivalent on the host).
Keep that in mind before exposing the bot to untrusted users.
EOF
