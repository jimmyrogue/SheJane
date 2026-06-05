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

recent_llm_errors() {
  cd "$ROOT_DIR"
  docker compose exec -T postgres psql -U shejane -d shejane -c "
    select request_id, scene, provider, model, status, error_message, started_at
    from llm_call_records
    order by started_at desc
    limit 20;
  "
}

case "$TARGET" in
  api)
    cd "$ROOT_DIR"
    docker compose logs --tail="${LOG_LINES:-200}" -f api
    ;;
  local-host)
    show_file_log "${LOG_DIR}/local-host.log" "Local Host"
    ;;
  client)
    show_file_log "${LOG_DIR}/client-vite.log" "Client Vite"
    ;;
  llm-errors)
    recent_llm_errors
    ;;
  all)
    cd "$ROOT_DIR"
    echo "== API logs =="
    docker compose logs --tail="${LOG_LINES:-80}" api || true
    echo
    echo "== Local Host logs =="
    tail -n "${LOG_LINES:-80}" "${LOG_DIR}/local-host.log" 2>/dev/null || true
    echo
    echo "== Client Vite logs =="
    tail -n "${LOG_LINES:-80}" "${LOG_DIR}/client-vite.log" 2>/dev/null || true
    echo
    echo "== Recent LLM records =="
    recent_llm_errors || true
    ;;
  *)
    cat <<'USAGE'
Usage:
  scripts/dev-logs.sh api          # follow Docker API logs
  scripts/dev-logs.sh local-host   # follow Local Host logs from make dev-electron
  scripts/dev-logs.sh client       # follow client Vite logs from make dev-electron
  scripts/dev-logs.sh llm-errors   # show recent LLM call records and error messages
  scripts/dev-logs.sh all          # print a snapshot of all logs
USAGE
    ;;
esac
