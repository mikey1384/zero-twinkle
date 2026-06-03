#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
if [[ -z "$ACTION" ]]; then
  echo "[aizero-service] action required: start | restart | stop | status" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="${AIZERO_SERVICE_NAME:-aizero.service}"
WATCHDOG_UNIT="${AIZERO_WATCHDOG_UNIT:-aizero-watchdog.timer}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-$(command -v systemctl || true)}"
MAINTENANCE_SCRIPT="${AIZERO_MAINTENANCE_SCRIPT:-$SCRIPT_DIR/watchdog-maintenance-aizero.sh}"
RESTART_MAINTENANCE_SECONDS="${AIZERO_RESTART_MAINTENANCE_SECONDS:-180}"
RESTART_MAINTENANCE_NOTE="${AIZERO_RESTART_MAINTENANCE_NOTE:-deploy restart}"

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

run_as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
    return
  fi

  if ! command -v sudo >/dev/null 2>&1; then
    echo "[aizero-service] sudo is required to manage ${SERVICE_NAME}" >&2
    exit 1
  fi

  sudo "$@"
}

show_status() {
  run_systemctl status "$SERVICE_NAME" --no-pager

  if run_systemctl list-unit-files "$WATCHDOG_UNIT" >/dev/null 2>&1; then
    printf '\n'
    run_systemctl status "$WATCHDOG_UNIT" --no-pager
  fi
}

restart_with_maintenance() {
  local maintenance_enabled_by_wrapper=0
  local restart_exit=0

  if [[ -f "$MAINTENANCE_SCRIPT" ]]; then
    if bash "$MAINTENANCE_SCRIPT" status >/dev/null 2>&1; then
      echo "[aizero-service] watchdog maintenance already active; leaving existing window unchanged"
    else
      run_as_root bash "$MAINTENANCE_SCRIPT" on "$RESTART_MAINTENANCE_SECONDS" "$RESTART_MAINTENANCE_NOTE"
      maintenance_enabled_by_wrapper=1
    fi
  else
    echo "[aizero-service] warning: maintenance script not found: ${MAINTENANCE_SCRIPT}" >&2
  fi

  run_systemctl restart "$SERVICE_NAME" || restart_exit=$?

  if [[ "$maintenance_enabled_by_wrapper" -eq 1 ]]; then
    local cleanup_exit=0
    run_as_root bash "$MAINTENANCE_SCRIPT" off || cleanup_exit=$?
    if [[ "$cleanup_exit" -ne 0 ]]; then
      echo "[aizero-service] warning: failed to clear watchdog maintenance" >&2
      if [[ "$restart_exit" -eq 0 ]]; then
        restart_exit="$cleanup_exit"
      fi
    fi
  fi

  return "$restart_exit"
}

case "$ACTION" in
  start)
    run_systemctl start "$SERVICE_NAME"
    ;;
  restart)
    restart_with_maintenance
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
