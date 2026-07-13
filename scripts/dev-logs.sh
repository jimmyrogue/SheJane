#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${SHEJANE_DEV_LOG_DIR:-${ROOT_DIR}/.tmp/dev}"
TARGET="${1:-help}"

show_file_log() {
  local file="$1"
  local label="$2"
  if [[ ! -f "$file" ]]; then
    echo "${label} log does not exist yet: ${file}" >&2
    echo "Start the dev app with: make dev-electron" >&2
    exit 1
  fi
  tail -n "${LOG_LINES:-200}" -f "$file"
}

case "$TARGET" in
  local-host)
    show_file_log "${LOG_DIR}/local-host.log" "Local Host"
    ;;
  client)
    show_file_log "${LOG_DIR}/client-vite.log" "Client Vite"
    ;;
  all)
    echo "== Local Host logs =="
    tail -n "${LOG_LINES:-80}" "${LOG_DIR}/local-host.log" 2>/dev/null || true
    echo
    echo "== Client Vite logs =="
    tail -n "${LOG_LINES:-80}" "${LOG_DIR}/client-vite.log" 2>/dev/null || true
    ;;
  *)
    cat <<'USAGE'
Usage:
  scripts/dev-logs.sh local-host   # follow Local Host logs from make dev-electron
  scripts/dev-logs.sh client       # follow client Vite logs from make dev-electron
  scripts/dev-logs.sh all          # print a snapshot of all logs
USAGE
    ;;
esac
