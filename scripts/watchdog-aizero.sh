#!/usr/bin/env bash
set -euo pipefail

LOCK_FILE="/tmp/aizero-watchdog.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[watchdog] already running, skipping"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

PROCESS_MATCH="${AIZERO_PROCESS_MATCH:-/home/ec2-user/zero/index.js}"
HEARTBEAT_FILE="${AIZERO_HEARTBEAT_FILE:-/tmp/aizero-heartbeat.json}"
MAX_HEARTBEAT_AGE_SECONDS="${MAX_HEARTBEAT_AGE_SECONDS:-180}"
RECOVERY_CMD="${RECOVERY_CMD:-bash ./scripts/pm2-aizero.sh start}"
RECOVERY_WAIT_SECONDS="${RECOVERY_WAIT_SECONDS:-20}"
ALERT_COMPONENT="${ALERT_COMPONENT:-AIZero/Watchdog}"
ALERT_COOLDOWN_SECONDS="${ALERT_COOLDOWN_SECONDS:-900}"
ALERT_STATE_FILE="${ALERT_STATE_FILE:-/tmp/aizero-watchdog-alert.state}"
SEND_ERROR_REPORT_SCRIPT="${SEND_ERROR_REPORT_SCRIPT:-/home/ec2-user/server/scripts/send-error-report.mjs}"

send_alert() {
  local message="$1"
  local info="$2"

  if [[ -f "$SEND_ERROR_REPORT_SCRIPT" ]]; then
    if node "$SEND_ERROR_REPORT_SCRIPT" "$ALERT_COMPONENT" "$message" "$info"; then
      return 0
    fi
  fi

  logger -t aizero-watchdog "${message} | ${info}"
  return 0
}

should_send_alert() {
  local fingerprint="$1"
  local now
  local last_ts=""
  local last_fp=""

  now="$(date +%s)"
  if [[ -f "$ALERT_STATE_FILE" ]]; then
    IFS='|' read -r last_ts last_fp < "$ALERT_STATE_FILE" || true
    if [[ "$last_ts" =~ ^[0-9]+$ ]] && [[ "$last_fp" == "$fingerprint" ]]; then
      if (( now - last_ts < ALERT_COOLDOWN_SECONDS )); then
        return 1
      fi
    fi
  fi

  return 0
}

record_alert_sent() {
  local fingerprint="$1"
  printf '%s|%s\n' "$(date +%s)" "$fingerprint" > "$ALERT_STATE_FILE"
}

is_process_running() {
  pgrep -f "$PROCESS_MATCH" >/dev/null 2>&1
}

heartbeat_age_seconds() {
  if [[ ! -f "$HEARTBEAT_FILE" ]]; then
    echo "-1"
    return
  fi

  local now
  local last
  now="$(date +%s)"
  last="$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || echo 0)"
  echo "$((now - last))"
}

healthy_now() {
  local age
  age="$(heartbeat_age_seconds)"
  if ! is_process_running; then
    return 1
  fi
  if [[ "$age" -lt 0 ]]; then
    return 1
  fi
  if (( age > MAX_HEARTBEAT_AGE_SECONDS )); then
    return 1
  fi
  return 0
}

heartbeat_age="$(heartbeat_age_seconds)"
process_ok=0
if is_process_running; then
  process_ok=1
fi

if healthy_now; then
  rm -f "$ALERT_STATE_FILE"
  echo "[watchdog] healthy (process=up heartbeat_age=${heartbeat_age}s)"
  exit 0
fi

reason="process_down"
if [[ "$process_ok" -eq 1 ]]; then
  if [[ "$heartbeat_age" -lt 0 ]]; then
    reason="heartbeat_missing"
  else
    reason="heartbeat_stale_${heartbeat_age}s"
  fi
fi
fingerprint="reason=${reason}"
details="reason=${reason}, process_ok=${process_ok}, heartbeat_file=${HEARTBEAT_FILE}, heartbeat_age=${heartbeat_age}, recovery_cmd=${RECOVERY_CMD}"

if should_send_alert "detected:${fingerprint}"; then
  if send_alert "aizero watchdog detected outage" "$details"; then
    record_alert_sent "detected:${fingerprint}"
  fi
fi

echo "[watchdog] unhealthy (${details}); attempting recovery"
bash -lc "$RECOVERY_CMD"
sleep "$RECOVERY_WAIT_SECONDS"

if healthy_now; then
  echo "[watchdog] recovered after restart attempt"
  exit 0
fi

post_age="$(heartbeat_age_seconds)"
post_process_ok=0
if is_process_running; then
  post_process_ok=1
fi
post_details="reason=${reason}, post_process_ok=${post_process_ok}, post_heartbeat_age=${post_age}, heartbeat_file=${HEARTBEAT_FILE}, recovery_cmd=${RECOVERY_CMD}"
send_alert "aizero watchdog failed recovery" "$post_details"
echo "[watchdog] failed recovery (${post_details})" >&2
exit 1
