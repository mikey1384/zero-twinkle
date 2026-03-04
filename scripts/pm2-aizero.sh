#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
if [[ -z "$ACTION" ]]; then
  echo "[pm2] action required: start | restart | stop | status" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

APP_NAME="aizero"
PM2_BIN="./node_modules/.bin/pm2"
if [[ ! -x "$PM2_BIN" ]]; then
  PM2_BIN="$(command -v pm2 || true)"
fi

if [[ -z "${PM2_BIN:-}" ]]; then
  echo "[pm2] pm2 binary not found" >&2
  exit 1
fi

app_exists() {
  "$PM2_BIN" describe "$APP_NAME" >/dev/null 2>&1
}

start_app() {
  if app_exists; then
    echo "[pm2] $APP_NAME already exists; restarting instead of start"
    "$PM2_BIN" restart "$APP_NAME" --update-env
  else
    "$PM2_BIN" -o zero_out.log -e zero_err.log start index.js --name "$APP_NAME"
  fi
}

restart_app() {
  if app_exists; then
    "$PM2_BIN" restart "$APP_NAME" --update-env
  else
    echo "[pm2] $APP_NAME not found; starting instead of restart"
    "$PM2_BIN" -o zero_out.log -e zero_err.log start index.js --name "$APP_NAME"
  fi
}

stop_app() {
  if app_exists; then
    "$PM2_BIN" stop "$APP_NAME"
  else
    echo "[pm2] $APP_NAME not found; nothing to stop"
  fi
}

case "$ACTION" in
  start)
    start_app
    ;;
  restart)
    restart_app
    ;;
  stop)
    stop_app
    ;;
  status|list)
    "$PM2_BIN" ls
    ;;
  *)
    echo "[pm2] unsupported action: $ACTION" >&2
    exit 1
    ;;
esac
