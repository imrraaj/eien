#!/usr/bin/env bash
# Stop the systemd service. State and the sandbox container are kept.
set -euo pipefail

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is not available; stop the gateway process yourself." >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || {
    echo "error: run as root or install sudo." >&2
    exit 1
  }
  exec sudo -E bash "$0" "$@"
fi

systemctl disable --now eien
echo "eien stopped. State and the sandbox container are kept."
