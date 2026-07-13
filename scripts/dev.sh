#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${SHEJANE_DEV_LOG_DIR:-${ROOT_DIR}/.tmp/dev}"
TOKEN="${SHEJANE_LOCAL_HOST_TOKEN:-dev-local-token}"
LOCAL_HOST_PORT="${SHEJANE_LOCAL_HOST_PORT:-17371}"
LOCAL_HOST_URL="${SHEJANE_LOCAL_HOST_URL:-http://127.0.0.1:${LOCAL_HOST_PORT}}"
CLIENT_DEV_PORT="${CLIENT_DEV_PORT:-55173}"
CLIENT_DEV_URL="${ELECTRON_DEV_URL:-http://127.0.0.1:${CLIENT_DEV_PORT}}"

PIDS=()
RUNTIME_ENV=(
  env -i
  "PATH=$PATH"
  "HOME=$HOME"
  "USER=${USER:-}"
  "TMPDIR=${TMPDIR:-/tmp}"
  "SHELL=${SHELL:-/bin/zsh}"
  "PYTHONUNBUFFERED=1"
)
[[ -n "${SHEJANE_LOCAL_MCP_SERVERS:-}" ]] && RUNTIME_ENV+=("SHEJANE_LOCAL_MCP_SERVERS=$SHEJANE_LOCAL_MCP_SERVERS")
[[ -n "${SHEJANE_LOCAL_SKILLS_PATH:-}" ]] && RUNTIME_ENV+=("SHEJANE_LOCAL_SKILLS_PATH=$SHEJANE_LOCAL_SKILLS_PATH")

kill_tree() {
  local pid="$1"
  local child
  while read -r child; do
    [[ -n "$child" ]] && kill_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  trap - EXIT INT TERM
  for pid in "${PIDS[@]:-}"; do
    kill_tree "$pid"
  done
}
trap cleanup EXIT INT TERM

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 127
  fi
}

ensure_node_modules() {
  if [[ ! -d "${ROOT_DIR}/node_modules/.pnpm" ]]; then
    echo "Installing pnpm workspace dependencies"
    (cd "$ROOT_DIR" && pnpm install)
  fi
}

force_kill_stragglers() {
  # Runtime and Electron may survive SIGTERM; default to a clean restart.
  if [[ "${SHEJANE_DEV_REUSE:-0}" == "1" ]]; then
    echo "[dev-electron] SHEJANE_DEV_REUSE=1 — keeping existing processes"
    return
  fi

  echo "[dev-electron] hard-restart: killing stragglers"
  pkill -9 -f 'shejane-runtime' >/dev/null 2>&1 || true
  pkill -9 -f 'electron/main\.cjs' >/dev/null 2>&1 || true
  pkill -9 -f "vite.*--port ${CLIENT_DEV_PORT}" \
    >/dev/null 2>&1 || true
  for port in "$LOCAL_HOST_PORT" "$CLIENT_DEV_PORT"; do
    local pids
    pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      echo "[dev-electron] freeing port ${port} (pids: ${pids})"
      # shellcheck disable=SC2086
      kill -9 $pids >/dev/null 2>&1 || true
    fi
  done
  sleep 1
}

open_log_tail_terminal() {
  # macOS-only live Runtime log. Disable with SHEJANE_DEV_LOG_TAIL=0.
  [[ "${SHEJANE_DEV_LOG_TAIL:-1}" == "1" ]] || return 0
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  local log="${LOG_DIR}/local-host.log"
  : > "$log" 2>/dev/null || true
  osascript >/dev/null 2>&1 <<APPLESCRIPT || true
tell application "Terminal"
  activate
  do script "tail -F '${log}' | grep --line-buffered -iE 'POST /local|HTTP/1\\.1 [45]|run\\.(waiting|completed|failed|started)|permission\\.|question\\.|llm\\.error|KeyError|Traceback' || tail -F '${log}'"
end tell
APPLESCRIPT
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local log_file="${3:-}"
  for _ in $(seq 1 120); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for ${label}: ${url}" >&2
  if [[ -n "$log_file" && -f "$log_file" ]]; then
    echo "Last ${label} log lines:" >&2
    tail -80 "$log_file" >&2 || true
  fi
  exit 1
}

start_local_host() {
  if curl -fsS "${LOCAL_HOST_URL}/local/v1/health" >/dev/null 2>&1; then
    echo "Runtime already running at ${LOCAL_HOST_URL}"
    return
  fi

  local log_file="${LOG_DIR}/local-host.log"
  echo "Starting Runtime at ${LOCAL_HOST_URL}"
  (
    cd "${ROOT_DIR}/services/runtime"
    "${RUNTIME_ENV[@]}" uv run shejane-runtime \
      --host 127.0.0.1 --port "$LOCAL_HOST_PORT" --token "$TOKEN" \
      >"$log_file" 2>&1
  ) &
  PIDS+=("$!")
  wait_for_url "${LOCAL_HOST_URL}/local/v1/health" "Runtime" "$log_file"
}

start_client_dev_server() {
  if curl -fsS "$CLIENT_DEV_URL" >/dev/null 2>&1; then
    echo "Client dev server already running at ${CLIENT_DEV_URL}"
    return
  fi

  local log_file="${LOG_DIR}/client-vite.log"
  echo "Starting client dev server at ${CLIENT_DEV_URL}"
  (
    cd "${ROOT_DIR}/apps/desktop"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "USER=${USER:-}" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "SHELL=${SHELL:-/bin/zsh}" \
      pnpm dev --host 127.0.0.1 --port "$CLIENT_DEV_PORT" >"$log_file" 2>&1
  ) &
  PIDS+=("$!")
  wait_for_url "$CLIENT_DEV_URL" "client dev server" "$log_file"
}

launch_electron() {
  echo "Launching Electron. Close the app window to stop local dev helper processes."
  (
    cd "${ROOT_DIR}/apps/desktop"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "USER=${USER:-}" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "SHELL=${SHELL:-/bin/zsh}" \
      "ELECTRON_DEV=true" \
      "ELECTRON_DEV_URL=$CLIENT_DEV_URL" \
      "SHEJANE_LOCAL_HOST_URL=$LOCAL_HOST_URL" \
      "SHEJANE_LOCAL_HOST_TOKEN=$TOKEN" \
      pnpm electron
  ) &
  local electron_pid="$!"
  PIDS+=("$electron_pid")
  wait "$electron_pid"
}

start_stack() {
  require_command curl
  require_command pnpm
  require_command uv
  mkdir -p "$LOG_DIR"
  ensure_node_modules

  force_kill_stragglers

  start_local_host
  start_client_dev_server
  open_log_tail_terminal
  launch_electron
}

restart_runtime() {
  local old_pid new_pid log_file="${LOG_DIR}/local-host.log"
  mkdir -p "$LOG_DIR"
  old_pid="$(lsof -ti :"$LOCAL_HOST_PORT" 2>/dev/null | head -1 || true)"
  if [[ -n "$old_pid" ]]; then
    echo "→ Old Runtime PID $old_pid started: $(ps -p "$old_pid" -o lstart= 2>/dev/null || echo unknown)"
  else
    echo "→ No Runtime currently bound to :$LOCAL_HOST_PORT"
  fi

  lsof -ti :"$LOCAL_HOST_PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  for _ in $(seq 1 10); do
    lsof -ti :"$LOCAL_HOST_PORT" >/dev/null 2>&1 || break
    sleep 0.5
  done
  if lsof -ti :"$LOCAL_HOST_PORT" >/dev/null 2>&1; then
    echo "Port :$LOCAL_HOST_PORT is still occupied after kill -9." >&2
    exit 1
  fi

  echo "→ Starting Runtime at ${LOCAL_HOST_URL}"
  (
    cd "${ROOT_DIR}/services/runtime"
    nohup "${RUNTIME_ENV[@]}" uv run shejane-runtime \
      --host 127.0.0.1 --port "$LOCAL_HOST_PORT" --token "$TOKEN" \
      >"$log_file" 2>&1 &
    echo "$!" >"${LOG_DIR}/local-host.pid"
  )
  wait_for_url "${LOCAL_HOST_URL}/local/v1/health" "Runtime" "$log_file"
  new_pid="$(lsof -ti :"$LOCAL_HOST_PORT" 2>/dev/null | head -1 || true)"
  echo "✅ Runtime ready. PID ${new_pid:-?}. Reload the Desktop window to reconnect."
}

row() {
  printf '  %s %-32s %s\n' "$1" "$2" "${3:-}"
}

section() {
  printf '\n\033[1m%s\033[0m\n' "$1"
}

doctor() {
  local daemon_pid started health_json daemon_env path port pids
  local leaks=()

  section "Runtime (:${LOCAL_HOST_PORT})"
  daemon_pid="$(lsof -ti :"$LOCAL_HOST_PORT" 2>/dev/null | head -1 || true)"
  if [[ -z "$daemon_pid" ]]; then
    row "❌" "not running" "→ make dev-electron"
  else
    started="$(ps -p "$daemon_pid" -o lstart= 2>/dev/null | xargs || echo unknown)"
    row "✅" "PID $daemon_pid" "started: $started"
    health_json="$(curl -fsS --max-time 2 "${LOCAL_HOST_URL}/local/v1/health" 2>/dev/null || true)"
    if [[ "$health_json" == *'"status":"ok"'* ]]; then
      row "✅" "health" "status=ok"
    else
      row "❌" "health" "${LOCAL_HOST_URL}/local/v1/health did not respond correctly"
    fi
    if [[ "$health_json" == *'"pairing_configured":true'* ]]; then
      row "✅" "pairing token" "configured"
    else
      row "⚠️" "pairing token" "not configured"
    fi

    daemon_env="$(ps eww -p "$daemon_pid" 2>/dev/null | tr ' ' '\n' || true)"
    for path in OPENAI_API_KEY TAVILY_API_KEY ANTHROPIC_API_KEY; do
      [[ "$daemon_env" == *"${path}="* ]] && leaks+=("$path")
    done
    if [[ ${#leaks[@]} -eq 0 ]]; then
      row "✅" "provider keys" "not present in process env"
    else
      row "❌" "provider keys leaked" "${leaks[*]}"
    fi
  fi

  section "Dev ports"
  for port in "$LOCAL_HOST_PORT" "$CLIENT_DEV_PORT"; do
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    [[ -n "$pids" ]] && row "✅" "port $port" "pids $pids"
  done

  section "Dependencies"
  [[ -d node_modules/.pnpm ]] && row "✅" "pnpm workspace" "ready" \
    || row "❌" "pnpm workspace" "→ pnpm install"
  [[ -d services/runtime/.venv ]] && row "✅" "Runtime venv" "ready" \
    || row "❌" "Runtime venv" "→ cd services/runtime && uv sync"
}

logs() {
  local target="${1:-all}" lines="${LOG_LINES:-200}" file
  case "$target" in
    local-host|client)
      [[ "$target" == "local-host" ]] && file="${LOG_DIR}/local-host.log" || file="${LOG_DIR}/client-vite.log"
      [[ -f "$file" ]] || { echo "Log does not exist yet: $file" >&2; exit 1; }
      tail -n "$lines" -f "$file"
      ;;
    all)
      echo "== Runtime =="
      tail -n "${LOG_LINES:-80}" "${LOG_DIR}/local-host.log" 2>/dev/null || true
      echo "== Desktop =="
      tail -n "${LOG_LINES:-80}" "${LOG_DIR}/client-vite.log" 2>/dev/null || true
      ;;
    *) echo "Usage: $0 logs [local-host|client|all]" >&2; exit 2 ;;
  esac
}

case "${1:-start}" in
  start) start_stack ;;
  restart) restart_runtime ;;
  doctor) doctor ;;
  logs) shift; logs "${1:-all}" ;;
  *) echo "Usage: $0 [start|restart|doctor|logs]" >&2; exit 2 ;;
esac
