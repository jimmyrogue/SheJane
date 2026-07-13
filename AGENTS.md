# AGENTS.md — SheJane Contributor Guide

The first stop for coding agents (and humans) working in this repository. Keep it practical: follow the existing project shape, protect secrets, and verify changes before calling them done.

For the full architecture, the critical invariants, and "where things live", read **[CLAUDE.md](./CLAUDE.md)** first. Dev setup + workflow live in **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

## Runtime Stage Discipline

For any work touching Desktop ↔ Runtime startup, Commands, Runs, Events, Workers, Agent execution, Tools, Checkpoints, or terminal state:

1. Read **[docs/harness-runtime-stages.md](./docs/harness-runtime-stages.md)** and identify one canonical `primary_stage` before changing code.
2. Read the stage's immediate upstream and downstream contracts in order.
3. Compare the target stage with the current implementation in **[docs/run-loop.md](./docs/run-loop.md)**.
4. Check existing decisions in **[docs/harness-stage-improvement-notes.md](./docs/harness-stage-improvement-notes.md)**.
5. Record the primary stage, affected adjacent stages, canonical state owner, and old path being replaced in the implementation plan or handoff.

Do not invent a second P1-P12 numbering scheme. `run-loop.md` describes current code; `harness-runtime-stages.md` alone owns target stage numbers.

## Product shape

SheJane (石间) is an agentic chat product. Code-level identifiers (package names, the `SHEJANE_*` env prefix, on-disk paths) use the lowercase form `shejane`.

- `api/` — Go API: auth, wallet/credit ledger, model catalog + LLM routing, the cloud Tool Gateway, Stripe billing webhooks, documents (S3), admin APIs.
- `local-host/python/` — Python LangGraph daemon (the local agent harness): runs the agent loop, tools, and middleware over loopback HTTP.
- `client/` — Electron/React user app; local-first chat history.
- `apps/admin/` — standalone React/Vite admin app (shadcn/ui).
- `api/migrations/` — sequential, idempotent PostgreSQL migrations.
- `docs/operations.md` — operator runbook.
- `docs/roadmap.md` — current priorities and intentionally deferred work.

See CLAUDE.md for the architecture map and critical invariants. Use the canonical stage document above for target request flow and `run-loop.md` for current request flow.

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
pnpm --filter shejane-client test --run
pnpm --filter shejane-admin test --run
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
- Safe to mention variable names: `JWT_SECRET`, `CONFIG_ENCRYPTION_KEY`, `FAST_PROVIDER_API_KEY`, `DEEP_PROVIDER_API_KEY`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `ADMIN_EMAILS`.
- Provider keys may be entered through the admin model-config form or seeded from `.env` on first empty-db boot. They must never be printed, returned from APIs, or committed. The admin UI may show only whether a key is configured. Stripe keys remain environment/deployment secrets only.
- `ADMIN_EMAILS` promotes matching users to `role=admin` on register/login/refresh. Removing an email from env does not auto-demote existing admins.
- Local default ports:
  - User web: `http://localhost:5173`
  - Admin web: `http://localhost:5174`
  - API: `http://localhost:8080`
  - Postgres host port: `15432`

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

## Model Catalog Rules

- User-facing model selection is `Auto` plus enabled chat models from `GET /api/v1/models`.
- The stable model ID is stored in `model_configs.slot` for compatibility, but UI/docs should call it "model ID".
- Chat model IDs are admin-defined strings such as `gpt-4o`, `claude-sonnet`, `deepseek-v4`, or legacy `chat.fast`; they must not be `auto`, blank, contain whitespace, or exceed the current `VARCHAR(40)` database limit.
- `Auto` and the `auto.` prefix are reserved. The Go API resolves `auto`, `auto.fast`, and `auto.smart` once per run through `POST /api/v1/models/resolve` and emits `model.selected`; the latter two are Auto intent sentinels, not concrete model IDs.
- Do not reintroduce fast/deep UX or daemon-side model classifiers. `chat.fast` and `chat.deep` are seed IDs, not fixed product tiers.
- Image models are not exposed in the chat picker. Current image configuration is fixed to `image.default`.
- Text model billing prefers CNY per-1M-token supplier prices for input/output/cache fields. Legacy input/output token multipliers and `credit_multiplier` remain fallback only. Global markup remains the product margin knob.
- Keep model catalog behavior behind `api/internal/modelreg.Registry` and store changes behind `api/internal/store.Store`; memory and Postgres implementations must stay in lockstep.

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
- `apps/admin/`: standalone admin app. Keep it shadcn/ui based.

Admin UI expectations:

- Use existing shadcn primitives under `apps/admin/src/components/ui/`.
- Keep feature areas as real tabs/sections: overview, users, usage, orders, models, audit.
- Orders, provider status, and audit logs are read-only.
- Admin write forms must require a reason where backend requires one.
- The model config form uses a free-text "model ID" for chat models. Do not restore a fixed `chat.fast` / `chat.deep` dropdown. For image capability, keep the ID fixed to `image.default`.

Client UI expectations:

- Chat history remains local-first.
- Backend stores usage metadata and billing data, not full chat body history.
- Keep import/export behavior intact.
- Follow the SheJane visual system in `docs/ui/shejane-design-system.md`: warm paper + ink, seal red only for brand/running/critical states, moss only for online/success, and single-color typographic attachment glyphs instead of colorful file icons.

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
- model catalog validation, Auto resolution, or model picker behavior
- local-first data import/export
- SSE parsing or chat store behavior

## Documentation Expectations

- Update `README.md` for user/developer setup changes.
- Update `docs/operations.md` for operational, env, Stripe, admin, or deployment changes.
- Keep docs truthful about boundaries. Mark unimplemented future work as future work, not hidden capability.

## Git And Generated Files

- Do not revert user changes.
- Do not commit or reset unless the user asks.
- Do not check in build output from `client/dist` or `apps/admin/dist`.
- Prefer `rg` and `rg --files` for repository searches.
- Use `apply_patch` for manual edits.
