#!/usr/bin/env bash
# Run the Desktop ↔ Runtime contract suite over real HTTP on an isolated port.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${CONTRACT_LOCAL_HOST_PORT:-17399}"
TOKEN="${CONTRACT_LOCAL_HOST_TOKEN:-contract-token}"
URL="http://127.0.0.1:${PORT}"
TMP_DIR="$(mktemp -d)"
LOG_FILE="${TMP_DIR}/contract-daemon.log"
PID_FILE="${TMP_DIR}/contract-daemon.pid"
DATA_DIR="${TMP_DIR}/data"
HOME_DIR="${TMP_DIR}/home"
BIN_DIR="${TMP_DIR}/bin"
mkdir -p "$DATA_DIR" "$HOME_DIR" "$BIN_DIR"
ln -s "$(command -v true)" "$BIN_DIR/pbcopy"
ln -s "$(command -v true)" "$BIN_DIR/pbpaste"

DAEMON_PID=""
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$DAEMON_PID" ]]; then
    kill -9 "$DAEMON_PID" 2>/dev/null || true
  fi
  lsof -ti :"$PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  if [[ $status -ne 0 && -f "$LOG_FILE" ]]; then
    echo "Runtime log:" >&2
    tail -80 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT

if lsof -ti :"$PORT" >/dev/null 2>&1; then
  echo "→ Freeing stale process on :$PORT"
  lsof -ti :"$PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  sleep 1
fi

if [[ ! -d node_modules/.pnpm ]]; then
  echo "→ workspace dependencies missing — running pnpm install"
  pnpm install --frozen-lockfile
fi

echo "→ Starting contract daemon at ${URL}"
(
  cd "${ROOT_DIR}/services/runtime"
  nohup env -i \
    "PATH=$BIN_DIR:$PATH" "HOME=$HOME_DIR" "USER=${USER:-}" "TMPDIR=${TMPDIR:-/tmp}" \
    "SHEJANE_FAKE_LLM=1" \
    "LANGSMITH_TRACING=false" \
    "LANGCHAIN_TRACING_V2=false" \
    "PYTHONUNBUFFERED=1" \
    uv run shejane-runtime --host 127.0.0.1 --port "$PORT" \
      --token "$TOKEN" --data-dir "$DATA_DIR" >"$LOG_FILE" 2>&1 &
  echo "$!" >"$PID_FILE"
)
DAEMON_PID="$(cat "$PID_FILE")"

echo "→ Waiting for ${URL}/local/v1/health"
for _ in $(seq 1 60); do
  if curl -fsS "${URL}/local/v1/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "${READY:-0}" != "1" ]]; then
  echo "❌ Contract daemon failed to start" >&2
  tail -80 "$LOG_FILE" >&2 || true
  exit 1
fi

echo "→ Running client contract suite"
(
  cd apps/desktop
  VITE_TEST_LOCAL_HOST_URL="$URL" \
  VITE_TEST_LOCAL_HOST_TOKEN="$TOKEN" \
  pnpm test:contract
)
echo "✅ Contract suite passed"
