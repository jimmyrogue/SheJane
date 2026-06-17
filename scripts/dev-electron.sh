#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

load_dotenv() {
  local file="${ROOT_DIR}/.env"
  [[ -f "$file" ]] || return 0

  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    line="${line#export }"
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    if [[ -z "${!key-}" ]]; then
      export "$key=$value"
    fi
  done < "$file"
}

load_dotenv

LOG_DIR="${SHEJANE_DEV_LOG_DIR:-${ROOT_DIR}/.tmp/dev}"
TOKEN="${SHEJANE_LOCAL_HOST_TOKEN:-dev-local-token}"
API_PORT="${API_PORT:-8080}"
API_BASE_URL="${SHEJANE_CLOUD_BASE_URL:-http://localhost:${API_PORT}}"
LOCAL_HOST_PORT="${SHEJANE_LOCAL_HOST_PORT:-17371}"
LOCAL_HOST_URL="${SHEJANE_LOCAL_HOST_URL:-http://127.0.0.1:${LOCAL_HOST_PORT}}"
CLIENT_DEV_PORT="${CLIENT_DEV_PORT:-55173}"
CLIENT_DEV_URL="${ELECTRON_DEV_URL:-http://127.0.0.1:${CLIENT_DEV_PORT}}"

PIDS=()

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
  local package_dir="$1"
  if [[ ! -d "${package_dir}/node_modules" ]]; then
    echo "Installing dependencies in ${package_dir}"
    (cd "$package_dir" && npm install)
  fi
}

ensure_connector_resources() {
  echo "Preparing bundled connector resources"
  (cd "${ROOT_DIR}/client" && npm run prepare:connectors && npm run verify:connectors)
}

force_kill_stragglers() {
  # Hard-restart prelude. Each `make dev-electron` does a full clean
  # restart by default — we kill any lingering daemon/vite/electron
  # processes AND free their ports before launching new ones. Without
  # this, a previous session's daemon that survived SIGTERM (the
  # default kill signal trap'd by uvicorn / Electron) stays bound to
  # 17371 with stale code, and `start_local_host`'s "already running"
  # short-circuit silently masks the fact that your latest code edits
  # never loaded. Spent hours on 2026-05-22 chasing that ghost.
  #
  # Opt out with `SHEJANE_DEV_REUSE=1 make dev-electron` if you
  # genuinely want to attach to an existing daemon (e.g. you started
  # it manually with custom env).
  if [[ "${SHEJANE_DEV_REUSE:-0}" == "1" ]]; then
    echo "[dev-electron] SHEJANE_DEV_REUSE=1 — keeping existing processes"
    return
  fi

  echo "[dev-electron] hard-restart: killing stragglers"
  # SIGKILL (-9) is non-negotiable — SIGTERM lets daemons trap and
  # finish in-flight work, which is exactly what kept happening.
  pkill -9 -f 'python -m local_host' >/dev/null 2>&1 || true
  pkill -9 -f 'electron/main\.cjs' >/dev/null 2>&1 || true
  pkill -9 -f "vite.*--port (${CLIENT_DEV_PORT}|${ADMIN_PORT:-5174})" \
    >/dev/null 2>&1 || true
  # Free the daemon + Vite ports specifically. API_PORT/POSTGRES_PORT
  # are docker-managed; don't touch them.
  for port in "$LOCAL_HOST_PORT" "$CLIENT_DEV_PORT"; do
    local pids
    pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      echo "[dev-electron] freeing port ${port} (pids: ${pids})"
      # shellcheck disable=SC2086
      kill -9 $pids >/dev/null 2>&1 || true
    fi
  done
  # Give the kernel a beat to release the sockets.
  sleep 1
}

open_log_tail_terminal() {
  # Spawn a separate Terminal.app window/tab tailing the daemon log so
  # the user can watch agent progress while interacting with Electron.
  # macOS-only; on other OSes this is a no-op and the user can run
  # `make logs-local-host` manually.
  #
  # Opt out with `SHEJANE_DEV_LOG_TAIL=0`.
  [[ "${SHEJANE_DEV_LOG_TAIL:-1}" == "1" ]] || return 0
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  local log="${LOG_DIR}/local-host.log"
  # Touch the file so `tail -F` doesn't complain on a never-written
  # log path (it always exists once daemon starts, but the AppleScript
  # racing daemon startup is real).
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

start_cloud_stack() {
  if [[ "${SKIP_DOCKER:-}" == "1" ]]; then
    echo "Skipping Docker startup because SKIP_DOCKER=1"
    wait_for_url "${API_BASE_URL}/health" "API"
    return
  fi

  require_command docker
  if ! docker info >/dev/null 2>&1; then
    echo "Docker daemon is not reachable. Start Docker Desktop or rerun with SKIP_DOCKER=1 if your API is already running." >&2
    exit 2
  fi

  echo "Starting cloud control plane with Docker Compose in detached mode"
  (cd "$ROOT_DIR" && docker compose up -d --build)
  wait_for_url "${API_BASE_URL}/health" "API"
}

start_local_host() {
  if curl -fsS "${LOCAL_HOST_URL}/local/v1/health" >/dev/null 2>&1; then
    echo "Local Host already running at ${LOCAL_HOST_URL}"
    return
  fi

  local log_file="${LOG_DIR}/local-host.log"
  echo "Starting Local Agent Harness (Python / LangGraph) at ${LOCAL_HOST_URL}"
  (
    cd "${ROOT_DIR}/local-host/python"
    # We keep the env -i sandbox + selective forwarding for parity with
    # the old Node daemon, but the entry point is now `uv run python -m
    # local_host` (Phase 5'+).
    local env_cmd=(
      env -i
      "PATH=$PATH"
      "HOME=$HOME"
      "USER=${USER:-}"
      "TMPDIR=${TMPDIR:-/tmp}"
      "SHELL=${SHELL:-/bin/zsh}"
      "SHEJANE_LOCAL_HOST_TOKEN=$TOKEN"
      "SHEJANE_LOCAL_HOST_PORT=$LOCAL_HOST_PORT"
      "SHEJANE_LOCAL_HOST_URL=$LOCAL_HOST_URL"
      "SHEJANE_LOCAL_DESKTOP_RESOURCES_PATH=${ROOT_DIR}/client/electron"
      "SHEJANE_CLOUD_BASE_URL=$API_BASE_URL"
      "PYTHONUNBUFFERED=1"
    )
    # Pairing / cloud (host addr override, cloud token, MCP servers).
    [[ -n "${SHEJANE_LOCAL_HOST_ADDR:-}" ]] && env_cmd+=("SHEJANE_LOCAL_HOST_ADDR=$SHEJANE_LOCAL_HOST_ADDR")
    [[ -n "${SHEJANE_CLOUD_TOKEN:-}" ]] && env_cmd+=("SHEJANE_CLOUD_TOKEN=$SHEJANE_CLOUD_TOKEN")
    [[ -n "${SHEJANE_LOCAL_MCP_SERVERS:-}" ]] && env_cmd+=("SHEJANE_LOCAL_MCP_SERVERS=$SHEJANE_LOCAL_MCP_SERVERS")
    [[ -n "${SHEJANE_LOCAL_SKILLS_PATH:-}" ]] && env_cmd+=("SHEJANE_LOCAL_SKILLS_PATH=$SHEJANE_LOCAL_SKILLS_PATH")

    # Middleware tuning — every SHEJANE_LOCAL_* / SHEJANE_PLAN_FIRST that
    # the Python config layer reads. Stays in lockstep with .env so editing
    # values actually takes effect in the subprocess.
    [[ -n "${SHEJANE_LOCAL_INPUT_GUARD:-}" ]] && env_cmd+=("SHEJANE_LOCAL_INPUT_GUARD=$SHEJANE_LOCAL_INPUT_GUARD")
    [[ -n "${SHEJANE_PLAN_FIRST:-}" ]] && env_cmd+=("SHEJANE_PLAN_FIRST=$SHEJANE_PLAN_FIRST")
    [[ -n "${SHEJANE_LOCAL_TOOL_CRITIC:-}" ]] && env_cmd+=("SHEJANE_LOCAL_TOOL_CRITIC=$SHEJANE_LOCAL_TOOL_CRITIC")
    [[ -n "${SHEJANE_LOCAL_CRITIC:-}" ]] && env_cmd+=("SHEJANE_LOCAL_CRITIC=$SHEJANE_LOCAL_CRITIC")
    [[ -n "${SHEJANE_LOCAL_TOOL_SELECTOR_MAX:-}" ]] && env_cmd+=("SHEJANE_LOCAL_TOOL_SELECTOR_MAX=$SHEJANE_LOCAL_TOOL_SELECTOR_MAX")
    [[ -n "${SHEJANE_LOCAL_FALLBACK_MODELS:-}" ]] && env_cmd+=("SHEJANE_LOCAL_FALLBACK_MODELS=$SHEJANE_LOCAL_FALLBACK_MODELS")
    [[ -n "${SHEJANE_LOCAL_PII_REDACT:-}" ]] && env_cmd+=("SHEJANE_LOCAL_PII_REDACT=$SHEJANE_LOCAL_PII_REDACT")
    [[ -n "${SHEJANE_LOCAL_MEMORY_PATHS:-}" ]] && env_cmd+=("SHEJANE_LOCAL_MEMORY_PATHS=$SHEJANE_LOCAL_MEMORY_PATHS")

    # NO platform-paid provider keys are forwarded to the daemon:
    #   • image.* routes through `/api/v1/agent/tools/execute`; the
    #     OpenAI key lives in the API's model registry (Admin-configured).
    #   • web.search routes through the same gateway; the Tavily key
    #     lives in the API's env (section E of root .env).
    # If you need to add a new platform-paid tool, add a proxy in
    # `local_host/tools/<tool>.py` via `_gateway.call_tool_gateway`,
    # NOT a key forward here.

    # Observability — LangSmith (LangChain-native), Langfuse (alternative),
    # and the hard kill-switch flag.
    [[ -n "${LANGSMITH_TRACING:-}" ]] && env_cmd+=("LANGSMITH_TRACING=$LANGSMITH_TRACING")
    [[ -n "${LANGSMITH_ENDPOINT:-}" ]] && env_cmd+=("LANGSMITH_ENDPOINT=$LANGSMITH_ENDPOINT")
    [[ -n "${LANGSMITH_API_KEY:-}" ]] && env_cmd+=("LANGSMITH_API_KEY=$LANGSMITH_API_KEY")
    [[ -n "${LANGSMITH_PROJECT:-}" ]] && env_cmd+=("LANGSMITH_PROJECT=$LANGSMITH_PROJECT")
    [[ -n "${LANGFUSE_PUBLIC_KEY:-}" ]] && env_cmd+=("LANGFUSE_PUBLIC_KEY=$LANGFUSE_PUBLIC_KEY")
    [[ -n "${LANGFUSE_SECRET_KEY:-}" ]] && env_cmd+=("LANGFUSE_SECRET_KEY=$LANGFUSE_SECRET_KEY")
    [[ -n "${SHEJANE_DISABLE_OBSERVABILITY:-}" ]] && env_cmd+=("SHEJANE_DISABLE_OBSERVABILITY=$SHEJANE_DISABLE_OBSERVABILITY")
    "${env_cmd[@]}" uv run python -m local_host >"$log_file" 2>&1
  ) &
  PIDS+=("$!")
  wait_for_url "${LOCAL_HOST_URL}/local/v1/health" "Local Host" "$log_file"
}

start_client_dev_server() {
  if curl -fsS "$CLIENT_DEV_URL" >/dev/null 2>&1; then
    echo "Client dev server already running at ${CLIENT_DEV_URL}"
    return
  fi

  local log_file="${LOG_DIR}/client-vite.log"
  echo "Starting client dev server at ${CLIENT_DEV_URL}"
  (
    cd "${ROOT_DIR}/client"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "USER=${USER:-}" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "SHELL=${SHELL:-/bin/zsh}" \
      "VITE_API_BASE_URL=$API_BASE_URL" \
      npm run dev -- --host 127.0.0.1 --port "$CLIENT_DEV_PORT" >"$log_file" 2>&1
  ) &
  PIDS+=("$!")
  wait_for_url "$CLIENT_DEV_URL" "client dev server" "$log_file"
}

launch_electron() {
  echo "Launching Electron. Close the app window to stop local dev helper processes."
  (
    cd "${ROOT_DIR}/client"
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
      "VITE_API_BASE_URL=$API_BASE_URL" \
      npm run electron
  ) &
  local electron_pid="$!"
  PIDS+=("$electron_pid")
  wait "$electron_pid"
}

main() {
  require_command curl
  require_command npm
  require_command uv
  mkdir -p "$LOG_DIR"
  ensure_node_modules "${ROOT_DIR}/client"
  ensure_connector_resources

  # Hard restart: kill any leftover daemon/vite/electron + free ports
  # FIRST, so the rest of the script can assume a clean slate. Opt out
  # with SHEJANE_DEV_REUSE=1.
  force_kill_stragglers

  start_cloud_stack
  start_local_host
  start_client_dev_server
  # Spawn the log-tail Terminal AFTER daemon is up (so the file exists
  # and tail -F has something real to follow) but BEFORE blocking on
  # Electron — otherwise the tail window opens only after the user
  # closes the app, which defeats the purpose.
  open_log_tail_terminal
  launch_electron
}

main "$@"
