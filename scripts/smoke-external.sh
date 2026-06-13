#!/usr/bin/env bash
set -euo pipefail

if [[ "${RUN_EXTERNAL_SMOKE:-}" != "1" ]]; then
  cat >&2 <<'MSG'
External smoke tests call real services and may consume LLM credits, create Stripe test objects, and upload to S3.
Set RUN_EXTERNAL_SMOKE=1 after API, provider, Stripe, and S3 configuration are ready.
MSG
  exit 2
fi

SMOKE_RAN=0
SMOKE_SKIPPED=0

summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >>"${GITHUB_STEP_SUMMARY}"
  fi
}

warn_skip() {
  local message="$1"
  echo "Skipping: ${message}" >&2
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::warning title=External smoke skipped::${message}"
  fi
  summary "- Warning: ${message}"
  SMOKE_SKIPPED=$((SMOKE_SKIPPED + 1))
}

run_smoke() {
  local name="$1"
  shift
  echo "Running ${name}"
  "$@"
  SMOKE_RAN=$((SMOKE_RAN + 1))
}

summary "## External smoke"

if [[ -n "${GITHUB_ACTIONS:-}" && -z "${API_BASE_URL:-}" ]]; then
  warn_skip "SHEJANE_API_BASE_URL is not configured; skipping the whole external smoke suite."
  echo "External smoke suite skipped"
  exit 0
fi

if [[ "${SKIP_REAL_LLM_SMOKE:-}" == "1" ]]; then
  warn_skip "SKIP_REAL_LLM_SMOKE=1; skipping real LLM smoke."
else
  run_smoke "real LLM smoke" ./scripts/smoke-real-llm.sh
fi

if [[ "${SKIP_STRIPE_WEBHOOK_SMOKE:-}" == "1" ]]; then
  warn_skip "SKIP_STRIPE_WEBHOOK_SMOKE=1; skipping Stripe webhook smoke."
elif [[ -n "${GITHUB_ACTIONS:-}" && -z "${STRIPE_WEBHOOK_SECRET:-}" ]]; then
  warn_skip "STRIPE_WEBHOOK_SECRET is not configured; skipping Stripe webhook smoke."
else
  run_smoke "Stripe webhook smoke" ./scripts/smoke-stripe-webhook.sh
fi

if [[ "${SKIP_S3_DOCUMENT_SMOKE:-}" == "1" ]]; then
  warn_skip "SKIP_S3_DOCUMENT_SMOKE=1; skipping S3 document upload smoke."
else
  run_smoke "S3 document upload smoke" ./scripts/smoke-s3-document.sh
fi

if [[ "$SMOKE_RAN" -eq 0 ]]; then
  warn_skip "No external smoke checks ran."
fi

summary "- Ran: ${SMOKE_RAN}"
summary "- Skipped: ${SMOKE_SKIPPED}"
echo "External smoke suite finished (ran=${SMOKE_RAN}, skipped=${SMOKE_SKIPPED})"
