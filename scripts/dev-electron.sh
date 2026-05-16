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

LOG_DIR="${JIANDANLY_DEV_LOG_DIR:-${ROOT_DIR}/.tmp/dev}"
TOKEN="${JIANDANLY_LOCAL_HOST_TOKEN:-dev-local-token}"
API_PORT="${API_PORT:-8080}"
API_BASE_URL="${JIANDANLY_CLOUD_BASE_URL:-http://localhost:${API_PORT}}"
LOCAL_HOST_PORT="${JIANDANLY_LOCAL_HOST_PORT:-17371}"
LOCAL_HOST_URL="${JIANDANLY_LOCAL_HOST_URL:-http://127.0.0.1:${LOCAL_HOST_PORT}}"
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
  echo "Starting Local Agent Harness at ${LOCAL_HOST_URL}"
  (
    cd "${ROOT_DIR}/local-host"
    local env_cmd=(
      env -i
      "PATH=$PATH"
      "HOME=$HOME"
      "USER=${USER:-}"
      "TMPDIR=${TMPDIR:-/tmp}"
      "SHELL=${SHELL:-/bin/zsh}"
      "JIANDANLY_LOCAL_HOST_TOKEN=$TOKEN"
      "JIANDANLY_LOCAL_HOST_PORT=$LOCAL_HOST_PORT"
      "JIANDANLY_LOCAL_HOST_URL=$LOCAL_HOST_URL"
      "JIANDANLY_CLOUD_BASE_URL=$API_BASE_URL"
      "JIANDANLY_LOCAL_HOST_DEBUG=${JIANDANLY_LOCAL_HOST_DEBUG:-1}"
    )
    [[ -n "${JIANDANLY_LOCAL_HOST_DB:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_HOST_DB=$JIANDANLY_LOCAL_HOST_DB")
    [[ -n "${JIANDANLY_LOCAL_HOST_ADDR:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_HOST_ADDR=$JIANDANLY_LOCAL_HOST_ADDR")
    [[ -n "${JIANDANLY_BROWSER_ENGINE:-}" ]] && env_cmd+=("JIANDANLY_BROWSER_ENGINE=$JIANDANLY_BROWSER_ENGINE")
    [[ -n "${JIANDANLY_BROWSER_HEADLESS:-}" ]] && env_cmd+=("JIANDANLY_BROWSER_HEADLESS=$JIANDANLY_BROWSER_HEADLESS")
    [[ -n "${JIANDANLY_BROWSER_TIMEOUT_MS:-}" ]] && env_cmd+=("JIANDANLY_BROWSER_TIMEOUT_MS=$JIANDANLY_BROWSER_TIMEOUT_MS")
    [[ -n "${JIANDANLY_BROWSER_SEARCH_URL:-}" ]] && env_cmd+=("JIANDANLY_BROWSER_SEARCH_URL=$JIANDANLY_BROWSER_SEARCH_URL")
    [[ -n "${JIANDANLY_ALLOW_PROXY_FAKE_IPS:-}" ]] && env_cmd+=("JIANDANLY_ALLOW_PROXY_FAKE_IPS=$JIANDANLY_ALLOW_PROXY_FAKE_IPS")
    [[ -n "${JIANDANLY_LOCAL_MAX_STEPS:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_MAX_STEPS=$JIANDANLY_LOCAL_MAX_STEPS")
    [[ -n "${JIANDANLY_LOCAL_STEP_WARNING_INTERVAL:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_STEP_WARNING_INTERVAL=$JIANDANLY_LOCAL_STEP_WARNING_INTERVAL")
    # Agentic Design Patterns Phase 1-4 feature flags (default off; only
    # forwarded when explicitly set so the env -i sandbox keeps defaults).
    [[ -n "${JIANDANLY_LOCAL_INPUT_GUARD:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_INPUT_GUARD=$JIANDANLY_LOCAL_INPUT_GUARD")
    [[ -n "${JIANDANLY_LOCAL_TOOL_RETRY:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_TOOL_RETRY=$JIANDANLY_LOCAL_TOOL_RETRY")
    [[ -n "${JIANDANLY_LOCAL_TOOL_RETRY_BASE_MS:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_TOOL_RETRY_BASE_MS=$JIANDANLY_LOCAL_TOOL_RETRY_BASE_MS")
    [[ -n "${JIANDANLY_LOCAL_TOOL_FAILURE_LIMIT:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_TOOL_FAILURE_LIMIT=$JIANDANLY_LOCAL_TOOL_FAILURE_LIMIT")
    [[ -n "${JIANDANLY_LOCAL_PLANNING:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_PLANNING=$JIANDANLY_LOCAL_PLANNING")
    [[ -n "${JIANDANLY_LOCAL_PLANNING_MODEL:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_PLANNING_MODEL=$JIANDANLY_LOCAL_PLANNING_MODEL")
    [[ -n "${JIANDANLY_LOCAL_PLANNING_CONFIRM:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_PLANNING_CONFIRM=$JIANDANLY_LOCAL_PLANNING_CONFIRM")
    [[ -n "${JIANDANLY_LOCAL_REFLECTION:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_REFLECTION=$JIANDANLY_LOCAL_REFLECTION")
    [[ -n "${JIANDANLY_LOCAL_REFLECTION_MODEL:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_REFLECTION_MODEL=$JIANDANLY_LOCAL_REFLECTION_MODEL")
    [[ -n "${JIANDANLY_LOCAL_REFLECTION_MIN_CHARS:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_REFLECTION_MIN_CHARS=$JIANDANLY_LOCAL_REFLECTION_MIN_CHARS")
    [[ -n "${JIANDANLY_LOCAL_REFLECTION_MAX_ITERS:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_REFLECTION_MAX_ITERS=$JIANDANLY_LOCAL_REFLECTION_MAX_ITERS")
    "${env_cmd[@]}" npm run dev >"$log_file" 2>&1
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
      "JIANDANLY_LOCAL_HOST_URL=$LOCAL_HOST_URL" \
      "JIANDANLY_LOCAL_HOST_TOKEN=$TOKEN" \
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
  mkdir -p "$LOG_DIR"
  ensure_node_modules "${ROOT_DIR}/client"
  ensure_node_modules "${ROOT_DIR}/local-host"

  start_cloud_stack
  start_local_host
  start_client_dev_server
  launch_electron
}

main "$@"
