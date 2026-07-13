# Contributing to SheJane (石间)

Thanks for your interest in contributing! This guide covers the dev
setup, the project layout, and the workflow we expect for pull requests.

SheJane uses `AGPL-3.0-only` for community releases and a separate commercial
license. Before a pull request can be accepted, each contributor must agree to
the [Contributor License Agreement](./CLA.md). The CLA lets TAO LIANG publish
the contribution under both licensing paths while the contributor keeps
ownership of their work.

## Architecture in one minute

SheJane is an agentic-chat product split across four stacks:

```
Electron/React client ──/local/v1/* (loopback)──▶ Python LangGraph daemon ──▶ Go API ──▶ Postgres / S3 / Stripe
        │                                          (local agent harness)        (cloud control plane)
        └────────────────────── HTTPS (auth / billing / documents) ────────────────────────┘
```

- `services/cloud/` — optional Go Cloud: auth, credit ledger, LLM routing, Tool Gateway, Stripe billing, documents (S3), admin APIs.
- `services/runtime/` — Python daemon (LangGraph + deepagents): runs the agent loop, tools, and middleware over loopback HTTP.
- `apps/desktop/` — Electron + React + Vite + Tailwind user app (local-first chat history).
- `apps/admin/` — standalone React/Vite admin panel (shadcn/ui).

**Read [CLAUDE.md](./CLAUDE.md) first** — it has the full architecture, the request flow (`docs/run-loop.md`), and the four non-negotiable invariants. [AGENTS.md](./AGENTS.md) has the backend/frontend/testing rules.

## Prerequisites

- **Go** 1.25+
- **Node** 22+
- **pnpm** 11.7.0 through Corepack
- **Python** 3.12+ with [`uv`](https://docs.astral.sh/uv/)
- **Docker** + Docker Compose (Postgres, API)
- macOS or Linux (the dev launcher is macOS-tuned; Linux works with minor tweaks)

## First-time setup

```bash
make setup-hooks            # installs lefthook + wires git hooks
corepack enable && pnpm install
cp .env.example .env        # optional local overrides
make dev-electron           # Docker + daemon + Vite + Electron, with log tail
```

The development Compose stack uses mock model responses by default, so it runs
without provider keys.

If anything looks wrong, `make doctor` is the first stop.

## The four invariants (don't break these)

1. **Platform-paid provider keys (OpenAI, Tavily, Anthropic, Stripe, AWS, E2B) live in the Go API only** — never in the Python daemon. Billed tools proxy through the cloud Tool Gateway (`services/runtime/local_host/tools/_gateway.py`). Enforced by `scripts/check-no-platform-keys-in-daemon.sh` (pre-commit + CI).
2. **The daemon's pydantic models are the source of truth for the HTTP shape.** After editing `api_schemas.py` or a handler's `response_model`, run `make schemas` and commit the regenerated `openapi.json` + `packages/runtime-client/src/generated.ts`.
3. **The SSE wire envelope is fixed.** See `docs/client-sse-protocol.md` before touching streaming.
4. **The credit ledger reserves before the external call and settles/releases after**, on every exit path including errors (`services/cloud/internal/billing/`).

## Workflow

1. Branch off `main` (`feat/…`, `fix/…`, `chore/…`, `docs/…`).
2. Make your change with a focused test where practical (we lean TDD for auth, wallet/ledger, Stripe, admin, SSE/chat-store, and import/export).
3. Run the checks below until green.
4. Open a PR against `main` and include this statement in the description:

   ```text
   I have read and agree to the SheJane Contributor License Agreement (CLA.md).
   ```

5. If the contribution belongs to an employer or another legal entity, identify it and confirm that you are authorized to contribute on its behalf.

## Tests & lint

```bash
make lint                   # ruff + gofmt + go vet + the no-platform-keys guard
make test                   # all four stacks (Go + Python + client + admin)

# focused:
make api-test               # go test ./...
make local-host-test        # uv run python -m pytest
make client-test            # client vitest
make admin-test             # admin vitest
```

CI runs the same lint + deterministic-test + contract jobs on every PR.

## Commit messages

Conventional-ish prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`,
`perf:`, `refactor:`). Pre-commit only enforces non-empty (≥5 chars);
the history follows the convention by habit.

## Reporting bugs / requesting features

Use the GitHub issue templates. For anything security-sensitive, follow
[SECURITY.md](./SECURITY.md) instead of opening a public issue.
