#!/usr/bin/env bash
# Local mirror of the CI "Contract round-trip" job.
#
# Boots a REAL Local Host daemon on a DEDICATED port (so it never
# clobbers a running `make dev-electron` daemon on :17371), runs the
# TypeScript client's contract suite against it over real HTTP — no
# MockTransport — then tears the daemon down.
#
# This is the one check that catches client ↔ daemon shape drift, the
# bug class the Phase 5'+ migration shipped 9+ times. Run it before
# pushing a PR that touched api_schemas.py, client.ts, or any handler.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${CONTRACT_LOCAL_HOST_PORT:-17399}"
TOKEN="${CONTRACT_LOCAL_HOST_TOKEN:-contract-token}"
URL="http://127.0.0.1:${PORT}"
LOG_DIR="${SHEJANE_DEV_LOG_DIR:-${ROOT_DIR}/.tmp/dev}"
LOG_FILE="${LOG_DIR}/contract-daemon.log"
DATA_DIR="$(mktemp -d)"
mkdir -p "$LOG_DIR"

DAEMON_PID=""
cleanup() {
  if [[ -n "$DAEMON_PID" ]]; then
    kill -9 "$DAEMON_PID" 2>/dev/null || true
  fi
  # Belt-and-suspenders: free the port even if the PID moved.
  lsof -ti :"$PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

# Refuse to stomp on something already on the dedicated port.
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
  # env -i + minimal allowlist — the contract suite hits local HTTP
  # endpoints only; no cloud, no platform-paid keys (Invariant #1).
  # SHEJANE_FAKE_LLM lets the SSE contract test drive a real run/stream with
  # a deterministic in-process model (no cloud upstream needed).
  nohup env -i \
    "PATH=$PATH" "HOME=$HOME" "USER=${USER:-}" "TMPDIR=${TMPDIR:-/tmp}" \
    "SHEJANE_LOCAL_HOST_TOKEN=$TOKEN" \
    "SHEJANE_LOCAL_HOST_PORT=$PORT" \
    "SHEJANE_LOCAL_HOST_URL=$URL" \
    "SHEJANE_LOCAL_DATA_DIR=$DATA_DIR" \
    "SHEJANE_CLOUD_BASE_URL=http://127.0.0.1:8080" \
    "SHEJANE_FAKE_LLM=1" \
    "PYTHONUNBUFFERED=1" \
    uv run python -m local_host >"$LOG_FILE" 2>&1 &
  echo "$!" >"${LOG_DIR}/contract-daemon.pid"
)
DAEMON_PID="$(cat "${LOG_DIR}/contract-daemon.pid")"

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
  cd client
  VITE_TEST_LOCAL_HOST_URL="$URL" \
  VITE_TEST_LOCAL_HOST_TOKEN="$TOKEN" \
  pnpm test:contract
)
echo "✅ Contract suite passed"
