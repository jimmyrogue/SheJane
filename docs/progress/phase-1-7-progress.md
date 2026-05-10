# Phase 1.7 Progress Tracker

Updated: 2026-05-10

## Goal

Phase 1.7 hardens the MVP for production readiness: Stripe subscription lifecycle, monthly wallet renewal, safer admin visibility, smoke scripts, and deployment operations documentation.

## Boundary

- In scope: Stripe subscription webhooks, order subscription IDs, wallet renewal/failure/cancellation state, idempotent ledger writes, read-only audit visibility, local Stripe webhook smoke, and production readiness docs.
- Out of scope: refunds, manual order status mutation, provider key editing, team billing, Customer Portal, distributed rate limiting, and multi-region deployment automation.

## Phase Status

Closed on 2026-05-10.

Phase 1.7 is complete for the individual-user MVP: Stripe subscription webhooks now persist subscription IDs, renew monthly credits, synchronize failure/cancellation states, keep event processing idempotent, expose read-only audit visibility in the admin web, and include local smoke coverage for synthetic Stripe webhook flows.

## Status Legend

- `Not started`: no file or test exists yet.
- `Red`: failing test created and verified.
- `Green`: focused tests pass.
- `Verified`: full verification command passed after integration.
- `Documented`: behavior and operations steps are captured in docs.

## Checklist

| Area | Status | Evidence |
| --- | --- | --- |
| Execution plan | Green | `docs/superpowers/plans/2026-05-10-phase-1-7-production-readiness.md` |
| Stripe lifecycle tests | Not started | Backend tests will cover checkout, renewal, failure, cancellation, and idempotency |
| Stripe lifecycle tests | Green | `cd api && go test ./internal/httpapi` covers checkout, renewal, failure, cancellation, and idempotency |
| Checkout completion | Green | Persists `stripe_subscription_id`, marks order paid, grants monthly credits |
| Renewal success | Green | `invoice.paid` with renewal reason refreshes monthly quota once per event |
| Payment failure | Green | `invoice.payment_failed` marks wallet `past_due` |
| Subscription cancellation | Green | `customer.subscription.deleted` marks wallet `canceled` |
| Admin audit visibility | Green | `GET /api/v1/admin/audit-logs` and admin `审计` tab are read-only |
| Admin order enrichment | Green | Orders expose subscription ID, plan code, and wallet status without secrets |
| Stripe webhook smoke | Green | `scripts/smoke-stripe-webhook.sh` and `make smoke-stripe-webhook` |
| Production docs | Documented | `README.md` and `docs/operations.md` cover Phase 1.7 billing and production checks |
| Final verification | Verified | `make test`, `make build`, `docker compose up -d --build api`, and `make smoke-stripe-webhook` |

## Notes

- Stripe provider keys and webhook secrets remain environment/deployment secrets only.
- Admin order and audit views are read-only in this phase.
- Local synthetic webhook testing intentionally bypasses Stripe signature verification unless `STRIPE_WEBHOOK_SECRET` is set.

## Verification Log

```bash
make test
make build
docker compose up -d --build api
make smoke-stripe-webhook
```
