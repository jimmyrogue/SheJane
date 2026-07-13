# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

石间 / SheJane — an Agentic Chat product. A Go API backend handles auth/billing/LLM routing/document storage, a Python LangGraph daemon (the "local agent harness") runs the agent loop with tools and middleware, and an Electron/React renderer is what users see. Each layer has a distinct technology, distinct boundary, and the failure mode "things look fine but the next layer disagrees about the contract" is the single most common bug class this codebase has produced.

## Architecture

The diagram below describes the **current implementation**, including cloud dependencies that the target Runtime architecture intends to remove or make optional. Target P1-P12 stage numbering and migration boundaries live only in [docs/harness-runtime-stages.md](docs/harness-runtime-stages.md).

```
┌─────────────────────────────────────────────────────────────────┐
│  Electron renderer (client/) — React 18 + Vite + Tailwind 4    │
│  Talks to local-host over loopback HTTP for agent flow,         │
│  talks to Go API directly for auth / billing / documents.       │
└──────────┬──────────────────────────────────────────────┬───────┘
           │ /local/v1/* (loopback only, bearer token)    │ HTTPS
           ▼                                              ▼
┌─────────────────────────────────┐         ┌──────────────────────┐
│ Local-host daemon               │ ──────▶ │ Go API (api/)        │
│ local-host/python/local_host/   │         │ Postgres +           │
│ FastAPI + uvicorn               │         │ S3 (documents) +     │
│ LangGraph 1.2 + deepagents      │         │ Stripe (billing)     │
│ AsyncSqliteSaver (checkpoints)  │         │                      │
│                                 │         │ The cloud API holds  │
│ Tools either run locally        │         │ ALL platform-paid    │
│ (filesystem, workspace,         │         │ provider keys —      │
│  memory, optional MCP) OR proxy │         │ never the daemon.    │
│ through cloud Tool Gateway      │         │                      │
│ (image.*, web.search)           │         │                      │
└─────────────────────────────────┘         └──────────────────────┘
```

There's also an admin panel (`admin/`) — separate Vite/React app for the model catalog, credit-rate tuning, audit logs, and user/account operations.

The two runtime truth sources answer different questions:

- **[docs/harness-runtime-stages.md](docs/harness-runtime-stages.md)** — canonical target P1-P12 stages, migration seams, and the mandatory pre-change comparison order.
- **[docs/run-loop.md](docs/run-loop.md)** — current implementation from `POST /local/v1/runs` to terminal state, including middleware, HITL, and SSE behavior.

Never use `run-loop.md` to invent target phase numbers, and never describe unimplemented target behavior as current code.

**Sibling guides:** this file is the architecture + invariants. [AGENTS.md](AGENTS.md) is the day-to-day rulebook — it carries the detailed backend/billing/frontend rules (store dual-impl, wallet-ledger discipline, Stripe webhook idempotency, admin surfaces, the supported subscription lifecycle). [CONTRIBUTING.md](CONTRIBUTING.md) has dev setup + PR workflow. Current priorities live in [docs/roadmap.md](docs/roadmap.md). The product spec is [spec.md](spec.md).

## Critical invariants

These are not arbitrary style rules — each one corresponds to a class of bug that has actually shipped and burned hours in this repo.

1. **Platform-paid provider keys (OpenAI, Tavily, Anthropic, Stripe, AWS) MUST live in the Go API only.** The daemon proxies through `POST /api/v1/agent/tools/execute` for anything that bills credits. Enforced by `scripts/check-no-platform-keys-in-daemon.sh` (lefthook + CI). See `local-host/python/local_host/tools/_gateway.py` for the proxy pattern; new platform-paid tools should call `call_tool_gateway()`, not `os.environ.get(...)`.

2. **The daemon's pydantic models in `local-host/python/local_host/api_schemas.py` are the single source of truth for the HTTP shape.** FastAPI emits `openapi.json` from them; `openapi-typescript` regenerates `client/src/shared/local-host/generated.d.ts`; `client.ts` re-exports the generated types as aliases. Anytime you edit a model OR a handler's `response_model=` annotation, run `make schemas` and commit both `openapi.json` and `generated.d.ts`. CI's lint job fails the PR if they drift.

3. **The SSE wire envelope is non-negotiable.** Every event in `/local/v1/runs/:id/stream` ships as `data: {"event_type": ..., "payload": {...}, "id": ..., "run_id": ..., "created_at": ...}`; durable events also carry a monotonic `seq`, while temporary model output deliberately has no replay cursor. The separator is **LF** double-newline (not CRLF), and the terminator is `data: [DONE]` (not `event: stream.end`). Event names are `llm.delta` / `tool.completed` / `permission.required` etc. — NOT the old `llm.token` / `tool.end` names. Full spec in `docs/client-sse-protocol.md`.

4. **`make dev-electron` always hard-restarts.** It SIGKILLs any straggler daemon/vite/electron processes and frees ports before starting. Opt out only with `SHEJANE_DEV_REUSE=1`. The reason: uvicorn traps SIGTERM and can outlive a "graceful" restart, leaving the next session attached to a daemon with stale code in memory. If you suspect this, run `make doctor` to see the daemon's PID + start time.

5. **`.env` audit is honest.** Every key in `.env` corresponds to a real `os.getenv` / `getEnvInt` / pydantic alias somewhere in the code. Don't add dead keys; don't read undocumented keys. See `.env.example` for the schema with section comments.

6. **Model selection is a catalog, not fast/deep tiers.** Client requests send an Auto sentinel (`auto`, `auto.fast`, `auto.smart`) or a concrete catalog model id. Auto sentinels are resolved by the Go API against enabled chat models and emit `model.selected`; `auto.fast` / `auto.smart` are speed/capability preferences, not fixed tiers or model IDs. The daemon and web loop must not reintroduce their own fast/deep classifiers. The stable model id is still stored in `model_configs.slot` for migration safety, but docs and UI call it "model ID". Text model billing prefers CNY per-1M-token supplier prices for input/output/cache fields, with legacy input/output multipliers and `credit_multiplier` only as fallback; the global markup remains the margin knob. Image models are not shown in the chat picker; the current image resolver only supports `image.default`.

7. **Product-specific connectors do not belong in the runtime core.** The retired Lark/Feishu message-sync and todo pipeline must not be restored as private daemon routes, dedicated tables, or client state. Future business-platform integrations should use standard tools or MCP.

## Common commands

```bash
# Full dev stack — Docker compose + daemon + Vite + Electron + auto-tail log
make dev-electron

# After daemon code edits where stragglers might be running, OR after
# Docker images need rebuild (api/admin/postgres). Does
# `docker compose up -d --build` (rebuild WITH layer cache).
make dev-fresh

# Scorched-earth reset — when dev-fresh isn't enough: a poisoned
# build-cache layer (stale image despite --build, e.g. a client
# `COPY . .` cache-hit that skips `npm run build`) or a wedged
# container. Does `down --remove-orphans` + `build --no-cache` +
# `up --force-recreate`, then relaunches native. Keeps DB volumes
# (uploaded docs / conversations survive); for an empty DB run
# `docker compose down -v` first.
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
cd local-host/python && uv run python -m pytest tests/test_e2e_capabilities.py::test_capability_1d_scope_run_skips_subsequent_approvals -v

# A single client test
cd client && npm test -- --run -t "permission.resolved clears card"

# Lint — same checks CI runs
make lint

# Regenerate schemas after pydantic edits (REQUIRED if you touched api_schemas.py)
make schemas

# Smoke tests
make smoke-local-host        # standalone daemon HTTP smoke
make smoke-docker-local      # full Docker stack
make smoke-real-llm          # real LLM provider
make smoke-stripe-webhook    # Stripe webhook simulation

# Deploy / release (production — GHCR images + docker-compose.prod.yml)
make release VERSION=v0.1.0  # tag + push → CI builds & pushes images to GHCR
make deploy                  # pull prebuilt images + (re)start prod stack
make deploy-logs             # tail the prod stack

# Logs
make logs-local-host         # tail .tmp/dev/local-host.log
make logs-api                # tail docker compose api
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
| Model catalog / provider routing | `api/internal/modelreg/`, `api/internal/llm/router.go`, `api/internal/app/model_resolver.go`, `api/internal/httpapi/admin_modelconfig.go`, `admin/src/App.tsx`, `client/src/features/chat/components/ModeSelector.tsx` |
| Daemon code | `local-host/python/local_host/` — `server.py` 提供本地接口，`runs.py` 负责作业租约、执行、清理和结算，`agent/builder.py` 装配可复用 Agent 定义，`agent/subagents.py` 定义 Deep Agents 子 Agent，`middleware/` 负责输入观察、出站策略、工具可见性、人工确认、工具回执和唯一完成路由，`tools/` 保存工具实现，`store/sqlite.py` 保存 Runtime 状态与作业记录 |
| API code | `api/internal/` — `app/` wiring, `httpapi/` routes (incl. `tool_gateway.go` / `image_gateway.go` / `pdf_gateway.go` / `code_gateway.go`), `store/` (the `Store` interface + `memory.go`/`postgres.go` impls), `billing/` ledger, `llm/` provider gateway, `modelreg/` model registry, `documents/` S3 service, `e2b/` code-exec sandbox client, `secrets/` encryption |
| Client code | `client/src/` — `App.tsx` is the chat shell, `features/` holds `chat` (timeline + composer) plus `auth` / `mcp` / `skills`, `shared/local-host/client.ts` is the daemon RPC layer, `shared/api/sse.ts` parses SSE |
| Client visual system | `docs/ui/shejane-design-system.md` — June 2026 SheJane redesign tokens, brand mark, app-shell rules, and attachment/artifact glyph language |
| Admin panel | `admin/` — separate Vite app; model configs, credit rate, audit logs |
| Contract tests (real HTTP, not MockTransport) | `client/src/shared/local-host/client.contract.test.ts` |

## Conventions

### Python (local-host/python/)

- `uv` manages deps. Never edit `uv.lock` by hand — run `uv add <pkg>` or `uv remove <pkg>`.
- Lint: ruff (configured in `pyproject.toml`). Format: ruff format. `make lint` enforces.
- `from __future__ import annotations` everywhere; PEP 604 syntax (`str | None`, not `Optional[str]`).
- Tests use pytest + httpx.MockTransport for daemon HTTP and `local_host.config.reset_settings_for_tests(**overrides)` to swap settings.
- New tool: add `@tool("name.action")` in `local-host/python/local_host/tools/`, append to the registry in `tools/registry.py`. If the tool bills credits, route through `tools/_gateway.py:call_tool_gateway` — don't import the provider SDK directly.
- Gateway-billed tools today (proxy through `_gateway.py`, keys in the Go API only): `web.search` (Tavily), `image.*`, `pdf.inspect` (Poppler), `code.execute` (E2B microVM, brokered by `api/internal/e2b`). Everything else runs locally in the daemon: `web.fetch` (SSRF-guarded), deepagents filesystem/shell tools (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `execute`), `workspace.open`, `memory.*`, `office.*` read/write, and MCP tools. `browser.task` is optional future browser automation: unless both `browser-use` and a browser-specific LLM binding are configured, it is not exposed to `/local/v1/tools` or the agent toolset. `code.execute` is gated by the client's "Code Execution" toggle (`include_code_exec` in `build_tools`); the diagram's tool lists are illustrative, this bullet is the source of truth.
- New endpoint: add a pydantic model in `api_schemas.py`, declare `response_model=Model` on the handler, run `make schemas`, commit the regenerated files.

### Go (api/)

- `go vet ./...` + `gofmt -l` enforced via lefthook + CI.
- The credit ledger (`api/internal/billing/`) reserves credits BEFORE the external call and settles or releases AFTER. The pattern is `Reserve → external operation → Settle | Release`. Every code path that calls `Reserve` must have a guaranteed Settle/Release on every exit, including error paths. The `billing-flow-reviewer` subagent audits this on every billing-related change. Wallet balances move ONLY through this ledger (`billing/wallet.go`, writing `wallet_transactions`) — never mutate a balance ad hoc.
- `api/internal/store` is an interface (`store.go`) with two implementations that MUST stay in lockstep: `memory.go` (tests/dev) and `postgres.go` (prod), plus their `*_modelconfig.go` siblings for the model registry. Add a method to the interface → implement it in both, or the Postgres path silently diverges from a green in-memory test suite. This is the contract-drift bug class from the intro, living inside one stack.
- Stripe webhook handling must stay idempotent: dedupe on `stripe_events`, set `processed_at` only after local processing succeeds, and key credit grants with `wallet_transactions.idempotency_key = stripe:<event_id>`. See AGENTS.md for the full lifecycle + admin-audit rules.

### TypeScript (client/, admin/)

- Vite + React 18 + TypeScript strict mode. Tailwind 4 + shadcn/ui.
- Daemon types come from `client/src/shared/local-host/generated.d.ts` — re-exported as aliases in `client.ts`. Don't hand-write a new interface for daemon data; add it to `api_schemas.py` and regenerate.
- Hand-written types in `client.ts` are documented at the top of the file (DesktopBridge, LocalHostConfig, LocalHostProbe, LocalStreamHandlers) — these have no daemon equivalent.
- SSE: see `shared/api/sse.ts` for parsing and the `AgentRunEvent` union. New event types added on the daemon need a `case` in `features/chat/chatStore.ts:timelineItem` AND/OR `App.tsx:appendLocalRunEvent` to surface in the UI.

### Commits

- Conventional-ish messages (`feat:`, `fix:`, `ci:`, `docs:`) — no strict enforcement, but the existing history follows this. Lefthook only enforces non-empty + ≥5 chars.
- Pre-commit runs ruff/gofmt/go vet/no-platform-keys/no-env-files in parallel (~sub-second). To bypass for a WIP commit: `LEFTHOOK=0 git commit`.

## Automations already wired

| Type | Where | What |
|---|---|---|
| Pre-commit | `lefthook.yml` | ruff/gofmt/go vet/no-platform-keys/no-env-files |
| CI | `.github/workflows/ci.yml` | 4 parallel jobs: lint / test (unit + `-race` + build) / e2e (Playwright) / contract round-trip |
| Release | `.github/workflows/release.yml` | on `v*` tag: buildx multi-arch (amd64+arm64) → push `api`/`client`/`admin` images to GHCR |
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
cp .env.example .env      # optional local overrides

# Start everything
make dev-electron         # opens Electron + Vite + daemon + auto-tail log
```

If anything's wrong, `make doctor` is the first stop. The output tells you whether Docker is up, the daemon is on the new code, the LangSmith key is valid, and whether platform keys have leaked into the daemon env.

## Things to never do

- Don't add `os.environ.get("OPENAI_API_KEY")` or any other platform-paid key to daemon code. Use `tools/_gateway.py:call_tool_gateway`. Lefthook will block the commit.
- Don't hand-edit `client/src/shared/local-host/generated.d.ts` or `client/src/shared/local-host/openapi.json`. They're build artifacts of `make schemas`.
- Don't `pkill -f 'python -m local_host'` and assume the daemon died — uvicorn traps SIGTERM. Use `make restart-daemon` (or `lsof -ti :17371 | xargs kill -9`). The `daemon-restart` skill encapsulates this.
- Don't change SSE event names without checking `chatStore.ts` and `App.tsx` for switch cases that match. The whole pipeline silently no-ops on a typo'd event name.
- Don't return raw `dict[str, Any]` from a new endpoint — declare a pydantic response model. Otherwise `openapi.json` says `additionalProperties: true` and the schema pipeline has nothing to generate types from.
- Don't add new user-visible `fast` / `deep` model branches. Keep model selection as `auto` plus catalog model IDs from `GET /api/v1/models`.
