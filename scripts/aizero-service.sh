#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
if [[ -z "$ACTION" ]]; then
  echo "[aizero-service] action required: start | restart | stop | status" >&2
  exit 1
fi

SERVICE_NAME="${AIZERO_SERVICE_NAME:-aizero.service}"
WATCHDOG_UNIT="${AIZERO_WATCHDOG_UNIT:-aizero-watchdog.timer}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-$(command -v systemctl || true)}"

if [[ -z "$SYSTEMCTL_BIN" ]]; then
  echo "[aizero-service] systemctl not found. Use npm run start:node for local foreground runs." >&2
  exit 1
fi

run_systemctl() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$SYSTEMCTL_BIN" "$@"
    return
  fi

  if ! command -v sudo >/dev/null 2>&1; then
    echo "[aizero-service] sudo is required to manage ${SERVICE_NAME}" >&2
    exit 1
  fi

  sudo "$SYSTEMCTL_BIN" "$@"
}

show_status() {
  run_systemctl status "$SERVICE_NAME" --no-pager

  if run_systemctl list-unit-files "$WATCHDOG_UNIT" >/dev/null 2>&1; then
    printf '\n'
    run_systemctl status "$WATCHDOG_UNIT" --no-pager
  fi
}

case "$ACTION" in
  start)
    run_systemctl start "$SERVICE_NAME"
    ;;
  restart)
    run_systemctl restart "$SERVICE_NAME"
    ;;
  stop)
    run_systemctl stop "$SERVICE_NAME"
    ;;
  status|list)
    show_status
    ;;
  *)
    echo "[aizero-service] unsupported action: $ACTION" >&2
    exit 1
    ;;
esac
