FROM debian:bookworm-slim

# Toolchain the agent expects, plus sshd as the only entry point. No Docker
# socket, no host mounts: the gateway reaches this container over SSH only.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates openssh-server openssh-client \
      bash git curl jq file unzip \
      ffmpeg imagemagick pandoc poppler-utils \
      python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /bin/bash agent \
 && install -d -m 700 -o agent -g agent /home/agent/.ssh \
 && install -d -m 755 -o agent -g agent /work \
 && ssh-keygen -A \
 && printf '%s\n' \
      'PasswordAuthentication no' \
      'KbdInteractiveAuthentication no' \
      'PermitRootLogin no' \
      > /etc/ssh/sshd_config.d/eien.conf

COPY entrypoint.sh /usr/local/bin/eien-sandbox-entrypoint
RUN chmod 755 /usr/local/bin/eien-sandbox-entrypoint

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/eien-sandbox-entrypoint"]
