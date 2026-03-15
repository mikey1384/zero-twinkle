#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root: sudo bash ./scripts/install-aizero-systemd.sh" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_SRC="$ROOT_DIR/systemd"
SYSTEMD_DEST="/etc/systemd/system"

install -m 0644 "$SYSTEMD_SRC/aizero.service" "$SYSTEMD_DEST/aizero.service"
install -m 0644 "$SYSTEMD_SRC/aizero-watchdog.service" "$SYSTEMD_DEST/aizero-watchdog.service"
install -m 0644 "$SYSTEMD_SRC/aizero-watchdog.timer" "$SYSTEMD_DEST/aizero-watchdog.timer"

systemctl daemon-reload
systemctl enable --now aizero.service
systemctl enable --now aizero-watchdog.timer

echo "installed and started: aizero.service, aizero-watchdog.timer"
