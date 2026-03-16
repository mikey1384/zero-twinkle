#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${WATCHDOG_STATE_DIR:-/var/lib/aizero-watchdog}"
MAINTENANCE_STATE_FILE="${MAINTENANCE_STATE_FILE:-$STATE_DIR/maintenance.state}"
DEFAULT_SECONDS="${DEFAULT_SECONDS:-180}"

format_ts_utc() {
  local ts="$1"

  if [[ "$ts" == "0" ]]; then
    printf 'until_disabled'
    return 0
  fi

  date -u -d "@${ts}" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || printf '%s' "$ts"
}

read_state() {
  local raw_until=""
  local raw_note=""

  if [[ ! -f "$MAINTENANCE_STATE_FILE" ]]; then
    return 1
  fi

  IFS='|' read -r raw_until raw_note < "$MAINTENANCE_STATE_FILE" || true
  if [[ ! "$raw_until" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  MAINTENANCE_UNTIL="$raw_until"
  MAINTENANCE_NOTE="$raw_note"
  return 0
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "run as root: sudo bash ./scripts/watchdog-maintenance-aizero.sh $*" >&2
    exit 1
  fi
}

cmd="${1:-status}"

case "$cmd" in
  on|enable)
    require_root "$@"

    seconds="${2:-$DEFAULT_SECONDS}"
    if [[ "$seconds" == "forever" ]]; then
      until_ts=0
    elif [[ "$seconds" =~ ^[0-9]+$ ]]; then
      until_ts="$(( $(date +%s) + seconds ))"
    else
      echo "seconds must be an integer or 'forever'" >&2
      exit 1
    fi

    note="${*:3}"
    if [[ -z "$note" ]]; then
      note="planned restart"
    fi
    note="${note//|/-}"

    install -d -m 0755 "$STATE_DIR"
    printf '%s|%s\n' "$until_ts" "$note" > "$MAINTENANCE_STATE_FILE"
    chown root:root "$MAINTENANCE_STATE_FILE"
    chmod 0644 "$MAINTENANCE_STATE_FILE"

    echo "maintenance enabled until $(format_ts_utc "$until_ts") (note=${note})"
    ;;
  off|disable|clear)
    require_root "$@"
    rm -f "$MAINTENANCE_STATE_FILE"
    echo "maintenance disabled"
    ;;
  status)
    if read_state; then
      if [[ "$MAINTENANCE_UNTIL" != "0" ]] && (( $(date +%s) >= MAINTENANCE_UNTIL )); then
        echo "maintenance expired at $(format_ts_utc "$MAINTENANCE_UNTIL") (note=${MAINTENANCE_NOTE:-none})"
        exit 1
      fi

      echo "maintenance active until $(format_ts_utc "$MAINTENANCE_UNTIL") (note=${MAINTENANCE_NOTE:-none})"
      exit 0
    fi

    echo "maintenance inactive"
    exit 1
    ;;
  *)
    echo "usage: $0 [status|on <seconds|forever> [note...]|off]" >&2
    exit 1
    ;;
esac
