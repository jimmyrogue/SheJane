# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

石间 / SheJane is a standalone desktop Agent Harness. Electron/React is the official client, the Python LangGraph Runtime owns execution and state, and the TypeScript Runtime SDK owns the public client protocol. The Go Cloud and Admin modules are optional, independently released services.

## Architecture

The diagram below describes the current implementation. Target P1-P12 stage numbering lives only in [docs/harness-runtime-stages.md](docs/harness-runtime-stages.md).

```
┌─────────────────────────────────────────────────────────────────┐
│  Electron renderer (apps/desktop/) — React + Vite + Tailwind     │
│  Talks only to Runtime through the public Runtime SDK.           │
└──────────┬──────────────────────────────────────────────┬───────┘
           │ /local/v1/* (loopback only, bearer token)
           ▼
┌─────────────────────────────────┐
│ SheJane Runtime                 │
│ services/runtime/local_host/   │         │ Postgres +           │
│ FastAPI + uvicorn               │         │ S3 (documents) +     │
│ LangGraph 1.2 + deepagents      │         │ Stripe (billing)     │
│ AsyncSqliteSaver (checkpoints)  │         │                      │
│ BYOK provider registry + OS credential store                      │
│ Local tools, Skills, MCP, memory, approvals and checkpoints       │
└─────────────────────────────────┘

Optional: apps/admin/ ──▶ services/cloud/ ──▶ Postgres / S3 / Stripe
```

There's also an admin panel (`apps/admin/`) — separate Vite/React app for the model catalog, credit-rate tuning, audit logs, and user/account operations.

The two runtime truth sources answer different questions:

- **[docs/harness-runtime-stages.md](docs/harness-runtime-stages.md)** — canonical target P1-P12 stages, migration seams, and the mandatory pre-change comparison order.
- **[docs/run-loop.md](docs/run-loop.md)** — current implementation from `POST /local/v1/runs` to terminal state, including middleware, HITL, and SSE behavior.

Never use `run-loop.md` to invent target phase numbers, and never describe unimplemented target behavior as current code.

**Sibling guides:** this file is the architecture + invariants. [AGENTS.md](AGENTS.md) is the day-to-day rulebook — it carries the detailed backend/billing/frontend rules (store dual-impl, wallet-ledger discipline, Stripe webhook idempotency, admin surfaces, the supported subscription lifecycle). [CONTRIBUTING.md](CONTRIBUTING.md) has dev setup + PR workflow. Current priorities live in [docs/roadmap.md](docs/roadmap.md). The product spec is [spec.md](spec.md).

## Critical invariants

These are not arbitrary style rules — each one corresponds to a class of bug that has actually shipped and burned hours in this repo.

1. **Runtime provider keys MUST live in the Runtime credential store, never process env.** Optional Cloud service keys live only in `services/cloud/.env`. Runtime has no private Go Gateway path. Enforced by `scripts/check-no-platform-keys-in-daemon.sh`.

2. **The daemon's pydantic models in `services/runtime/local_host/api_schemas.py` are the single source of truth for the HTTP shape.** FastAPI emits `openapi.json` from them; `openapi-typescript` regenerates `packages/runtime-client/src/generated.ts`; `client.ts` re-exports the generated types as aliases. Anytime you edit a model OR a handler's `response_model=` annotation, run `make schemas` and commit both `openapi.json` and `generated.ts`. CI's lint job fails the PR if they drift.

3. **The SSE wire envelope is non-negotiable.** Every event in `/local/v1/runs/:id/stream` ships as `data: {"event_type": ..., "payload": {...}, "id": ..., "run_id": ..., "created_at": ...}`; durable events also carry a monotonic `seq`, while temporary model output deliberately has no replay cursor. The separator is **LF** double-newline (not CRLF), and the terminator is `data: [DONE]` (not `event: stream.end`). Event names are `llm.delta` / `tool.completed` / `permission.required` etc. — NOT the old `llm.token` / `tool.end` names. Full spec in `docs/client-sse-protocol.md`.

4. **`make dev-electron` always hard-restarts.** It SIGKILLs any straggler daemon/vite/electron processes and frees ports before starting. Opt out only with `SHEJANE_DEV_REUSE=1`. The reason: uvicorn traps SIGTERM and can outlive a "graceful" restart, leaving the next session attached to a daemon with stale code in memory. If you suspect this, run `make doctor` to see the daemon's PID + start time.

5. **Configuration has one owner.** There is no root `.env`. Desktop, Runtime, Runtime SDK, and Admin require zero user env by default. Cloud service env lives in `services/cloud/.env`; deployment-only values live in `infra/cloud/.env`.

6. **Runtime model selection is BYOK-owned.** Desktop reads models from Runtime and submits a concrete `local:<provider>:<model>` selection. Do not restore Go Cloud catalog discovery, Auto resolution, or fast/deep classifiers in Desktop or Runtime.

7. **Product-specific connectors do not belong in the runtime core.** The retired Lark/Feishu message-sync and todo pipeline must not be restored as private daemon routes, dedicated tables, or client state. Future business-platform integrations should use standard tools or MCP.

## Common commands

```bash
# Standalone Runtime + Vite + Electron + auto-tail log
make dev-electron

# After daemon code edits where stragglers might be running, OR after
# Docker images need rebuild (api/admin/postgres). Does
# `docker compose -f infra/cloud/docker-compose.yml up -d --build` (rebuild WITH layer cache).
make dev-fresh

# Scorched-earth reset — when dev-fresh isn't enough: a poisoned
# build-cache layer (stale image despite --build, e.g. an Admin
# `COPY . .` cache-hit that skips `pnpm build`) or a wedged
# container. Does `down --remove-orphans` + `build --no-cache` +
# `up --force-recreate`, then relaunches native. Keeps DB volumes
# (uploaded docs / conversations survive); for an empty DB run
# `docker compose -f infra/cloud/docker-compose.yml down -v` first.
make dev-nuke

# One-shot diagnostic — answers "why isn't dev working?"
make doctor

# Hot-restart ONLY the Python daemon after a code edit (seconds, not a
# full relaunch); then Cmd+R Electron to re-pair. Encapsulates the
# `lsof -ti :17371 | xargs kill -9` dance — the daemon-restart skill.
make restart-daemon

# Grouped, self-documenting help (the default target — bare `make` too)
make help

# Tests (all 4 stacks)
make test               # python + client vitest + admin vitest + go
make local-host-test    # just python (uv run python -m pytest)
make client-test        # just client (vitest --run)
make admin-test         # just admin (vitest --run)
make api-test           # just go (go test ./...)
make test-race          # go test -race ./... (catches ledger data races)
make test-e2e           # Playwright simulated E2E
make test-contract      # client ↔ daemon contract over real HTTP (:17399)
make ci                 # run EVERYTHING CI runs, locally (pre-push gate)

# A single Python test
cd services/runtime && uv run python -m pytest tests/test_e2e_capabilities.py::test_capability_1d_scope_run_skips_subsequent_approvals -v

# A single client test
pnpm --filter @shejane/desktop test --run -t "permission.resolved clears card"

# Lint — same checks CI runs
make lint

# Regenerate schemas after pydantic edits (REQUIRED if you touched api_schemas.py)
make schemas

# Smoke tests
make smoke-local-host        # standalone daemon HTTP smoke
make smoke-docker-local      # full Docker stack
make smoke-real-llm          # real LLM provider
make smoke-stripe-webhook    # Stripe webhook simulation

# Deploy / release (production — GHCR images + infra/cloud/docker-compose.prod.yml)
make release COMPONENT=runtime VERSION=0.1.0  # pushes runtime-v0.1.0
make deploy                  # pull prebuilt images + (re)start prod stack
make deploy-logs             # tail the prod stack

# Logs
make logs-local-host         # tail .tmp/dev/local-host.log
make logs-api                # tail docker compose -f infra/cloud/docker-compose.yml api
make logs-llm-errors         # query llm_call_records table
make logs-dev                # snapshot of all of the above
```

## Where things live

| If you're asking about... | Read |
|---|---|
| Canonical target P1-P12 chain, stage number for a change, pre-change comparison checklist | `docs/harness-runtime-stages.md` |
| One run from POST to terminal — middleware order, HITL, scope=run, SSE events | `docs/run-loop.md` |
| Existing keep/delete/migrate decisions by target stage | `docs/harness-stage-improvement-notes.md` |
| Wire format for client ↔ daemon SSE — event names + envelope keys + endpoint table | `docs/client-sse-protocol.md` |
| Production deployment / migrations | `docs/operations.md` |
| Current priorities | `docs/roadmap.md` |
| Runtime model providers | `services/runtime/local_host/server.py`, `services/runtime/local_host/runs.py`, `services/runtime/local_host/llm/`, `apps/desktop/src/features/settings/ModelProvidersSettings.tsx` |
| Daemon code | `services/runtime/local_host/` — `server.py` 提供本地接口，`runs.py` 负责作业租约、执行、清理和结算，`agent/builder.py` 装配可复用 Agent 定义，`agent/subagents.py` 定义 Deep Agents 子 Agent，`middleware/` 负责输入观察、出站策略、工具可见性、人工确认、工具回执和唯一完成路由，`tools/` 保存工具实现，`store/sqlite.py` 保存 Runtime 状态与作业记录 |
| Cloud code | `services/cloud/internal/` — `app/` wiring, `httpapi/` routes, `store/`, `billing/`, `llm/`, `modelreg/`, `documents/`, `e2b/` and `secrets/` |
| Client code | `apps/desktop/src/` — `App.tsx` is the chat shell, `features/` holds chat, MCP, skills and settings, and `shared/local-host/client.ts` adapts `@shejane/runtime-client` to Electron |
| Client visual system | `docs/ui/shejane-design-system.md` — June 2026 SheJane redesign tokens, brand mark, app-shell rules, and attachment/artifact glyph language |
| Admin panel | `apps/admin/` — separate Vite app; model configs, credit rate, audit logs |
| Contract tests (real HTTP, not MockTransport) | `apps/desktop/src/shared/local-host/client.contract.test.ts` |

## Conventions

### Python (services/runtime/)

- `uv` manages deps. Never edit `uv.lock` by hand — run `uv add <pkg>` or `uv remove <pkg>`.
- Lint: ruff (configured in `pyproject.toml`). Format: ruff format. `make lint` enforces.
- `from __future__ import annotations` everywhere; PEP 604 syntax (`str | None`, not `Optional[str]`).
- Tests use pytest + httpx.MockTransport for daemon HTTP and `local_host.config.reset_settings_for_tests(**overrides)` to swap settings.
- New tool: add `@tool("name.action")` in `services/runtime/local_host/tools/` and append it to `tools/registry.py`. Remote capabilities should use MCP; do not add product-private Cloud routes.
- New endpoint: add a pydantic model in `api_schemas.py`, declare `response_model=Model` on the handler, run `make schemas`, commit the regenerated files.

### Go (services/cloud/)

- `go vet ./...` + `gofmt -l` enforced via lefthook + CI.
- The credit ledger (`services/cloud/internal/billing/`) reserves credits before external calls and settles or releases on every exit. Wallet balances move only through this ledger.
- `services/cloud/internal/store` has memory and Postgres implementations that must stay in lockstep.
- Stripe webhook handling must stay idempotent: dedupe on `stripe_events`, set `processed_at` only after local processing succeeds, and key credit grants with `wallet_transactions.idempotency_key = stripe:<event_id>`. See AGENTS.md for the full lifecycle + admin-audit rules.

### TypeScript (apps/desktop/, apps/admin/)

- Vite + React 18 + TypeScript strict mode. Tailwind 4 + shadcn/ui.
- Daemon types come from `packages/runtime-client/src/generated.ts` — re-exported as aliases in `client.ts`. Don't hand-write a new interface for daemon data; add it to `api_schemas.py` and regenerate.
- Hand-written types in `client.ts` are documented at the top of the file (DesktopBridge, LocalHostConfig, LocalHostProbe, LocalStreamHandlers) — these have no daemon equivalent.
- SSE parsing and the `AgentRunEvent` union live in `packages/runtime-client`. New Runtime events also need a Desktop projection in `features/chat/chatStore.ts` and/or `App.tsx`.

### Commits

- Conventional-ish messages (`feat:`, `fix:`, `ci:`, `docs:`) — no strict enforcement, but the existing history follows this. Lefthook only enforces non-empty + ≥5 chars.
- Pre-commit runs ruff/gofmt/go vet/no-platform-keys/no-env-files in parallel (~sub-second). To bypass for a WIP commit: `LEFTHOOK=0 git commit`.

## Automations already wired

| Type | Where | What |
|---|---|---|
| Pre-commit | `lefthook.yml` | ruff/gofmt/go vet/no-platform-keys/no-env-files |
| CI | `.github/workflows/ci.yml` | 4 parallel jobs: lint / test (unit + `-race` + build) / e2e (Playwright) / contract round-trip |
| Release | `.github/workflows/release-*.yml` | independent `runtime-v*`, `desktop-v*`, `cloud-v*`, `admin-v*`, and `runtime-client-v*` releases |
| Nightly | `.github/workflows/external-smoke.yml` | external service smoke (Stripe / Tavily / S3 / API at 18:00 UTC) |
| Deps | `.github/dependabot.yml` | weekly grouped PRs for gomod/npm×3/pip/github-actions |
| Skills (Claude Code) | `.claude/skills/` | `sync-schemas`, `daemon-restart` |
| Subagents (Claude Code) | `.claude/agents/` | `contract-shape-reviewer`, `billing-flow-reviewer` |
| Hooks (Claude Code) | `.claude/settings.json` + `.claude/hooks/` | auto-ruff after Python edits; auto `make schemas` after api_schemas.py edits |
| MCP servers (project scope) | `.mcp.json` | `context7` (live library docs), `postgres` (read-only against local dev DB) |

## Newcomer setup

```bash
# Once
make setup-hooks          # installs lefthook (brew) and wires git hooks
# Start everything
make dev-electron         # opens Electron + Vite + Runtime + auto-tail log
```

If anything is wrong, `make doctor` checks Runtime, Desktop ports, workspace dependencies, and secret leakage.

## Things to never do

- Don't read provider keys from Runtime env or restore a private Go Gateway adapter. Use the Runtime credential store and standard provider/MCP interfaces.
- Don't hand-edit `packages/runtime-client/src/generated.ts` or `packages/runtime-client/openapi.json`. They're build artifacts of `make schemas`.
- Don't `pkill -f 'shejane-runtime'` and assume the process died — uvicorn traps SIGTERM. Use `make restart-daemon` (or `lsof -ti :17371 | xargs kill -9`). The `daemon-restart` skill encapsulates this.
- Don't change SSE event names without checking `chatStore.ts` and `App.tsx` for switch cases that match. The whole pipeline silently no-ops on a typo'd event name.
- Don't return raw `dict[str, Any]` from a new endpoint — declare a pydantic response model. Otherwise `openapi.json` says `additionalProperties: true` and the schema pipeline has nothing to generate types from.
- Don't add Auto, fast/deep, or Cloud catalog model branches to Desktop or Runtime. Use concrete Runtime BYOK model selections.
