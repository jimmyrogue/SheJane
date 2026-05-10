# Phase 1.7 Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the individual-user MVP for real billing, safer operations, and production smoke checks.

**Architecture:** Keep the existing Go API, PostgreSQL schema, React client, and standalone admin web. Add production behavior through focused store methods, webhook handling, admin read views, and scripts without introducing a new service or changing provider keys from the browser.

**Tech Stack:** Go `net/http`, PostgreSQL, Stripe Billing Checkout webhooks, React/Vite admin web, shadcn/ui, Docker Compose, shell smoke scripts.

---

## Scope

Phase 1.7 completes the first production-readiness pass after the real LLM and admin MVP:

- Stripe subscription lifecycle: Checkout completion, renewal success, payment failure, subscription updates, and cancellation.
- Wallet monthly cycle: renewal grants reset monthly usage and remain idempotent.
- Admin visibility: orders include subscription IDs, audit logs are visible read-only, and overview shows recent failed LLM calls.
- Operational safety: local smoke scripts cover real LLM and synthetic Stripe webhook flows.
- Documentation: production environment, billing lifecycle, and deployment checklist are clear in README and operations docs.

Out of scope:

- Manual refunds, manual order mutation, provider key editing, team billing, and Stripe Customer Portal.
- Multi-instance distributed rate limiting; Phase 1.7 can only document the boundary unless a shared store is introduced.

## Files

- Modify: `api/internal/store/store.go` for billing lifecycle and admin audit interfaces.
- Modify: `api/internal/store/memory.go` for unit-test and local behavior.
- Modify: `api/internal/store/postgres.go` for production persistence.
- Modify: `api/internal/httpapi/server.go` for Stripe webhook event routing and admin audit endpoint.
- Modify: `api/internal/httpapi/server_test.go` for backend TDD coverage.
- Modify: `admin/src/shared/api/client.ts` for order subscription IDs and audit log API types.
- Modify: `admin/src/App.tsx` for read-only audit visibility and richer order status.
- Modify: `admin/src/App.test.tsx` for admin audit/order rendering.
- Create: `scripts/smoke-stripe-webhook.sh` for synthetic local webhook verification.
- Modify: `Makefile` to expose the new smoke target.
- Modify: `README.md` and `docs/operations.md`.
- Create: `docs/progress/phase-1-7-progress.md`.

## Tasks

### Task 1: Stripe Subscription Lifecycle

- [x] Write failing tests for `checkout.session.completed`, duplicate event idempotency, `invoice.paid`, `invoice.payment_failed`, and `customer.subscription.deleted`.
- [x] Implement event parsing that extracts session ID, subscription ID, invoice subscription ID, subscription status, and period timestamps.
- [x] Add store methods that mark orders paid, persist subscription ID, grant/reset monthly credits, mark wallets `past_due`, and mark wallets canceled.
- [x] Keep webhook idempotency through `stripe_events` and `wallet_transactions.idempotency_key`.
- [x] Verify with `cd api && go test ./internal/httpapi`.

### Task 2: Admin Production Visibility

- [x] Write failing tests for `GET /api/v1/admin/audit-logs` and for orders returning `stripe_subscription_id`.
- [x] Implement read-only admin audit log queries in memory and Postgres stores.
- [x] Add admin route and API client method.
- [x] Add an admin "审计" tab and show subscription IDs in the orders table.
- [x] Verify with backend and admin frontend tests.

### Task 3: Smoke Scripts And Ops Docs

- [x] Create `scripts/smoke-stripe-webhook.sh` that registers/logs in a local user, starts a mock subscription checkout, posts synthetic Stripe events, and verifies subscription status.
- [x] Add `make smoke-stripe-webhook`.
- [x] Update README and operations docs with Stripe lifecycle events, webhook setup, local smoke commands, and production checklist.
- [x] Verify scripts are executable and shellcheck-style issues are avoided with strict mode.

### Task 4: Final Verification

- [x] Run `make test`.
- [x] Run `make build`.
- [x] Update `docs/progress/phase-1-7-progress.md` with exact verification status and any remaining Phase 2 boundary.
