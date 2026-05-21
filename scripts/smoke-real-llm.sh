#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:8080}"
EMAIL="${SMOKE_EMAIL:-smoke+$(date +%s)@jiandanly.local}"
PASSWORD="${SMOKE_PASSWORD:-Jiandanly123!}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 127
  fi
}

require_command curl
require_command node

echo "Checking API health at ${API_BASE_URL}"
curl -fsS "${API_BASE_URL}/health" >"${TMP_DIR}/health.json"

echo "Registering smoke user ${EMAIL}"
AUTH_RESPONSE="$(
  curl -fsS -X POST "${API_BASE_URL}/api/v1/auth/register" \
    -H "Content-Type: application/json" \
    --data "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\",\"name\":\"Smoke Test\"}"
)"

ACCESS_TOKEN="$(
  AUTH_RESPONSE="$AUTH_RESPONSE" node -e '
const response = JSON.parse(process.env.AUTH_RESPONSE);
const token = response?.data?.access_token;
if (!token) {
  console.error("Missing access token in auth response");
  process.exit(1);
}
process.stdout.write(token);
'
)"

STREAM_FILE="${TMP_DIR}/chat.sse"
echo "Sending real LLM chat request"
curl -fsS -N -X POST "${API_BASE_URL}/api/v1/chat/completions" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "model": "fast",
    "messages": [{"role": "user", "content": "请用一句中文回答：2+2 等于几？"}],
    "stream": true,
    "client_conversation_id": "smoke-real-llm",
    "client_message_id": "smoke-1",
    "scene": "chat"
  }' >"${STREAM_FILE}"

node - "${STREAM_FILE}" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const raw = fs.readFileSync(file, 'utf8');
const payloads = raw
  .split(/\r?\n/)
  .filter((line) => line.startsWith('data: '))
  .map((line) => line.slice(6).trim())
  .filter((line) => line && line !== '[DONE]');

let text = '';
for (const payload of payloads) {
  try {
    const event = JSON.parse(payload);
    text += event?.choices?.[0]?.delta?.content ?? '';
  } catch {
    // Ignore malformed diagnostic lines; the API contract is validated below.
  }
}

if (!text.trim()) {
  console.error('No assistant text found in SSE response.');
  process.exit(1);
}
if (text.includes('Mock SheJane response')) {
  console.error('The response is still using the mock provider. Set MOCK_LLM=false and configure FAST_PROVIDER_API_KEY.');
  process.exit(2);
}

console.log(`assistant_text=${text.trim().slice(0, 120)}`);
NODE

echo "Real LLM smoke finished"
