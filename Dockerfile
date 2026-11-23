# syntax=docker/dockerfile:1

# Bun runs the TypeScript directly, so there is no build step: the runtime image
# carries node_modules and the sources.
FROM oven/bun:1.3.8-debian AS deps
WORKDIR /app

COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.8-debian AS runtime
WORKDIR /app

# ssh/scp are the transport to the sandbox container; nothing else runs here.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    STATE_DIR=/data \
    HOME=/tmp/home

# The whole installed tree, including the per-workspace node_modules Bun nests
# for some dependencies.
COPY --from=deps /app ./

RUN mkdir -p /data /tmp/home && chmod 1777 /tmp/home
USER bun

CMD ["bun", "packages/gateway/src/index.ts"]
