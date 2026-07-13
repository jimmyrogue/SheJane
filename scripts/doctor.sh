#!/usr/bin/env bash
# `make doctor` — single command that answers "why isn't dev working?".
#
# Built to compress the painful 2026-05-22 debug session into 5 seconds:
# stale daemon processes binding 17371 with old code, OPENAI/TAVILY
# keys leaking into the daemon env, cloud session not paired, LangSmith
# key invalid, Docker down. Each row prints one of:
#   ✅  expected state, nothing to do
#   ⚠️  unexpected but non-blocking
#   ❌  blocking — won't work until fixed
#
# Exit 0 always: this is diagnostic, not a gate. Use the human output.

set -u  # `-e` deliberately off — keep checking even when one row fails.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Load .env so we know what the user expects to be set (without leaking
# real values into output). We only read keys for presence; values stay
# in this subshell.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env 2>/dev/null || true
  set +a
fi

row() {
  # row <status> <label> <detail>
  local status="$1" label="$2" detail="${3:-}"
  printf '  %s %-32s %s\n' "$status" "$label" "$detail"
}

section() {
  printf '\n\033[1m%s\033[0m\n' "$1"
}

# ---------------------------------------------------------------------------
section "🐳  Docker daemon"
if docker info >/dev/null 2>&1; then
  row "✅" "running" "$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
else
  row "❌" "down" "→ run 'open -a Docker' or set SKIP_DOCKER=1"
fi

# ---------------------------------------------------------------------------
section "🐍  Local-host daemon (port 17371)"
DAEMON_PID="$(lsof -ti :17371 2>/dev/null | head -1 || true)"
if [[ -z "$DAEMON_PID" ]]; then
  row "❌" "not running" "→ make dev-electron"
else
  STARTED="$(ps -p "$DAEMON_PID" -o lstart= 2>/dev/null | xargs || echo unknown)"
  row "✅" "PID $DAEMON_PID" "started: $STARTED"

  HEALTH_JSON="$(curl -fsS --max-time 2 http://127.0.0.1:17371/local/v1/health 2>/dev/null || true)"
  if [[ -n "$HEALTH_JSON" ]]; then
    if echo "$HEALTH_JSON" | grep -q '"status":"ok"'; then
      row "✅" "health shape (post-Block-0)" "status=ok mode=ready"
    else
      row "⚠️" "health shape" "old daemon? expected status=ok in body"
    fi
    if echo "$HEALTH_JSON" | grep -q '"pairing_configured":true'; then
      row "✅" "pairing token configured" ""
    else
      row "⚠️" "no pairing token" "SHEJANE_LOCAL_HOST_TOKEN empty"
    fi
  else
    row "❌" "health endpoint" "/local/v1/health didn't respond"
  fi

  # Check forbidden keys haven't leaked into the daemon's process env.
  # `ps eww` reads the process's environment block.
  DAEMON_ENV="$(ps eww -p "$DAEMON_PID" 2>/dev/null | tr ' ' '\n' || true)"
  LEAKS=()
  for forbidden in OPENAI_API_KEY TAVILY_API_KEY ANTHROPIC_API_KEY \
                   AWS_ACCESS_KEY_ID STRIPE_SECRET_KEY JWT_SECRET; do
    if echo "$DAEMON_ENV" | grep -q "^${forbidden}="; then
      LEAKS+=("$forbidden")
    fi
  done
  if [[ ${#LEAKS[@]} -eq 0 ]]; then
    row "✅" "no platform keys in env" "OPENAI/TAVILY/ANTHROPIC/AWS/STRIPE/JWT clean"
  else
    row "❌" "platform keys leaked" "${LEAKS[*]} — should live in API only"
  fi

  # Cloud session paired? Required for any tool that proxies through
  # /api/v1/agent/tools/execute (image.*, web.search).
  SESSION_JSON="$(curl -fsS --max-time 2 \
    -H "Authorization: Bearer ${SHEJANE_LOCAL_HOST_TOKEN:-dev-local-token}" \
    http://127.0.0.1:17371/local/v1/session 2>/dev/null || true)"
  if echo "$SESSION_JSON" | grep -q '"connected":true'; then
    row "✅" "cloud session paired" "image.*/web.search will work"
  else
    row "⚠️" "cloud session NOT paired" "→ login in Electron OR Cmd+R refresh"
  fi
fi

# ---------------------------------------------------------------------------
section "☁️  Cloud API (port 8080)"
if curl -fsS --max-time 2 "${SHEJANE_CLOUD_BASE_URL:-http://localhost:8080}/health" >/dev/null 2>&1; then
  row "✅" "reachable" "${SHEJANE_CLOUD_BASE_URL:-http://localhost:8080}/health"
else
  row "❌" "down" "→ docker compose up -d (or check api-1 container logs)"
fi

# ---------------------------------------------------------------------------
section "📊  Observability — LangSmith"
if [[ "${LANGSMITH_TRACING:-}" == "true" ]]; then
  if [[ -n "${LANGSMITH_API_KEY:-}" ]]; then
    # Quick auth probe — the /info endpoint requires a valid key.
    if curl -fsS --max-time 3 -H "X-API-Key: $LANGSMITH_API_KEY" \
       "${LANGSMITH_ENDPOINT:-https://api.smith.langchain.com}/info" >/dev/null 2>&1; then
      row "✅" "key valid" "project=${LANGSMITH_PROJECT:-default}"
    else
      row "❌" "key rejected" "401 from LangSmith — regenerate at smith.langchain.com"
    fi
  else
    row "⚠️" "TRACING=true but no key" "LANGSMITH_API_KEY empty"
  fi
else
  row "⚠️" "disabled" "LANGSMITH_TRACING != true (traces NOT uploaded)"
fi

# ---------------------------------------------------------------------------
section "🛠  Dev ports"
# Bash 3.2 (macOS default) has no associative arrays — keep a parallel
# array via `case`. Inline labels avoid an awkward `$(case ...)` that
# breaks on paren-containing strings.
port_label() {
  case "$1" in
    17371) echo "local-host daemon" ;;
    55173) echo "client vite dev server" ;;
    8080)  echo "API container port-forward" ;;
    5174)  echo "admin vite dev server" ;;
    *)     echo "" ;;
  esac
}
for port in 17371 55173 8080 5174; do
  PIDS="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [[ -n "$PIDS" ]]; then
    row "✅" "port $port" "$(port_label "$port") - pids $PIDS"
  fi
done

# ---------------------------------------------------------------------------
section "📁  Dependencies"
for path in client apps/admin services/runtime; do
  case "$path" in
    services/runtime)
      [[ -d "$path/.venv" ]] && row "✅" "$path" "uv venv ready" \
        || row "❌" "$path" "→ cd $path && uv sync"
      ;;
    *)
      [[ -d "$path/node_modules" ]] && row "✅" "$path" "pnpm links ready" \
        || row "❌" "$path" "→ pnpm install"
      ;;
  esac
done

echo
echo "Done. Anything ❌ blocks dev; ⚠️ is worth fixing before testing."
