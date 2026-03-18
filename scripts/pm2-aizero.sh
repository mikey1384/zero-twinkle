#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "[compat] scripts/pm2-aizero.sh now delegates to systemd service control" >&2
exec bash "$SCRIPT_DIR/aizero-service.sh" "$@"
