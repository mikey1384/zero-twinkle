#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${AIZERO_APP_DIR:-$APP_DIR_DEFAULT}"

ROOT_STATE_DIR="/var/lib/aizero-watchdog"
ROOT_LOCK_FILE="$ROOT_STATE_DIR/watchdog.lock"
ROOT_ALERT_STATE_FILE="$ROOT_STATE_DIR/alert.state"
ROOT_OUTAGE_STATE_FILE="$ROOT_STATE_DIR/outage.state"
ROOT_MAINTENANCE_STATE_FILE="$ROOT_STATE_DIR/maintenance.state"

if [[ -n "${LOCK_FILE:-}" ]]; then
  lock_dir_private=0
else
  if [[ -f "$ROOT_LOCK_FILE" ]] && [[ -w "$ROOT_LOCK_FILE" ]]; then
    LOCK_FILE="$ROOT_LOCK_FILE"
    lock_dir_private=0
  elif [[ "${EUID}" -eq 0 ]]; then
    LOCK_FILE="$ROOT_LOCK_FILE"
    lock_dir_private=0
  else
    LOCK_FILE="${TMPDIR:-/tmp}/aizero-watchdog-${EUID}/watchdog.lock"
    lock_dir_private=1
  fi
fi

if [[ -n "${ALERT_STATE_FILE:-}" ]]; then
  alert_state_dir_private=0
else
  if [[ "${EUID}" -eq 0 ]]; then
    ALERT_STATE_FILE="$ROOT_ALERT_STATE_FILE"
    alert_state_dir_private=0
  else
    ALERT_STATE_FILE="${TMPDIR:-/tmp}/aizero-watchdog-${EUID}/alert.state"
    alert_state_dir_private=1
  fi
fi

if [[ -n "${OUTAGE_STATE_FILE:-}" ]]; then
  outage_state_dir_private=0
else
  if [[ "${EUID}" -eq 0 ]]; then
    OUTAGE_STATE_FILE="$ROOT_OUTAGE_STATE_FILE"
    outage_state_dir_private=0
  else
    OUTAGE_STATE_FILE="${TMPDIR:-/tmp}/aizero-watchdog-${EUID}/outage.state"
    outage_state_dir_private=1
  fi
fi

if [[ -n "${MAINTENANCE_STATE_FILE:-}" ]]; then
  maintenance_state_dir_private=0
else
  if [[ -f "$ROOT_MAINTENANCE_STATE_FILE" ]]; then
    MAINTENANCE_STATE_FILE="$ROOT_MAINTENANCE_STATE_FILE"
    maintenance_state_dir_private=0
  elif [[ "${EUID}" -eq 0 ]]; then
    MAINTENANCE_STATE_FILE="$ROOT_MAINTENANCE_STATE_FILE"
    maintenance_state_dir_private=0
  else
    MAINTENANCE_STATE_FILE="${TMPDIR:-/tmp}/aizero-watchdog-${EUID}/maintenance.state"
    maintenance_state_dir_private=1
  fi
fi

mkdir -p \
  "$(dirname "$LOCK_FILE")" \
  "$(dirname "$ALERT_STATE_FILE")" \
  "$(dirname "$OUTAGE_STATE_FILE")" \
  "$(dirname "$MAINTENANCE_STATE_FILE")"
if [[ "${EUID}" -eq 0 ]] && [[ "$LOCK_FILE" == "$ROOT_LOCK_FILE" ]]; then
  WATCHDOG_LOCK_GROUP="${WATCHDOG_LOCK_GROUP:-ec2-user}"
  chmod 0755 "$(dirname "$LOCK_FILE")"
  touch "$LOCK_FILE"
  if ! chgrp "$WATCHDOG_LOCK_GROUP" "$LOCK_FILE"; then
    echo "[watchdog] unable to set lock file group to ${WATCHDOG_LOCK_GROUP}" >&2
  fi
  chmod 0660 "$LOCK_FILE"
fi
if [[ "${lock_dir_private}" -eq 1 ]]; then
  chmod 700 "$(dirname "$LOCK_FILE")"
fi
if [[ "${alert_state_dir_private}" -eq 1 ]]; then
  chmod 700 "$(dirname "$ALERT_STATE_FILE")"
fi
if [[ "${outage_state_dir_private}" -eq 1 ]]; then
  chmod 700 "$(dirname "$OUTAGE_STATE_FILE")"
fi
if [[ "${maintenance_state_dir_private}" -eq 1 ]]; then
  chmod 700 "$(dirname "$MAINTENANCE_STATE_FILE")"
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[watchdog] already running, skipping"
  exit 0
fi

cd "$APP_DIR"

PROCESS_MATCH="${AIZERO_PROCESS_MATCH:-/home/ec2-user/zero/index.js}"
HEARTBEAT_FILE="${AIZERO_HEARTBEAT_FILE:-/tmp/aizero-heartbeat.json}"
MAX_HEARTBEAT_AGE_SECONDS="${MAX_HEARTBEAT_AGE_SECONDS:-180}"
RECOVERY_CMD="${RECOVERY_CMD:-bash ./scripts/aizero-service.sh restart}"
RECOVERY_WAIT_SECONDS="${RECOVERY_WAIT_SECONDS:-20}"
ALERT_COMPONENT="${ALERT_COMPONENT:-AIZero/Watchdog}"
ALERT_COOLDOWN_SECONDS="${ALERT_COOLDOWN_SECONDS:-900}"
SEND_ERROR_REPORT_SCRIPT="${SEND_ERROR_REPORT_SCRIPT:-$APP_DIR/scripts/send-error-report.mjs}"
FALLBACK_SEND_ERROR_REPORT_SCRIPT="/home/ec2-user/server/scripts/send-error-report.mjs"
ALERT_RUN_AS_USER="${ALERT_RUN_AS_USER:-ec2-user}"

run_external_alert() {
  local script_path="$1"
  local message="$2"
  local info="$3"

  if [[ ! -f "$script_path" ]]; then
    return 1
  fi

  if [[ "${EUID}" -eq 0 ]]; then
    if ! id "$ALERT_RUN_AS_USER" >/dev/null 2>&1; then
      echo "[watchdog] alert user not found: ${ALERT_RUN_AS_USER}" >&2
      return 1
    fi

    if command -v runuser >/dev/null 2>&1; then
      runuser -u "$ALERT_RUN_AS_USER" -- /bin/bash -lc 'node "$1" "$2" "$3" "$4"' _ \
        "$script_path" "$ALERT_COMPONENT" "$message" "$info"
      return $?
    fi

    su - "$ALERT_RUN_AS_USER" -s /bin/bash -c 'node "$1" "$2" "$3" "$4"' _ \
      "$script_path" "$ALERT_COMPONENT" "$message" "$info"
    return $?
  fi

  node "$script_path" "$ALERT_COMPONENT" "$message" "$info"
}

send_alert() {
  local message="$1"
  local info="$2"

  if run_external_alert "$SEND_ERROR_REPORT_SCRIPT" "$message" "$info"; then
    return 0
  fi

  if [[ "$SEND_ERROR_REPORT_SCRIPT" != "$FALLBACK_SEND_ERROR_REPORT_SCRIPT" ]] &&
    run_external_alert "$FALLBACK_SEND_ERROR_REPORT_SCRIPT" "$message" "$info"; then
    return 0
  fi

  logger -t aizero-watchdog "external alert send failed | component=${ALERT_COMPONENT}, primary_script=${SEND_ERROR_REPORT_SCRIPT}, fallback_script=${FALLBACK_SEND_ERROR_REPORT_SCRIPT}"
  logger -t aizero-watchdog "${message} | ${info}"
  return 1
}

format_ts_utc() {
  local ts="$1"

  if [[ "$ts" == "0" ]]; then
    printf 'until_disabled'
    return 0
  fi

  date -u -d "@${ts}" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || printf '%s' "$ts"
}

maintenance_until=""
maintenance_note=""

maintenance_active() {
  maintenance_until=""
  maintenance_note=""

  if [[ ! -f "$MAINTENANCE_STATE_FILE" ]]; then
    return 1
  fi

  local raw_until=""
  local raw_note=""
  IFS='|' read -r raw_until raw_note < "$MAINTENANCE_STATE_FILE" || true

  if [[ ! "$raw_until" =~ ^[0-9]+$ ]]; then
    echo "[watchdog] ignoring invalid maintenance state: ${MAINTENANCE_STATE_FILE}" >&2
    rm -f "$MAINTENANCE_STATE_FILE" 2>/dev/null || true
    return 1
  fi

  if [[ "$raw_until" -ne 0 ]] && (( $(date +%s) >= raw_until )); then
    rm -f "$MAINTENANCE_STATE_FILE" 2>/dev/null || true
    return 1
  fi

  maintenance_until="$raw_until"
  maintenance_note="$raw_note"
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

open_incident_ts=""
open_incident_fingerprint=""
open_incident_details=""

read_open_incident() {
  open_incident_ts=""
  open_incident_fingerprint=""
  open_incident_details=""

  if [[ ! -f "$OUTAGE_STATE_FILE" ]]; then
    return 1
  fi

  IFS='|' read -r open_incident_ts open_incident_fingerprint open_incident_details < "$OUTAGE_STATE_FILE" || true
  if [[ ! "$open_incident_ts" =~ ^[0-9]+$ ]] || [[ -z "$open_incident_fingerprint" ]]; then
    echo "[watchdog] ignoring invalid outage state: ${OUTAGE_STATE_FILE}" >&2
    rm -f "$OUTAGE_STATE_FILE" 2>/dev/null || true
    return 1
  fi

  return 0
}

record_open_incident() {
  local fingerprint="$1"
  local details="$2"

  printf '%s|%s|%s\n' "$(date +%s)" "$fingerprint" "$details" > "$OUTAGE_STATE_FILE"
}

clear_open_incident() {
  rm -f "$OUTAGE_STATE_FILE" 2>/dev/null || true
}

send_recovery_alert_if_needed() {
  if ! read_open_incident; then
    return 0
  fi

  local now_ts
  now_ts="$(date +%s)"
  local duration_seconds="$((now_ts - open_incident_ts))"
  local recovery_details="incident_at=$(format_ts_utc "$open_incident_ts"), recovered_at=$(format_ts_utc "$now_ts"), duration_seconds=${duration_seconds}, ${open_incident_details}"

  if send_alert "aizero watchdog recovered" "$recovery_details"; then
    clear_open_incident
    echo "[watchdog] recovery alert sent (duration_seconds=${duration_seconds})"
  else
    echo "[watchdog] failed to send recovery alert" >&2
  fi
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

if maintenance_active; then
  echo "[watchdog] maintenance active (until=$(format_ts_utc "$maintenance_until"), note=${maintenance_note:-none}); skipping health checks"
  exit 0
fi

if healthy_now; then
  send_recovery_alert_if_needed
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
    record_open_incident "$fingerprint" "$details"
  fi
fi

echo "[watchdog] unhealthy (${details}); attempting recovery"
recovery_exit_code=0
if bash -lc "$RECOVERY_CMD"; then
  :
else
  recovery_exit_code=$?
  echo "[watchdog] recovery command failed (exit=${recovery_exit_code})" >&2
fi
sleep "$RECOVERY_WAIT_SECONDS"

if healthy_now; then
  send_recovery_alert_if_needed
  echo "[watchdog] recovered after restart attempt (recovery_exit=${recovery_exit_code})"
  exit 0
fi

post_age="$(heartbeat_age_seconds)"
post_process_ok=0
if is_process_running; then
  post_process_ok=1
fi
post_details="reason=${reason}, post_process_ok=${post_process_ok}, post_heartbeat_age=${post_age}, heartbeat_file=${HEARTBEAT_FILE}, recovery_cmd=${RECOVERY_CMD}, recovery_exit=${recovery_exit_code}"
if send_alert "aizero watchdog failed recovery" "$post_details"; then
  record_open_incident "$fingerprint" "$post_details"
else
  logger -t aizero-watchdog "failed to deliver failed-recovery alert | ${post_details}"
fi
echo "[watchdog] failed recovery (${post_details})" >&2
exit 1
