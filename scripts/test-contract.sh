#!/usr/bin/env bash
# Run the Runtime SDK ↔ Runtime contract suite over real HTTP on an isolated port,
# then optionally continue through Runtime recovery and Electron Client E2E.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${CONTRACT_RUNTIME_PORT:-17399}"
TOKEN="${CONTRACT_RUNTIME_TOKEN:-contract-token}"
URL="http://127.0.0.1:${PORT}"
CLIENT_PORT="${CLIENT_E2E_PORT:-55273}"
CLIENT_URL="http://127.0.0.1:${CLIENT_PORT}"
TMP_DIR="$(mktemp -d)"
LOG_FILE="${TMP_DIR}/contract-runtime.log"
CLIENT_LOG_FILE="${TMP_DIR}/client-vite.log"
MCP_HTTP_LOG_FILE="${TMP_DIR}/mcp-http.log"
PLAYWRIGHT_ARTIFACT_DIR="${SHEJANE_E2E_ARTIFACT_DIR:-${ROOT_DIR}/.tmp/e2e-artifacts}"
PID_FILE="${TMP_DIR}/contract-runtime.pid"
DATA_DIR="${TMP_DIR}/data"
HOME_DIR="${TMP_DIR}/home"
BIN_DIR="${TMP_DIR}/bin"
mkdir -p "$DATA_DIR" "$HOME_DIR" "$BIN_DIR"
TRUE_BIN="$(type -P true)"
ln -s "$TRUE_BIN" "$BIN_DIR/pbcopy"
ln -s "$TRUE_BIN" "$BIN_DIR/pbpaste"
ln -s "$TRUE_BIN" "$BIN_DIR/xclip"
ln -s "$TRUE_BIN" "$BIN_DIR/open"
ln -s "$TRUE_BIN" "$BIN_DIR/xdg-open"

RUNTIME_PID=""
CLIENT_PID=""
MCP_HTTP_PID=""
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$RUNTIME_PID" ]]; then
    kill -9 "$RUNTIME_PID" 2>/dev/null || true
    wait "$RUNTIME_PID" 2>/dev/null || true
  fi
  if [[ -n "$CLIENT_PID" ]]; then
    kill "$CLIENT_PID" 2>/dev/null || true
    wait "$CLIENT_PID" 2>/dev/null || true
  fi
  if [[ -n "$MCP_HTTP_PID" ]]; then
    kill "$MCP_HTTP_PID" 2>/dev/null || true
    wait "$MCP_HTTP_PID" 2>/dev/null || true
  fi
  lsof -ti :"$PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  for _ in $(seq 1 50); do
    if ! lsof -ti :"$PORT" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  if [[ $status -ne 0 && -f "$LOG_FILE" ]]; then
    echo "Runtime log:" >&2
    tail -80 "$LOG_FILE" >&2 || true
  fi
  for _ in $(seq 1 10); do
    rm -rf "$TMP_DIR" 2>/dev/null || true
    if [[ ! -e "$TMP_DIR" ]]; then
      break
    fi
    sleep 0.1
  done
  if [[ -e "$TMP_DIR" ]]; then
    echo "❌ E2E temporary directory is still in use: $TMP_DIR" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT

if lsof -ti :"$PORT" >/dev/null 2>&1; then
  echo "→ Freeing stale process on :$PORT"
  lsof -ti :"$PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  for _ in $(seq 1 50); do
    if ! lsof -ti :"$PORT" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  if lsof -ti :"$PORT" >/dev/null 2>&1; then
    echo "❌ Could not free stale process on :$PORT" >&2
    exit 1
  fi
fi

if [[ ! -d node_modules/.pnpm ]]; then
  echo "→ workspace dependencies missing — running pnpm install"
  pnpm install --frozen-lockfile
fi

MCP_HTTP_PORT="$(uv run --project "${ROOT_DIR}/runtime" python -c 'import socket; sock = socket.socket(); sock.bind(("127.0.0.1", 0)); print(sock.getsockname()[1]); sock.close()')"
MCP_HTTP_URL="http://127.0.0.1:${MCP_HTTP_PORT}/mcp"
echo "→ Starting stateful MCP HTTP fixture at ${MCP_HTTP_URL}"
uv run --project "${ROOT_DIR}/runtime" \
  python "${ROOT_DIR}/runtime/tests/fixtures/e2e_mcp_http_server.py" \
  --port "$MCP_HTTP_PORT" >"$MCP_HTTP_LOG_FILE" 2>&1 &
MCP_HTTP_PID="$!"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${MCP_HTTP_PORT}/health" >/dev/null 2>&1; then
    MCP_HTTP_READY=1
    break
  fi
  sleep 1
done
if [[ "${MCP_HTTP_READY:-0}" != "1" ]]; then
  echo "❌ MCP HTTP fixture failed to start" >&2
  tail -80 "$MCP_HTTP_LOG_FILE" >&2 || true
  exit 1
fi

echo "→ Starting contract runtime at ${URL}"
(
  cd "${ROOT_DIR}/runtime"
  # Plan-first has its own Runtime tests. This suite isolates HTTP/SSE, SDK,
  # tool, permission, and state contracts with deterministic fake-model calls.
  nohup env -i \
    "PATH=$BIN_DIR:$PATH" "HOME=$HOME_DIR" "USER=${USER:-}" "TMPDIR=${TMPDIR:-/tmp}" \
    "DISPLAY=${DISPLAY:-:99}" \
    "BROWSER=true" \
    "SHEJANE_FAKE_LLM=1" \
    "SHEJANE_PLAN_FIRST=off" \
    "SHEJANE_MCP_TOOL_TIMEOUT_SECONDS=1" \
    "LANGSMITH_TRACING=false" \
    "LANGCHAIN_TRACING_V2=false" \
    "PYTHONUNBUFFERED=1" \
    "${ROOT_DIR}/runtime/.venv/bin/python" -m shejane_runtime \
      --host 127.0.0.1 --port "$PORT" \
      --token "$TOKEN" --data-dir "$DATA_DIR" >"$LOG_FILE" 2>&1 &
  echo "$!" >"$PID_FILE"
)
RUNTIME_PID="$(cat "$PID_FILE")"

echo "→ Waiting for ${URL}/v1/health"
for _ in $(seq 1 60); do
  if curl -fsS "${URL}/v1/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "${READY:-0}" != "1" ]]; then
  echo "❌ Contract runtime failed to start" >&2
  tail -80 "$LOG_FILE" >&2 || true
  exit 1
fi

echo "→ Running Runtime SDK ↔ Runtime contract suite"
(
  cd client
  VITE_TEST_RUNTIME_URL="$URL" \
  VITE_TEST_RUNTIME_TOKEN="$TOKEN" \
  VITE_TEST_MCP_HTTP_URL="$MCP_HTTP_URL" \
  pnpm test:contract
)
if [[ "${SHEJANE_CONTRACT_ONLY:-0}" == "1" ]]; then
  echo "✅ Runtime SDK ↔ Runtime contract suite passed"
  exit 0
fi
echo "→ Running real-process recovery suite"
(
  cd runtime
  SHEJANE_RUN_PROCESS_E2E=1 uv run python -m pytest -q tests/test_process_recovery_e2e.py
)
echo "→ Running official MCP client conformance scenarios"
MCP_CLIENT_COMMAND="uv run --project ${ROOT_DIR}/runtime python ${ROOT_DIR}/runtime/tests/fixtures/e2e_mcp_conformance_client.py"
(
  cd "$TMP_DIR"
  "${ROOT_DIR}/node_modules/.bin/conformance" client --command "$MCP_CLIENT_COMMAND" --scenario initialize
  "${ROOT_DIR}/node_modules/.bin/conformance" client --command "$MCP_CLIENT_COMMAND" --scenario tools_call
  "${ROOT_DIR}/node_modules/.bin/conformance" client --command "$MCP_CLIENT_COMMAND" --scenario sse-retry
)
echo "→ Starting Client renderer at ${CLIENT_URL}"
pnpm --filter @shejane/client exec vite \
  --host 127.0.0.1 --port "$CLIENT_PORT" --strictPort >"$CLIENT_LOG_FILE" 2>&1 &
CLIENT_PID="$!"
for _ in $(seq 1 30); do
  if curl -fsS "$CLIENT_URL" >/dev/null 2>&1; then
    CLIENT_READY=1
    break
  fi
  sleep 1
done
if [[ "${CLIENT_READY:-0}" != "1" ]]; then
  echo "❌ Client renderer failed to start" >&2
  tail -80 "$CLIENT_LOG_FILE" >&2 || true
  exit 1
fi

echo "→ Running Electron critical-path E2E"
SHEJANE_E2E_CLIENT_URL="$CLIENT_URL" \
SHEJANE_E2E_RUNTIME_URL="$URL" \
SHEJANE_E2E_RUNTIME_TOKEN="$TOKEN" \
SHEJANE_E2E_RUNTIME_PID="$RUNTIME_PID" \
SHEJANE_E2E_RUNTIME_DATA_DIR="$DATA_DIR" \
SHEJANE_E2E_RUNTIME_HOME="$HOME_DIR" \
SHEJANE_E2E_RUNTIME_BIN_DIR="$BIN_DIR" \
SHEJANE_E2E_RUNTIME_LOG="$LOG_FILE" \
SHEJANE_E2E_TMP_DIR="$TMP_DIR" \
SHEJANE_E2E_ARTIFACT_DIR="$PLAYWRIGHT_ARTIFACT_DIR" \
pnpm --filter @shejane/client test:e2e:client
echo "✅ Contract suite passed"
