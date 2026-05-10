#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:8080}"
RUN_ID="$(date +%s)_$$"
EMAIL="${SMOKE_EMAIL:-stripe-smoke+${RUN_ID}@jiandanly.local}"
PASSWORD="${SMOKE_PASSWORD:-Jiandanly123!}"
SUBSCRIPTION_ID="${SMOKE_STRIPE_SUBSCRIPTION_ID:-sub_smoke_${RUN_ID}}"
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

assert_subscription_status() {
  local token="$1"
  local expected_status="$2"
  local response
  response="$(
    curl -fsS "${API_BASE_URL}/api/v1/billing/balance" \
      -H "Authorization: Bearer ${token}"
  )"
  local status
  status="$(json_field "$response" "data.status")"
  if [[ "$status" != "$expected_status" ]]; then
    echo "Expected wallet status ${expected_status}, got ${status}" >&2
    echo "$response" >&2
    exit 1
  fi
}

require_command curl
require_command node
load_env_secret

echo "Checking API health at ${API_BASE_URL}"
curl -fsS "${API_BASE_URL}/health" >"${TMP_DIR}/health.json"

echo "Registering Stripe webhook smoke user ${EMAIL}"
AUTH_RESPONSE="$(
  curl -fsS -X POST "${API_BASE_URL}/api/v1/auth/register" \
    -H "Content-Type: application/json" \
    --data "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\",\"name\":\"Stripe Smoke\"}"
)"
ACCESS_TOKEN="$(json_field "$AUTH_RESPONSE" "data.access_token")"

echo "Creating local subscription checkout"
CHECKOUT_RESPONSE="$(
  curl -fsS -X POST "${API_BASE_URL}/api/v1/billing/subscription/checkout" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}"
)"
SESSION_ID="$(json_field "$CHECKOUT_RESPONSE" "data.stripe_checkout_session_id")"

echo "Posting checkout.session.completed for ${SESSION_ID}"
post_event "evt_smoke_checkout_${RUN_ID}" "checkout.session.completed" "{\"id\":\"${SESSION_ID}\",\"subscription\":\"${SUBSCRIPTION_ID}\",\"payment_status\":\"paid\",\"status\":\"complete\"}"
assert_subscription_status "$ACCESS_TOKEN" "active"

echo "Posting invoice.paid renewal for ${SUBSCRIPTION_ID}"
post_event "evt_smoke_invoice_paid_${RUN_ID}" "invoice.paid" "{\"id\":\"in_smoke_paid_${RUN_ID}\",\"subscription\":\"${SUBSCRIPTION_ID}\",\"billing_reason\":\"subscription_cycle\",\"period_end\":1780000000}"
assert_subscription_status "$ACCESS_TOKEN" "active"

echo "Posting invoice.payment_failed for ${SUBSCRIPTION_ID}"
post_event "evt_smoke_invoice_failed_${RUN_ID}" "invoice.payment_failed" "{\"id\":\"in_smoke_failed_${RUN_ID}\",\"subscription\":\"${SUBSCRIPTION_ID}\"}"
assert_subscription_status "$ACCESS_TOKEN" "past_due"

echo "Posting customer.subscription.deleted for ${SUBSCRIPTION_ID}"
post_event "evt_smoke_subscription_deleted_${RUN_ID}" "customer.subscription.deleted" "{\"id\":\"${SUBSCRIPTION_ID}\",\"status\":\"canceled\"}"
assert_subscription_status "$ACCESS_TOKEN" "canceled"

echo "Stripe webhook smoke finished"
