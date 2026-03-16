#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root: sudo bash ./scripts/install-aizero-systemd.sh" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_SRC="$ROOT_DIR/systemd"
SYSTEMD_DEST="/etc/systemd/system"
WATCHDOG_INSTALL_DIR="/usr/local/lib/zero-twinkle"
WATCHDOG_INSTALL_PATH="$WATCHDOG_INSTALL_DIR/watchdog-aizero.sh"
WATCHDOG_STATE_DIR="/var/lib/aizero-watchdog"
WATCHDOG_LOCK_FILE="$WATCHDOG_STATE_DIR/watchdog.lock"
WATCHDOG_ALERT_STATE_FILE="$WATCHDOG_STATE_DIR/alert.state"
WATCHDOG_OUTAGE_STATE_FILE="$WATCHDOG_STATE_DIR/outage.state"
WATCHDOG_MAINTENANCE_STATE_FILE="$WATCHDOG_STATE_DIR/maintenance.state"
AIZERO_APP_USER="${AIZERO_APP_USER:-ec2-user}"

if ! id -u "$AIZERO_APP_USER" >/dev/null 2>&1; then
  echo "app user not found: $AIZERO_APP_USER" >&2
  exit 1
fi

AIZERO_APP_GROUP="$(id -gn "$AIZERO_APP_USER")"

install -m 0644 "$SYSTEMD_SRC/aizero.service" "$SYSTEMD_DEST/aizero.service"
install -m 0644 "$SYSTEMD_SRC/aizero-watchdog.service" "$SYSTEMD_DEST/aizero-watchdog.service"
install -m 0644 "$SYSTEMD_SRC/aizero-watchdog.timer" "$SYSTEMD_DEST/aizero-watchdog.timer"
install -d -m 0755 "$WATCHDOG_INSTALL_DIR"
install -m 0755 "$ROOT_DIR/scripts/watchdog-aizero.sh" "$WATCHDOG_INSTALL_PATH"
install -d -m 0755 "$WATCHDOG_STATE_DIR"
touch "$WATCHDOG_LOCK_FILE"
chown root:"$AIZERO_APP_GROUP" "$WATCHDOG_LOCK_FILE"
chmod 0660 "$WATCHDOG_LOCK_FILE"
touch "$WATCHDOG_ALERT_STATE_FILE"
chown root:root "$WATCHDOG_ALERT_STATE_FILE"
chmod 0600 "$WATCHDOG_ALERT_STATE_FILE"
if [[ -f "$WATCHDOG_OUTAGE_STATE_FILE" ]]; then
  chown root:root "$WATCHDOG_OUTAGE_STATE_FILE"
  chmod 0600 "$WATCHDOG_OUTAGE_STATE_FILE"
fi
if [[ -f "$WATCHDOG_MAINTENANCE_STATE_FILE" ]]; then
  chown root:root "$WATCHDOG_MAINTENANCE_STATE_FILE"
  chmod 0644 "$WATCHDOG_MAINTENANCE_STATE_FILE"
fi

systemctl daemon-reload
systemctl enable --now aizero.service
systemctl enable --now aizero-watchdog.timer

echo "installed and started: aizero.service, aizero-watchdog.timer"
echo "watchdog script installed to: $WATCHDOG_INSTALL_PATH"
echo "watchdog state prepared in: $WATCHDOG_STATE_DIR (lock group: $AIZERO_APP_GROUP)"
