#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/cloud/docker-compose.yml"

if [[ "${COMPOSE_PROJECT_NAME:-}" == "shejane" && "${ALLOW_EXISTING_COMPOSE_PROJECT:-}" != "1" ]]; then
  echo "Refusing to run smoke cleanup against COMPOSE_PROJECT_NAME=shejane. Use a disposable project name or set ALLOW_EXISTING_COMPOSE_PROJECT=1." >&2
  exit 2
fi

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-shejane_smoke}"
export API_PORT="${API_PORT:-18080}"
export CLIENT_PORT="${CLIENT_PORT:-15173}"
export ADMIN_PORT="${ADMIN_PORT:-15174}"
export POSTGRES_PORT="${POSTGRES_PORT:-15433}"
export CLIENT_BASE_URL="${CLIENT_BASE_URL:-http://localhost:${CLIENT_PORT}}"
export ADMIN_BASE_URL="${ADMIN_BASE_URL:-http://localhost:${ADMIN_PORT}}"
export JWT_SECRET="${JWT_SECRET:-shejane-smoke-jwt-secret-change-me}"
export ADMIN_EMAILS="${ADMIN_EMAILS:-admin-smoke@shejane.local}"
export MOCK_LLM=true

API_BASE_URL="${API_BASE_URL:-http://localhost:${API_PORT}}"
RUN_ID="$(date +%s)_$$"
USER_EMAIL="${SMOKE_EMAIL:-docker-smoke+${RUN_ID}@shejane.local}"
ADMIN_EMAIL="${SMOKE_ADMIN_EMAIL:-${ADMIN_EMAILS%%,*}}"
PASSWORD="${SMOKE_PASSWORD:-SheJane123!}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 127
  fi
}

json_field() {
  JSON_PAYLOAD="$1" JSON_PATH="$2" node <<'NODE'
const payload = JSON.parse(process.env.JSON_PAYLOAD);
const path = process.env.JSON_PATH.split('.');
let value = payload;
for (const key of path) value = value?.[key];
if (value === undefined || value === null) process.exit(1);
process.stdout.write(String(value));
NODE
}

require_command curl
require_command docker
require_command node

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not reachable. Start Docker Desktop and rerun make smoke-docker-local." >&2
  exit 2
fi

echo "Starting Docker Compose smoke stack (${COMPOSE_PROJECT_NAME})"
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" up -d --build

echo "Waiting for API health at ${API_BASE_URL}"
for _ in $(seq 1 120); do
  if curl -fsS "${API_BASE_URL}/health" >"${TMP_DIR}/health.json" 2>/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS "${API_BASE_URL}/health" >"${TMP_DIR}/health.json"

echo "Registering normal smoke user ${USER_EMAIL}"
AUTH_RESPONSE="$(
  curl -fsS -X POST "${API_BASE_URL}/api/v1/auth/register" \
    -H "Content-Type: application/json" \
    --data "{\"email\":\"${USER_EMAIL}\",\"password\":\"${PASSWORD}\",\"name\":\"Docker Smoke\"}"
)"
ACCESS_TOKEN="$(json_field "$AUTH_RESPONSE" "data.access_token")"
ROLE="$(json_field "$AUTH_RESPONSE" "data.user.role")"
if [[ "$ROLE" != "user" ]]; then
  echo "Expected normal smoke user role=user, got ${ROLE}" >&2
  exit 1
fi

BALANCE_BEFORE="$(
  curl -fsS "${API_BASE_URL}/api/v1/billing/balance" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}"
)"
USED_BEFORE="$(json_field "$BALANCE_BEFORE" "data.monthly_credits_used")"

echo "Sending deterministic mock chat"
curl -fsS -N -X POST "${API_BASE_URL}/api/v1/chat/completions" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "model": "fast",
    "messages": [{"role": "user", "content": "docker smoke"}],
    "stream": true,
    "client_conversation_id": "smoke-docker-local",
    "client_message_id": "smoke-1",
    "scene": "chat"
  }' >"${TMP_DIR}/chat.sse"

node - "${TMP_DIR}/chat.sse" <<'NODE'
const fs = require('fs');
const raw = fs.readFileSync(process.argv[2], 'utf8');
if (!raw.includes('[DONE]')) {
  console.error('Missing chat SSE [DONE] sentinel');
  process.exit(1);
}
if (!raw.includes('Mock SheJane response')) {
  console.error('Expected mock provider response in deterministic Docker smoke');
  process.exit(1);
}
NODE

BALANCE_AFTER="$(
  curl -fsS "${API_BASE_URL}/api/v1/billing/balance" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}"
)"
USED_AFTER="$(json_field "$BALANCE_AFTER" "data.monthly_credits_used")"
USED_BEFORE="$USED_BEFORE" USED_AFTER="$USED_AFTER" node <<'NODE'
const before = Number(process.env.USED_BEFORE);
const after = Number(process.env.USED_AFTER);
if (!Number.isFinite(before) || !Number.isFinite(after) || after <= before) {
  console.error(`Expected credits to increase after chat, before=${before}, after=${after}`);
  process.exit(1);
}
NODE

echo "Registering admin smoke user ${ADMIN_EMAIL}"
ADMIN_RESPONSE="$(
  curl -fsS -X POST "${API_BASE_URL}/api/v1/auth/register" \
    -H "Content-Type: application/json" \
    --data "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${PASSWORD}\",\"name\":\"Admin Smoke\"}"
)"
ADMIN_TOKEN="$(json_field "$ADMIN_RESPONSE" "data.access_token")"
ADMIN_ROLE="$(json_field "$ADMIN_RESPONSE" "data.user.role")"
if [[ "$ADMIN_ROLE" != "admin" ]]; then
  echo "Expected admin smoke user role=admin, got ${ADMIN_ROLE}" >&2
  exit 1
fi

curl -fsS "${API_BASE_URL}/api/v1/admin/overview" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" >"${TMP_DIR}/admin-overview.json"

echo "Docker local smoke finished"
echo "client=${CLIENT_BASE_URL}"
echo "admin=${ADMIN_BASE_URL}"
