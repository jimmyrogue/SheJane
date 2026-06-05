# AGENTS.md — SheJane Contributor Guide

The first stop for coding agents (and humans) working in this repository. Keep it practical: follow the existing project shape, protect secrets, and verify changes before calling them done.

For the full architecture, the critical invariants, and "where things live", read **[CLAUDE.md](./CLAUDE.md)** first. Dev setup + workflow live in **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

## Product shape

SheJane (石间) is an agentic chat product. `jiandanly` is the legacy code name still used in package names, env-var prefixes (`JIANDANLY_*`), and on-disk paths.

- `api/` — Go API: auth, wallet/credit ledger, LLM routing, the cloud Tool Gateway, Stripe billing webhooks, documents (S3), admin APIs.
- `local-host/python/` — Python LangGraph daemon (the local agent harness): runs the agent loop, tools, and middleware over loopback HTTP.
- `client/` — Electron/React user app; local-first chat history.
- `admin/` — standalone React/Vite admin app (shadcn/ui).
- `api/migrations/` — sequential, idempotent PostgreSQL migrations.
- `docs/operations.md` — operator runbook.

See CLAUDE.md for the request flow, the SSE protocol, and the four non-negotiable invariants.

## Commands

Use these before handing work back:

```bash
make test
make build
git diff --check
```

Useful focused checks:

```bash
cd api && go test ./internal/httpapi
cd client && npm test -- --run
cd admin && npm test -- --run
```

Local Docker:

```bash
docker compose up -d --build
docker compose ps
```

Smoke tests:

```bash
make smoke-real-llm
make smoke-stripe-webhook
```

`make smoke-real-llm` requires `MOCK_LLM=false` and a real provider key. `make smoke-stripe-webhook` can run against local synthetic events and auto-reads `STRIPE_WEBHOOK_SECRET` from `.env` when the shell variable is not set.

## Environment And Secrets

- Never print or commit real secrets from `.env`.
- Safe to mention variable names: `JWT_SECRET`, `FAST_PROVIDER_API_KEY`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `ADMIN_EMAILS`.
- Provider and Stripe keys are environment/deployment secrets only. Do not add UI for editing or revealing them.
- `ADMIN_EMAILS` promotes matching users to `role=admin` on register/login/refresh. Removing an email from env does not auto-demote existing admins.
- Local default ports:
  - User web: `http://localhost:5173`
  - Admin web: `http://localhost:5174`
  - API: `http://localhost:8080`
  - Postgres host port: `15432`
  - Redis host port: `16379`

## Backend Rules

- Keep store behavior behind `api/internal/store.Store`; update both `memory.go` and `postgres.go` when changing store capabilities.
- Reuse the wallet ledger in `api/internal/billing/wallet.go`; do not mutate balances ad hoc.
- Wallet operations must write ledger/audit records where appropriate:
  - usage reservation/settlement/release writes `wallet_transactions`.
  - admin extra-credit adjustment writes `wallet_transactions(type=admin_adjust)` and `audit_logs(action=admin.extra_credit_adjust)`.
  - admin status changes write `audit_logs(action=admin.user_status_update)`.
  - Stripe subscription events write Stripe event records and billing audit logs.
- Stripe webhook processing must remain idempotent:
  - store event IDs in `stripe_events`.
  - mark `processed_at` only after local processing succeeds.
  - use `wallet_transactions.idempotency_key` with `stripe:<event_id>` for grants.
- Do not add manual order mutation endpoints in the admin API unless the phase explicitly asks for it.
- Disabled users must not be able to login, refresh, or use old bearer tokens.

## Stripe Billing Notes

Use Stripe sandbox/test mode for development. Keep test and live resources separate.

Expected env:

```dotenv
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_PRICE_ID=price_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
```

The webhook endpoint is:

```text
POST /api/v1/payment/webhook
```

The current lifecycle covers:

- `checkout.session.completed`
- `invoice.paid`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.resumed`
- `customer.subscription.deleted`

The admin app shows orders and audit logs read-only. Refunds, manual subscription changes, Stripe Customer Portal, and plan switching are not implemented yet.

## Frontend Rules

There are two separate web apps:

- `client/`: normal user app. Do not put admin views or admin entry points here.
- `admin/`: standalone admin app. Keep it shadcn/ui based.

Admin UI expectations:

- Use existing shadcn primitives under `admin/src/components/ui/`.
- Keep feature areas as real tabs/sections: overview, users, usage, orders, models, audit.
- Orders, providers, and audit logs are read-only.
- Admin write forms must require a reason where backend requires one.

Client UI expectations:

- Chat history remains local-first.
- Backend stores usage metadata and billing data, not full chat body history.
- Keep import/export behavior intact.

## Testing Expectations

Use TDD for new behavior whenever practical:

1. Add a focused failing test.
2. Run the focused command and see the expected failure.
3. Implement the smallest passing change.
4. Run focused tests, then `make test`.

Add or update tests when touching:

- auth and account status
- wallet balances or ledger logic
- Stripe webhook behavior
- admin permissions, admin writes, or admin read views
- local-first data import/export
- SSE parsing or chat store behavior

## Documentation Expectations

- Update `README.md` for user/developer setup changes.
- Update `docs/operations.md` for operational, env, Stripe, admin, or deployment changes.
- Keep docs truthful about boundaries. Mark unimplemented future work as future work, not hidden capability.

## Git And Generated Files

- Do not revert user changes.
- Do not commit or reset unless the user asks.
- Do not check in build output from `client/dist` or `admin/dist`.
- Prefer `rg` and `rg --files` for repository searches.
- Use `apply_patch` for manual edits.
