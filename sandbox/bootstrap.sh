#!/usr/bin/env bash
# Build the small Linux image the agent runs in, then make sure its container
# exists. No KVM and no SSH server: the gateway creates a persistent container
# and runs `docker exec ... bash -lc` for each tool call.
#
# Usage:
#   ./sandbox/bootstrap.sh
#   INSTALL_BROWSER=0 ./sandbox/bootstrap.sh   # skip Chrome (~1 GB)
#   RECREATE=1 ./sandbox/bootstrap.sh          # rebuild and replace the container
set -euo pipefail

cd "$(dirname "$0")/.."

# Backend settings live in .env.docker so the shell and the bot agree.
if [[ -f .env.docker ]]; then
  set -a
  . ./.env.docker
  set +a
fi

IMAGE="${SANDBOX_DOCKER_IMAGE:-eien/sandbox:local}"
CONTAINER="${SBX_NAME:-agent-1}"
INSTALL_BROWSER="${INSTALL_BROWSER:-1}"

command -v docker >/dev/null 2>&1 || {
  echo "error: docker is not installed." >&2
  exit 1
}
if ! docker info >/dev/null 2>&1; then
  echo "error: cannot talk to the Docker daemon as $(id -un)." >&2
  echo "       Is Docker running? Is this user in the docker group?" >&2
  exit 1
fi

echo "==> building $IMAGE"
docker build --build-arg "INSTALL_BROWSER=$INSTALL_BROWSER" -t "$IMAGE" ./sandbox

if [[ "${RECREATE:-0}" == "1" ]]; then
  echo "==> replacing container $CONTAINER"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
fi

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "==> reusing container $CONTAINER"
else
  echo "==> creating container $CONTAINER"
  docker run -d \
    --name "$CONTAINER" \
    --init \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --shm-size 1g \
    --network "${SANDBOX_DOCKER_NETWORK:-bridge}" \
    -w /work \
    "$IMAGE" \
    sleep infinity >/dev/null
fi

echo "==> checking the sandbox"
docker exec "$CONTAINER" bash -lc 'id; pwd; command -v agent-browser || true'

cat <<EOF

Sandbox ready.
Add these to .env.docker (or let deploy/setup.sh write them for you):

  SANDBOX_DRIVER=docker
  SANDBOX_DOCKER_IMAGE=$IMAGE
  SANDBOX_DOCKER_NETWORK=${SANDBOX_DOCKER_NETWORK:-bridge}
  SBX_NAME=$CONTAINER
  SBX_WORKDIR=/work

Then start the gateway with: bun run bot:docker

The container is named "$CONTAINER"; it survives gateway restarts. Rebuild
with RECREATE=1 to replace its filesystem. Use SANDBOX_DOCKER_NETWORK=none
for a sandbox with no network.
EOF
