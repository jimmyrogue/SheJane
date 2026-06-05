#!/usr/bin/env bash
# Hard-restart ONLY the Python Local Agent Harness daemon.
#
# The #1 cause of "I edited Python but the behavior didn't change" is a
# stale daemon still bound to :17371 with old code in memory. uvicorn
# traps SIGTERM and can survive `pkill`, so this script kills by PORT
# (lsof -ti), not by process name, then respawns on the SAME safe env
# the full dev launcher uses.
#
# Use this instead of `make dev-electron` when ONLY the daemon changed —
# it's seconds, not a full Docker + Vite + Electron relaunch. After it
# finishes, Cmd+R the Electron window so the renderer re-pairs (the
# restart wiped the daemon's in-memory cloud_token).
#
# SAFETY (CLAUDE.md Invariant #1): the daemon is spawned under `env -i`
# with an explicit allowlist — NO platform-paid provider keys (OpenAI /
# Tavily / Anthropic / Stripe / AWS / E2B) are forwarded. Those live in
# the Go API only; the daemon proxies through the cloud Tool Gateway.
# This mirrors scripts/dev-electron.sh exactly. (Do NOT `source .env`
# straight into the daemon's environment — that would leak the keys.)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Populate the shell with .env values so the selective-forward block
# below can see JIANDANLY_LOCAL_* / LANGSMITH_* etc. The daemon itself
# is still launched with `env -i` + allowlist, so platform keys present
# here never reach it.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

API_PORT="${API_PORT:-8080}"
TOKEN="${JIANDANLY_LOCAL_HOST_TOKEN:-dev-local-token}"
API_BASE_URL="${JIANDANLY_CLOUD_BASE_URL:-http://localhost:${API_PORT}}"
LOCAL_HOST_PORT="${JIANDANLY_LOCAL_HOST_PORT:-17371}"
LOCAL_HOST_URL="${JIANDANLY_LOCAL_HOST_URL:-http://127.0.0.1:${LOCAL_HOST_PORT}}"
LOG_DIR="${JIANDANLY_DEV_LOG_DIR:-${ROOT_DIR}/.tmp/dev}"
LOG_FILE="${LOG_DIR}/local-host.log"
mkdir -p "$LOG_DIR"

# 1. Report what's currently bound (so the user sees what was stale).
OLD_PID="$(lsof -ti :"$LOCAL_HOST_PORT" 2>/dev/null | head -1 || true)"
if [[ -n "$OLD_PID" ]]; then
  echo "→ Old daemon PID $OLD_PID started: $(ps -p "$OLD_PID" -o lstart= 2>/dev/null || echo unknown)"
else
  echo "→ No daemon currently bound to :$LOCAL_HOST_PORT"
fi

# 2. Kill by PORT (not process name) and confirm the port is free.
lsof -ti :"$LOCAL_HOST_PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
for _ in $(seq 1 10); do
  lsof -ti :"$LOCAL_HOST_PORT" >/dev/null 2>&1 || break
  sleep 0.5
done
if lsof -ti :"$LOCAL_HOST_PORT" >/dev/null 2>&1; then
  echo "❌ Port :$LOCAL_HOST_PORT still bound after kill -9. Check 'lsof -i :$LOCAL_HOST_PORT'." >&2
  exit 1
fi

# 3. Respawn under env -i + allowlist (parity with dev-electron.sh).
echo "→ Starting Local Agent Harness at ${LOCAL_HOST_URL}"
(
  cd "${ROOT_DIR}/local-host/python"
  env_cmd=(
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
    "PYTHONUNBUFFERED=1"
  )
  # Pairing / cloud + skills / MCP (forward only if set).
  [[ -n "${JIANDANLY_LOCAL_HOST_ADDR:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_HOST_ADDR=$JIANDANLY_LOCAL_HOST_ADDR")
  [[ -n "${JIANDANLY_CLOUD_TOKEN:-}" ]] && env_cmd+=("JIANDANLY_CLOUD_TOKEN=$JIANDANLY_CLOUD_TOKEN")
  [[ -n "${JIANDANLY_LOCAL_MCP_SERVERS:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_MCP_SERVERS=$JIANDANLY_LOCAL_MCP_SERVERS")
  [[ -n "${JIANDANLY_LOCAL_SKILLS_PATH:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_SKILLS_PATH=$JIANDANLY_LOCAL_SKILLS_PATH")
  # Middleware tuning.
  [[ -n "${JIANDANLY_LOCAL_INPUT_GUARD:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_INPUT_GUARD=$JIANDANLY_LOCAL_INPUT_GUARD")
  [[ -n "${JIANDANLY_PLAN_FIRST:-}" ]] && env_cmd+=("JIANDANLY_PLAN_FIRST=$JIANDANLY_PLAN_FIRST")
  [[ -n "${JIANDANLY_LOCAL_TOOL_CRITIC:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_TOOL_CRITIC=$JIANDANLY_LOCAL_TOOL_CRITIC")
  [[ -n "${JIANDANLY_LOCAL_CRITIC:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_CRITIC=$JIANDANLY_LOCAL_CRITIC")
  [[ -n "${JIANDANLY_LOCAL_TOOL_SELECTOR_MAX:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_TOOL_SELECTOR_MAX=$JIANDANLY_LOCAL_TOOL_SELECTOR_MAX")
  [[ -n "${JIANDANLY_LOCAL_FALLBACK_MODELS:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_FALLBACK_MODELS=$JIANDANLY_LOCAL_FALLBACK_MODELS")
  [[ -n "${JIANDANLY_LOCAL_PII_REDACT:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_PII_REDACT=$JIANDANLY_LOCAL_PII_REDACT")
  [[ -n "${JIANDANLY_LOCAL_MEMORY_PATHS:-}" ]] && env_cmd+=("JIANDANLY_LOCAL_MEMORY_PATHS=$JIANDANLY_LOCAL_MEMORY_PATHS")
  # Observability.
  [[ -n "${LANGSMITH_TRACING:-}" ]] && env_cmd+=("LANGSMITH_TRACING=$LANGSMITH_TRACING")
  [[ -n "${LANGSMITH_ENDPOINT:-}" ]] && env_cmd+=("LANGSMITH_ENDPOINT=$LANGSMITH_ENDPOINT")
  [[ -n "${LANGSMITH_API_KEY:-}" ]] && env_cmd+=("LANGSMITH_API_KEY=$LANGSMITH_API_KEY")
  [[ -n "${LANGSMITH_PROJECT:-}" ]] && env_cmd+=("LANGSMITH_PROJECT=$LANGSMITH_PROJECT")
  [[ -n "${LANGFUSE_PUBLIC_KEY:-}" ]] && env_cmd+=("LANGFUSE_PUBLIC_KEY=$LANGFUSE_PUBLIC_KEY")
  [[ -n "${LANGFUSE_SECRET_KEY:-}" ]] && env_cmd+=("LANGFUSE_SECRET_KEY=$LANGFUSE_SECRET_KEY")
  [[ -n "${JIANDANLY_DISABLE_OBSERVABILITY:-}" ]] && env_cmd+=("JIANDANLY_DISABLE_OBSERVABILITY=$JIANDANLY_DISABLE_OBSERVABILITY")

  nohup "${env_cmd[@]}" uv run python -m local_host >"$LOG_FILE" 2>&1 &
  echo "$!" >"${LOG_DIR}/local-host.pid"
)

# 4. Wait for health.
for _ in $(seq 1 60); do
  if curl -fsS "${LOCAL_HOST_URL}/local/v1/health" >/dev/null 2>&1; then
    NEW_PID="$(lsof -ti :"$LOCAL_HOST_PORT" 2>/dev/null | head -1 || true)"
    echo "✅ Daemon up. New PID ${NEW_PID:-?} started: $(ps -p "${NEW_PID:-0}" -o lstart= 2>/dev/null || echo now)"
    echo "   Logs: make logs-local-host   (file: $LOG_FILE)"
    echo "   👉 Now Cmd+R the Electron window so the renderer re-pairs (cloud_token was reset)."
    exit 0
  fi
  sleep 1
done

echo "❌ Daemon failed to become healthy at ${LOCAL_HOST_URL}/local/v1/health" >&2
echo "Last 80 log lines:" >&2
tail -80 "$LOG_FILE" >&2 || true
exit 1
