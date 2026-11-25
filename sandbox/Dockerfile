FROM node:22-bookworm-slim

# Set to 0 for a smaller image without Chrome/agent-browser.
ARG INSTALL_BROWSER=1

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/agent \
    XDG_CACHE_HOME=/home/agent/.cache \
    NPM_CONFIG_PREFIX=/home/agent/.npm-global \
    PATH=/home/agent/.npm-global/bin:/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates bash coreutils curl git jq file unzip zip less vim-tiny \
      ffmpeg imagemagick pandoc poppler-utils \
      python3 python3-pip python3-venv procps ripgrep \
      build-essential pkg-config openssh-client \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 agent \
 && useradd --create-home --uid 1001 --gid 1001 --shell /bin/bash agent \
 && install -d -m 755 /work \
 && install -d -m 700 -o agent -g agent /home/agent/.npm-global /home/agent/.local/bin /home/agent/.cache \
 && chown -R agent:agent /work /home/agent \
 && printf '%s\n' 'export PATH="/home/agent/.npm-global/bin:/home/agent/.local/bin:$PATH"' > /etc/profile.d/eien-path.sh

# Install the browser CLI and Chrome into the agent's home so the unprivileged
# user can use (and update) them.
RUN if [ "$INSTALL_BROWSER" = "1" ]; then \
      npm install -g agent-browser \
      && agent-browser install --with-deps \
      && chown -R agent:agent /home/agent; \
    fi

USER agent
WORKDIR /work

RUN git config --global user.name "eien" \
 && git config --global user.email "eien@localhost" \
 && git config --global init.defaultBranch main

CMD ["sleep", "infinity"]
