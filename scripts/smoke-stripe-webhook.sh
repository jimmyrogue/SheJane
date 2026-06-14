#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:8080}"
RUN_ID="$(date +%s)_$$"
EMAIL="${SMOKE_EMAIL:-stripe-smoke+${RUN_ID}@shejane.local}"
PASSWORD="${SMOKE_PASSWORD:-SheJane123!}"
TMP_DIR="$(mktemp -d)"

load_env_secret() {
  if [[ -n "${STRIPE_WEBHOOK_SECRET:-}" || ! -f .env ]]; then
    return 0
  fi
  STRIPE_WEBHOOK_SECRET="$(grep -E '^[[:space:]]*STRIPE_WEBHOOK_SECRET[[:space:]]*=' .env | tail -n 1 | sed -E 's/^[^=]*=//' | tr -d '\r' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  export STRIPE_WEBHOOK_SECRET
}

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

stripe_signature_header() {
  local payload_file="$1"
  if [[ -z "${STRIPE_WEBHOOK_SECRET:-}" ]]; then
    return 0
  fi
  STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET" PAYLOAD_FILE="$payload_file" node <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const timestamp = Math.floor(Date.now() / 1000);
const payload = fs.readFileSync(process.env.PAYLOAD_FILE, 'utf8');
const signed = `${timestamp}.${payload}`;
const signature = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(signed).digest('hex');
process.stdout.write(`t=${timestamp},v1=${signature}`);
NODE
}

post_event() {
  local event_id="$1"
  local event_type="$2"
  local object_json="$3"
  local payload_file="${TMP_DIR}/${event_id}.json"
  EVENT_ID="$event_id" EVENT_TYPE="$event_type" OBJECT_JSON="$object_json" node >"$payload_file" <<'NODE'
const object = JSON.parse(process.env.OBJECT_JSON);
process.stdout.write(JSON.stringify({
  id: process.env.EVENT_ID,
  type: process.env.EVENT_TYPE,
  data: { object },
}));
NODE

  local signature
  signature="$(stripe_signature_header "$payload_file")"
  local headers=(-H "Content-Type: application/json")
  if [[ -n "$signature" ]]; then
    headers+=(-H "Stripe-Signature: ${signature}")
  fi

  local response_file="${TMP_DIR}/${event_id}.response.json"
  local status_code
  status_code="$(curl -sS -o "$response_file" -w "%{http_code}" -X POST "${API_BASE_URL}/api/v1/payment/webhook" \
    "${headers[@]}" \
    --data-binary @"$payload_file")"
  if [[ "$status_code" -lt 200 || "$status_code" -ge 300 ]]; then
    echo "Webhook ${event_type} failed with HTTP ${status_code}" >&2
    cat "$response_file" >&2
    echo >&2
    exit 1
  fi
}

assert_extra_balance() {
  local token="$1"
  local expected_balance="$2"
  local response
  response="$(
    curl -fsS "${API_BASE_URL}/api/v1/billing/balance" \
      -H "Authorization: Bearer ${token}"
  )"
  local balance
  balance="$(json_field "$response" "data.extra_credits_balance")"
  if [[ "$balance" != "$expected_balance" ]]; then
    echo "Expected extra credits balance ${expected_balance}, got ${balance}" >&2
    echo "$response" >&2
    exit 1
  fi
}

require_command curl
require_command node
load_env_secret
if [[ -z "${STRIPE_WEBHOOK_SECRET:-}" ]]; then
  echo "STRIPE_WEBHOOK_SECRET is required for the Stripe webhook smoke" >&2
  exit 1
fi

echo "Checking API health at ${API_BASE_URL}"
curl -fsS "${API_BASE_URL}/health" >"${TMP_DIR}/health.json"

echo "Registering Stripe webhook smoke user ${EMAIL}"
AUTH_RESPONSE="$(
  curl -fsS -X POST "${API_BASE_URL}/api/v1/auth/register" \
    -H "Content-Type: application/json" \
    --data "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\",\"name\":\"Stripe Smoke\"}"
)"
ACCESS_TOKEN="$(json_field "$AUTH_RESPONSE" "data.access_token")"
USER_ID="$(json_field "$AUTH_RESPONSE" "data.user.id")"

BALANCE_BEFORE_RESPONSE="$(
  curl -fsS "${API_BASE_URL}/api/v1/billing/balance" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}"
)"
EXTRA_BEFORE="$(json_field "$BALANCE_BEFORE_RESPONSE" "data.extra_credits_balance")"

echo "Creating top-up checkout"
CHECKOUT_RESPONSE="$(
  curl -fsS -X POST "${API_BASE_URL}/api/v1/billing/checkout" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"amount":10,"return_target":"web"}'
)"
SESSION_ID="$(json_field "$CHECKOUT_RESPONSE" "data.stripe_checkout_session_id")"
AMOUNT="$(json_field "$CHECKOUT_RESPONSE" "data.amount")"
CREDITS="$(json_field "$CHECKOUT_RESPONSE" "data.credits")"
EXPECTED_BALANCE="$((EXTRA_BEFORE + CREDITS))"

CHECKOUT_OBJECT="$(USER_ID="$USER_ID" SESSION_ID="$SESSION_ID" AMOUNT="$AMOUNT" CREDITS="$CREDITS" RUN_ID="$RUN_ID" node <<'NODE'
process.stdout.write(JSON.stringify({
  id: process.env.SESSION_ID,
  payment_intent: `pi_smoke_${process.env.RUN_ID}`,
  payment_status: 'paid',
  status: 'complete',
  currency: 'usd',
  metadata: {
    user_id: process.env.USER_ID,
    amount: process.env.AMOUNT,
    credits: process.env.CREDITS,
  },
}));
NODE
)"

echo "Posting checkout.session.completed for ${SESSION_ID}"
post_event "evt_smoke_checkout_${RUN_ID}" "checkout.session.completed" "$CHECKOUT_OBJECT"
assert_extra_balance "$ACCESS_TOKEN" "$EXPECTED_BALANCE"

echo "Posting duplicate checkout.session.completed for ${SESSION_ID}"
post_event "evt_smoke_checkout_duplicate_${RUN_ID}" "checkout.session.completed" "$CHECKOUT_OBJECT"
assert_extra_balance "$ACCESS_TOKEN" "$EXPECTED_BALANCE"

echo "Stripe webhook smoke finished"
