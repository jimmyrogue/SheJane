#!/usr/bin/env bash
# `make doctor` — single command that answers "why isn't dev working?".
#
# Built to compress the painful 2026-05-22 debug session into 5 seconds:
# stale Runtime processes, missing workspace dependencies, and secrets
# leaking into the Runtime environment. Each row prints one of:
#   ✅  expected state, nothing to do
#   ⚠️  unexpected but non-blocking
#   ❌  blocking — won't work until fixed
#
# Exit 0 always: this is diagnostic, not a gate. Use the human output.

set -u  # `-e` deliberately off — keep checking even when one row fails.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

row() {
  # row <status> <label> <detail>
  local status="$1" label="$2" detail="${3:-}"
  printf '  %s %-32s %s\n' "$status" "$label" "$detail"
}

section() {
  printf '\n\033[1m%s\033[0m\n' "$1"
}

# ---------------------------------------------------------------------------
section "🐍  Runtime (port 17371)"
DAEMON_PID="$(lsof -ti :17371 2>/dev/null | head -1 || true)"
if [[ -z "$DAEMON_PID" ]]; then
  row "❌" "not running" "→ make dev-electron"
else
  STARTED="$(ps -p "$DAEMON_PID" -o lstart= 2>/dev/null | xargs || echo unknown)"
  row "✅" "PID $DAEMON_PID" "started: $STARTED"

  HEALTH_JSON="$(curl -fsS --max-time 2 http://127.0.0.1:17371/local/v1/health 2>/dev/null || true)"
  if [[ -n "$HEALTH_JSON" ]]; then
    if echo "$HEALTH_JSON" | grep -q '"status":"ok"'; then
      row "✅" "health" "status=ok mode=ready"
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
    row "❌" "secrets leaked" "${LEAKS[*]} — use Runtime credentials or Cloud service env"
  fi

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
    *)     echo "" ;;
  esac
}
for port in 17371 55173; do
  PIDS="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [[ -n "$PIDS" ]]; then
    row "✅" "port $port" "$(port_label "$port") - pids $PIDS"
  fi
done

# ---------------------------------------------------------------------------
section "📁  Dependencies"
for path in node_modules services/runtime; do
  case "$path" in
    services/runtime)
      [[ -d "$path/.venv" ]] && row "✅" "$path" "uv venv ready" \
        || row "❌" "$path" "→ cd $path && uv sync"
      ;;
    *)
      [[ -d "$path/.pnpm" ]] && row "✅" "pnpm workspace" "dependencies ready" \
        || row "❌" "pnpm workspace" "→ pnpm install"
      ;;
  esac
done

echo
echo "Done. Anything ❌ blocks dev; ⚠️ is worth fixing before testing."
