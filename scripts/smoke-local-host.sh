#!/usr/bin/env bash
set -euo pipefail

HOST="${LOCAL_HOST_SMOKE_ADDR:-127.0.0.1}"
PORT="${LOCAL_HOST_SMOKE_PORT:-17373}"
TOKEN="${LOCAL_HOST_SMOKE_TOKEN:-jiandanly-local-smoke-token}"
BASE_URL="http://${HOST}:${PORT}"
TMP_DIR="$(mktemp -d)"
PID=""

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" >/dev/null 2>&1; then
    kill "$PID" >/dev/null 2>&1 || true
    wait "$PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 127
  fi
}

assert_json_field() {
  local file="$1"
  local path="$2"
  local expected="$3"
  FILE="$file" JSON_PATH="$path" EXPECTED="$expected" node <<'NODE'
const fs = require('fs');
const payload = JSON.parse(fs.readFileSync(process.env.FILE, 'utf8'));
const keys = process.env.JSON_PATH.split('.');
let value = payload;
for (const key of keys) value = value?.[key];
if (String(value) !== process.env.EXPECTED) {
  console.error(`Expected ${process.env.JSON_PATH}=${process.env.EXPECTED}, got ${value}`);
  process.exit(1);
}
NODE
}

require_command curl
require_command node
require_command uv

echo "Starting Local Agent Harness (Python / LangGraph) smoke host on ${BASE_URL}"
(
  cd local-host/python
  JIANDANLY_LOCAL_HOST_ADDR="$HOST" \
    JIANDANLY_LOCAL_HOST_PORT="$PORT" \
    JIANDANLY_LOCAL_HOST_TOKEN="$TOKEN" \
    PYTHONUNBUFFERED=1 \
    uv run python -m local_host >"${TMP_DIR}/local-host.log" 2>&1
) &
PID="$!"

for _ in $(seq 1 60); do
  if curl -fsS "${BASE_URL}/local/v1/health" >"${TMP_DIR}/health.json" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$PID" >/dev/null 2>&1; then
    echo "Local Host process exited early" >&2
    cat "${TMP_DIR}/local-host.log" >&2 || true
    exit 1
  fi
  sleep 0.25
done

curl -fsS "${BASE_URL}/local/v1/health" >"${TMP_DIR}/health.json"
assert_json_field "${TMP_DIR}/health.json" "ok" "true"
assert_json_field "${TMP_DIR}/health.json" "pairing_configured" "true"

unauthorized_status="$(
  curl -sS -o "${TMP_DIR}/unauthorized.json" -w "%{http_code}" "${BASE_URL}/local/v1/tools"
)"
if [[ "$unauthorized_status" != "401" ]]; then
  echo "Expected unauthenticated /tools to return 401, got ${unauthorized_status}" >&2
  cat "${TMP_DIR}/unauthorized.json" >&2
  exit 1
fi

echo "Checking paired tool registry"
curl -fsS "${BASE_URL}/local/v1/tools" \
  -H "Authorization: Bearer ${TOKEN}" >"${TMP_DIR}/tools.json"
node - "${TMP_DIR}/tools.json" <<'NODE'
const fs = require('fs');
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const names = new Set((payload.tools ?? []).map((tool) => tool.name));
// Tool registry was renamed during the Python rewrite — these are the
// names the deepagents/langchain agent registers via @tool("...").
// `file.read`/`shell.run`/`mcp.call` were Node-daemon names; they no
// longer exist (filesystem access goes through deepagents
// FilesystemMiddleware, shell is intentionally absent, MCP is auto-
// surfaced from JIANDANLY_LOCAL_MCP_SERVERS).
for (const name of ['time.now', 'memory.search', 'user.ask', 'web.fetch', 'web.search', 'image.generate']) {
  if (!names.has(name)) {
    console.error(`Missing expected tool: ${name}`);
    process.exit(1);
  }
}
NODE

echo "Creating and streaming a deterministic local run"
RUN_RESPONSE="$(
  curl -fsS -X POST "${BASE_URL}/local/v1/runs" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"goal":"smoke local harness"}'
)"
RUN_ID="$(
  RUN_RESPONSE="$RUN_RESPONSE" node <<'NODE'
const payload = JSON.parse(process.env.RUN_RESPONSE);
if (!payload.id) {
  console.error('Missing run id');
  process.exit(1);
}
process.stdout.write(payload.id);
NODE
)"

curl -fsS -N "${BASE_URL}/local/v1/runs/${RUN_ID}/stream" \
  -H "Authorization: Bearer ${TOKEN}" >"${TMP_DIR}/run.sse"

node - "${TMP_DIR}/run.sse" <<'NODE'
const fs = require('fs');
const raw = fs.readFileSync(process.argv[2], 'utf8');
if (!raw.includes('run.completed')) {
  console.error('Missing run.completed event in Local Host stream');
  process.exit(1);
}
if (!raw.includes('[DONE]')) {
  console.error('Missing SSE [DONE] sentinel');
  process.exit(1);
}
NODE

echo "Local Host smoke finished"
