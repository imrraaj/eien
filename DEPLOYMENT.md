# Deploying to contabo

The bot runs on the server behind the SSH alias `contabo` (root login). Docker
there is the **snap** package, which `deploy/setup.sh` does not support. Do not
run that script on this server; use the steps below.

## What runs where

| Item              | Location                                                    |
| ----------------- | ----------------------------------------------------------- |
| Code              | `/opt/eien` (owner `eien`)                                  |
| Secrets           | `/opt/eien/.env` (mode 600), `/opt/eien/.env.docker`        |
| Server overrides  | `/var/lib/eien/runtime.env` (loaded last, wins)             |
| State             | `/var/lib/eien/state` (SQLite, memory, models)              |
| Service           | `/etc/systemd/system/eien.service`, user `eien`, 1 GB cap   |
| Docker client     | `/opt/eien-bin/docker` (static; not the snap CLI)           |
| Docker socket fix | `/usr/local/sbin/eien-docker-access`, run before each start |
| Sandbox           | container `agent-1`, image `eien/sandbox:nosuid`, 3 GB cap  |

Telegram uses long polling. The web app listens on `127.0.0.1:8931` and is
published by nginx; see [Web app](#web-app).

## Rules

- Run only one instance per bot token. Stop any local bot first.
- The server hosts other projects. Do not start, stop, or prune their containers.
- Never run `RECREATE=1 ./sandbox/bootstrap.sh` here; see [Sandbox](#sandbox).
- Removing `agent-1` destroys `/work`.

## Update the code

Run on your machine, from the repo root, in bash or zsh. Only committed code is
deployed.

1. Check the commit.

   ```bash
   git status --short
   bun run check
   ```

2. Check that nothing is running. A restart interrupts active runs. Only
   `docker-init`, `sleep infinity`, and possibly background processes the agent
   left running should appear. This does not show a run that is waiting on the
   model, so also check `/status` in Telegram.

   ```bash
   ssh contabo docker top agent-1
   ```

3. Copy the code. `--delete` removes files deleted from the repo; the excludes
   protect secrets, dependencies, and the built web app. Add `-n -v` for a dry run.

   ```bash
   (
     set -e
     REV="$(git rev-parse --verify "${REV:-HEAD}")"
     TMP="$(mktemp -d)"
     trap 'rm -rf "$TMP"' EXIT
     git archive -o "$TMP/src.tar" "$REV"
     mkdir "$TMP/src"
     tar -xf "$TMP/src.tar" -C "$TMP/src"
     chmod 750 "$TMP/src"
     rsync -rlpt --delete --chown=eien:eien \
       --exclude=/.env --exclude=/.env.docker --exclude=node_modules --exclude=dist \
       "$TMP/src/" contabo:/opt/eien/
   )
   ```

4. Install dependencies, build the web app, and restart.

   ```bash
   ssh contabo 'cd /opt/eien &&
     runuser -u eien -- env HOME=/var/lib/eien/home bun install --frozen-lockfile &&
     runuser -u eien -- env HOME=/var/lib/eien/home bun run web:build &&
     systemctl restart eien'
   ```

5. Verify. Expect `active` and a `gateway online` log line, then send the bot a
   message that uses a tool.

   ```bash
   ssh contabo 'sleep 8; systemctl is-active eien; systemctl show eien -p NRestarts
     journalctl -u eien -n 15 --no-pager -o cat
     runuser -u eien -- /opt/eien-bin/docker exec agent-1 id'
   ```

If the commit changes `sandbox/Dockerfile`, also follow [Sandbox](#sandbox). If
it adds environment variables, follow [Secrets and models](#secrets-and-models).

If a run was interrupted, the bot may say "That run crashed" with
`Harness is closed` in the log. Interrupted runs resume after the restart.

## Roll back

Repeat steps 3 to 5 with an older commit, setting it just before step 3:

```bash
export REV=<commit>
# ...steps 3 to 5...
unset REV
```

State is not rolled back. If the newer code changed the SQLite format, restore a
[backup](#back-up-state) too.

## Secrets and models

These overwrite the server's copies. Never commit them.

```bash
rsync -p --chmod=F600 --chown=eien:eien .env contabo:/opt/eien/.env
rsync -p --chmod=F600 --chown=eien:eien state/models.json contabo:/var/lib/eien/state/
ssh contabo systemctl restart eien
```

Paths and sandbox settings in `runtime.env` override `.env` and `.env.docker`.

## Operate

```bash
ssh contabo journalctl -u eien -f
ssh contabo systemctl status eien
ssh contabo systemctl restart eien
ssh contabo systemctl disable --now eien   # stop, and stay stopped after reboot
ssh contabo systemctl enable --now eien
```

## Back up state

Stop the bot so the SQLite files are consistent:

```bash
ssh contabo 'umask 077; systemctl stop eien
  tar -czf "/root/eien-state-$(date +%F-%H%M).tgz" -C /var/lib/eien state
  systemctl start eien'
```

This contains chats and model API keys. It does not include `/work`; copy that
with `docker cp agent-1:/work <dir>` (the snap CLI cannot write to every path,
so use `/opt/eien-bin/docker`).

## Sandbox

The snap's AppArmor confinement makes `no-new-privileges` fail with
`exec /sbin/docker-init: operation not permitted`. `bootstrap.sh` and the
gateway's fallback container creation both set it, so `agent-1` must be created
by hand. It instead uses a non-root user, `--cap-drop ALL`, and an image with no
setuid/setgid files.

Build the images. The Dockerfile goes through stdin because the snap CLI cannot
read `/opt`:

```bash
ssh contabo 'bash -s' <<'REMOTE'
set -e
docker build --build-arg INSTALL_BROWSER=1 -t eien/sandbox:local - < /opt/eien/sandbox/Dockerfile
docker build -t eien/sandbox:nosuid - <<'DOCKERFILE'
FROM eien/sandbox:local
USER root
RUN find / -xdev -type f -perm /6000 -exec chmod a-s {} +
USER agent
DOCKERFILE
REMOTE
```

Replace the container. **This destroys `/work`; copy out what you need first.**

```bash
ssh contabo 'bash -s' <<'REMOTE'
set -e
systemctl stop eien
docker rm -f agent-1 2>/dev/null || true
docker run -d --name agent-1 --init --cap-drop ALL --shm-size 1g --memory 3g \
  -w /work eien/sandbox:nosuid sleep infinity
systemctl start eien
REMOTE
```

## First install

Only for rebuilding the server. Requires `bun`, `rsync`, `curl`, and snap Docker.

1. Create the user and directories.

   ```bash
   ssh contabo 'useradd --system --create-home --home-dir /home/eien --shell /usr/sbin/nologin eien
     install -d -m 750 -o eien -g eien /opt/eien
     install -d -m 700 -o eien -g eien /var/lib/eien /var/lib/eien/state /var/lib/eien/home'
   ```

2. Copy the code (step 3 of [Update the code](#update-the-code)), then `.env` and
   the models file ([Secrets and models](#secrets-and-models), without the
   restart), then:

   ```bash
   ssh contabo 'cd /opt/eien && runuser -u eien -- cp .env.docker.example .env.docker &&
     runuser -u eien -- env HOME=/var/lib/eien/home bun install --frozen-lockfile &&
          runuser -u eien -- env HOME=/var/lib/eien/home bun run web:build'
   ```

3. Start Docker if needed, first checking which stopped containers it would
   bring up, then install the client and socket helper. Use a client version
   compatible with the daemon.

   ```bash
   ssh contabo 'bash -s' <<'REMOTE'
   set -e
   snap start docker.dockerd
   install -d /opt/eien-bin
   T="$(mktemp -d)"
   curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-29.1.3.tgz | tar -xz -C "$T" docker/docker
   install -m755 "$T/docker/docker" /opt/eien-bin/docker
   rm -rf "$T"
   cat > /usr/local/sbin/eien-docker-access <<'EOS'
   #!/bin/bash
   # Grant the eien bot access to the snap Docker socket (snap creates it root:root).
   for i in $(seq 60); do [ -S /run/docker.sock ] && break; sleep 1; done
   if command -v setfacl >/dev/null; then setfacl -m u:eien:rw /run/docker.sock
   else chgrp eien /run/docker.sock && chmod 660 /run/docker.sock; fi
   EOS
   chmod 755 /usr/local/sbin/eien-docker-access
   REMOTE
   ```

4. Build the images and create the container with `docker run`, as in
   [Sandbox](#sandbox), leaving out the `systemctl` and `docker rm` lines.

5. Write the overrides and the service, then start it.

   ```bash
   ssh contabo 'bash -s' <<'REMOTE'
   set -e
   cat > /var/lib/eien/runtime.env <<'EOS'
   STATE_DIR=/var/lib/eien/state
   HOME=/var/lib/eien/home
   SANDBOX_DRIVER=docker
   SANDBOX_DOCKER_IMAGE=eien/sandbox:nosuid
   SBX_NAME=agent-1
   SBX_WORKDIR=/work
   WEB_HOST=127.0.0.1
   WEB_PORT=8931
   WEB_ORIGIN=https://eien.havingsomuch.fun
   PATH=/opt/eien-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
   EOS
   chown eien:eien /var/lib/eien/runtime.env
   chmod 600 /var/lib/eien/runtime.env
   echo "WEB_ACCESS_TOKEN=$(openssl rand -hex 24)" >> /var/lib/eien/runtime.env
   cat > /etc/systemd/system/eien.service <<'EOS'
   [Unit]
   Description=eien always-on coding agent
   After=network-online.target snap.docker.dockerd.service
   Wants=network-online.target
   PartOf=snap.docker.dockerd.service

   [Service]
   Type=simple
   User=eien
   Group=eien
   WorkingDirectory=/opt/eien
   EnvironmentFile=/opt/eien/.env
   EnvironmentFile=/opt/eien/.env.docker
   EnvironmentFile=/var/lib/eien/runtime.env
   ExecStartPre=+/usr/local/sbin/eien-docker-access
   ExecStart=/usr/local/bin/bun --no-env-file /opt/eien/packages/gateway/src/index.ts
   Restart=always
   RestartSec=5
   KillMode=control-group
   TimeoutStopSec=30
   MemoryMax=1G
   LimitNOFILE=65535

   [Install]
   WantedBy=multi-user.target
   EOS
   systemctl daemon-reload
   systemctl enable --now eien
   REMOTE
   ```

6. Verify (step 5 of [Update the code](#update-the-code)).

The indented blocks are inside list items: copy them from rendered Markdown, or
strip the leading spaces, or the heredoc terminators will not match.

## Web app

Public at <https://eien.havingsomuch.fun>. The gateway serves the frontend and API;
nginx terminates TLS and rate-limits login. The site file is
`/etc/nginx/sites-available/eien.havingsomuch.fun` (proxying to 8931, with WebSocket
upgrade on `/api/events`); it is not in this repo, so back it up before rebuilding the
server. The certificate came from `certbot certonly --nginx -d eien.havingsomuch.fun`
and renews automatically. `WEB_*` settings, including the access token, live in
`/var/lib/eien/runtime.env`. The default port 8787 belongs to the `ids` service.

Show the access token (anyone who has it controls the agent):

```bash
ssh contabo "sed -n 's/^WEB_ACCESS_TOKEN=//p' /var/lib/eien/runtime.env"
```

Rotate it, which signs out every browser:

```bash
ssh contabo 'sed -i "s/^WEB_ACCESS_TOKEN=.*/WEB_ACCESS_TOKEN=$(openssl rand -hex 24)/" /var/lib/eien/runtime.env
  systemctl restart eien'
```

After editing the site file: `nginx -t && systemctl reload nginx`.

## Troubleshooting

| Symptom                                  | Fix                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `permission denied` on the Docker socket | `systemctl restart eien` reapplies access                                        |
| Cannot connect to the Docker API         | `snap start docker.dockerd`, then `systemctl start eien`                         |
| Bot stopped after Docker stopped         | Expected (`PartOf`); `systemctl start eien`                                      |
| `docker-init: operation not permitted`   | The container has `no-new-privileges`; recreate it as in [Sandbox](#sandbox)     |
| Telegram 409 conflict                    | Another instance is using the same token; stop it                                |
| Out of memory                            | Other services share 11 GB with no swap; check `free -h` and the harness RAM cap |

## Security

- The agent's commands run in `agent-1`: non-root, no capabilities, no host
  mounts, no Docker socket.
- The `eien` host user can use the Docker socket, which is **root-equivalent**.
- The container's uid 1001 is also the host's `deploy` user, so a container
  escape would act as `deploy`.
- The sandbox has unrestricted internet access and no CPU or process limit.
- Keep `ALLOWED_TELEGRAM_USER_IDS` limited to trusted users.
