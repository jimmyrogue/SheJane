# Phase 1 Progress Tracker

Updated: 2026-05-10

## Current Scope

Phase 1 is the paid chat MVP described in `project-plan.md`, `frontend-spec.md`, and `backend-spec.md`: registration/login, streaming chat, local-first conversation history, fast/deep mode, quota display, Stripe subscription entry, import/export, and one-command local deployment.

## Status Legend

- `Not started`: no file or test exists yet.
- `Red`: failing test created and verified.
- `Green`: implementation passes its focused tests.
- `Verified`: full verification command passed after integration.
- `Configured only`: configuration exists, but runtime behavior still requires external credentials or infrastructure.

## Checklist

| Area | Status | Evidence |
| --- | --- | --- |
| Work branch | Verified | `codex/phase-1-mvp` created from `main` |
| Implementation plan | Verified | `docs/superpowers/plans/2026-05-10-phase-1-mvp.md` |
| Backend tests | Green | `cd api && go test ./...` passed |
| Backend API gateway | Green | `api/internal/httpapi/server.go` routes Phase 1 API |
| Auth and refresh tokens | Green | Register/login/refresh/logout implemented with JWT + HTTPOnly refresh cookie |
| Wallet reservation and settlement | Green | `api/internal/billing` tests cover reserve, settle, release, insufficient credits |
| LLM provider router | Green | Fast/deep routing, scene prompt injection, mock/OpenAI-compatible/Anthropic adapters implemented |
| SSE chat endpoint | Green | `POST /api/v1/chat/completions` streams OpenAI-compatible chunks and settles usage |
| Stripe Checkout and webhook entry | Green | Checkout endpoint, mock local checkout, Stripe API call, signature verification, webhook idempotency implemented |
| PostgreSQL migrations | Green | `api/migrations/001_phase1.sql` covers Phase 1 schema |
| PostgreSQL runtime store | Green | `api/internal/store/postgres.go` persists users, refresh tokens, wallets, reservations, llm records, payment orders, and Stripe events when `DATABASE_URL` is set |
| Frontend tests | Green | `cd client && npm test -- --run` passed |
| React shared app | Green | `client/src/App.tsx` implements auth, chat, mode/scene controls, quota bar, subscription entry |
| IndexedDB/local history | Green | `LocalConversationStore` tested with `fake-indexeddb` |
| Export/import | Green | JSON export/import wired in the sidebar and covered by local data test |
| Electron shell | Green | `client/electron/main.cjs` and `preload.cjs` wrap the shared Vite build |
| Docker Compose | Verified | `docker compose --env-file .env.example up --build -d` started Postgres, Redis, migration, API, and client locally; API health, frontend HTTP, register/chat, and Postgres record counts verified |
| AWS Hong Kong deployment verification | Blocked | Requires an AWS host, DNS, and deployment credentials; local Docker/Caddy deployment artifacts are ready |
| README | Green | Root `README.md` documents purpose, Phase 1 capabilities, setup, credentials, Docker, and verification |
| Rendered frontend smoke | Verified | Browser opened `http://localhost:5173`, registered a local user, sent mock chat, saw quota and streamed reply with no console errors |
| Final verification | Verified | `make test` and `make build` passed |

## Phase 1 Boundary Notes

- Chat history remains client-local by default; backend stores only metadata and usage records.
- Team, BYOK, cloud sync, cloud knowledge base, RAG, Office generation, image generation, and tool/agent automation are explicitly outside Phase 1.
- Stripe and external LLM providers are environment-driven. Local development must still run with deterministic mock adapters.
