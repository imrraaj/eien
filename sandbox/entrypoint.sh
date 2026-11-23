#!/bin/sh
# A named volume mounts root-owned, so hand /work to the agent before sshd
# starts. Everything then runs as the unprivileged `agent` user.
set -eu

chown agent:agent /work 2>/dev/null || true
chmod 700 /home/agent/.ssh 2>/dev/null || true
chmod 600 /home/agent/.ssh/authorized_keys 2>/dev/null || true
mkdir -p /run/sshd

exec /usr/sbin/sshd -D -e
