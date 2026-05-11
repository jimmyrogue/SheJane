#!/usr/bin/env bash
set -euo pipefail

if [[ "${RUN_EXTERNAL_SMOKE:-}" != "1" ]]; then
  cat >&2 <<'MSG'
External smoke tests call real services and may consume LLM credits, create Stripe test objects, and upload to S3.
Set RUN_EXTERNAL_SMOKE=1 after API, provider, Stripe, and S3 configuration are ready.
MSG
  exit 2
fi

echo "Running real LLM smoke"
./scripts/smoke-real-llm.sh

echo "Running Stripe webhook smoke"
./scripts/smoke-stripe-webhook.sh

echo "Running S3 document upload smoke"
./scripts/smoke-s3-document.sh

echo "External smoke suite finished"
