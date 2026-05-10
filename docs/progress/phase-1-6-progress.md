# Phase 1.6 Progress Tracker

Updated: 2026-05-10

## Goal

Phase 1.6 adds a minimal, separately deployable admin web app so operators can manage the individual-user MVP without direct database edits for common support tasks.

## Boundary

- In scope: admin identification through `ADMIN_EMAILS`, `ADMIN_BASE_URL` CORS support, admin-only APIs, overview/user/usage/order/provider read views, user enable/disable, extra credit adjustment, wallet transaction audit, independent `admin/` web app, and operator docs.
- Out of scope: team or organization admin, provider key editing, encrypted key vaulting, manual order mutation, refund handling, plan changes, monthly quota mutation, and shared product-client admin entry.

## Phase Status

Closed on 2026-05-10.

Phase 1.6 is complete for the individual-user MVP: the backend admin APIs, separate admin web deployment, shadcn/ui admin interface, real feature tabs, audited safe write operations, provider/order read-only boundaries, and operator documentation are all in place. Manual local testing confirmed login/register, chat, credits, export, real LLM calls, and admin web behavior.

## Status Legend

- `Not started`: no file or test exists yet.
- `Red`: failing test created and verified.
- `Green`: focused tests pass.
- `Verified`: full verification command passed after integration.
- `Read-only`: intentionally visible but not mutable in this phase.

## Checklist

| Area | Status | Evidence |
| --- | --- | --- |
| Work branch | Verified | `codex/phase-1-6-admin-mvp` created from `main` |
| Admin env config | Green | `ADMIN_EMAILS` parsed in `api/internal/config/config.go` and documented in `.env.example` |
| Admin deployment URL | Green | `ADMIN_BASE_URL` parsed by API config and used for CORS; local admin web defaults to `http://localhost:5174` |
| Admin promotion | Green | Register/login/refresh promote matching emails to `role=admin` without auto-downgrade |
| Disabled-account protection | Green | Login, refresh, and bearer-token auth reject `status != active` |
| Admin middleware | Green | `requireAdmin` requires logged-in active admin |
| Admin overview API | Green | `GET /api/v1/admin/overview` |
| Admin users API | Green | List/detail/status update/extra-credit adjustment endpoints implemented |
| Admin usage API | Green | `GET /api/v1/admin/llm-calls` |
| Admin orders API | Read-only | `GET /api/v1/admin/orders`; no order mutation endpoint exists |
| Admin provider API | Read-only | `GET /api/v1/admin/providers` returns provider status and key presence only, never key values |
| Wallet adjustment audit | Green | Extra credit adjustment writes `wallet_transactions(type=admin_adjust)` and `audit_logs(action=admin.extra_credit_adjust)` |
| User status audit | Green | Status changes write `audit_logs(action=admin.user_status_update)` and self-disable is blocked |
| Backend tests | Green | Admin permission, promotion, disabled user, self-disable, credit adjustment, transaction, audit, and provider-key redaction covered |
| User client separation | Green | Main `client/` no longer exposes “管理后台”, even when the logged-in user has `role=admin` |
| Independent admin web | Green | `admin/` React/Vite app owns admin login, overview, users, usage, orders, and model/provider status |
| Admin UI polish | Verified | Admin web migrated to shadcn/ui primitives for sidebar, cards, tables, badges, inputs, alerts, and buttons; Playwright snapshot/screenshot passed |
| Admin feature tabs | Verified | shadcn `Tabs` now controls overview, users, usage, orders, and model views; inactive sections are not rendered in the current tab |
| Admin form validation | Green | Admin web prevents zero delta and empty reason before credit-adjustment API calls |
| Operator docs | Green | `README.md` and `docs/operations.md` document `ADMIN_EMAILS`, first admin creation, scope, and provider-key boundary |
| Final verification | Verified | `make test`, `make build`, Docker admin rebuild, admin Playwright snapshot, and admin screenshot passed after the shadcn UI pass |

## Manual Smoke Checklist

1. Set `.env`:

   ```dotenv
   ADMIN_EMAILS=<your-email>
   MOCK_LLM=false
   FAST_PROVIDER_BASE_URL=https://api.deepseek.com
   FAST_PROVIDER_API_KEY=<your-key>
   FAST_MODEL=deepseek-v4-flash
   ```

2. Restart locally:

   ```bash
   docker compose up -d --build
   ```

3. Register or log in with `<your-email>` at `http://localhost:5174` and confirm the admin web shows “运营概览”.
4. Create or log in as a normal user and send one real LLM message.
5. Return to the admin web and verify users, calls, credit changes, orders, and provider status are visible.
6. Adjust a test user's extra credits with a reason, then confirm the wallet balance and audit query in `docs/operations.md`.

## Phase 1.6 Closeout Criteria

- `make test` passes.
- `make build` passes.
- Admin APIs never return raw provider API keys.
- Admin write actions require a reason and write audit records.
- Orders and provider configuration remain read-only.
