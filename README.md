<div align="center">

# 石间 · SheJane

**An agentic-chat product with a local agent harness.**

One composer — ask a question, drop a file, paste a URL, or describe a task.
SheJane decides whether to parse the document, call a tool, load a skill,
ask permission, verify the result, or run a multi-step agent loop.

English · [简体中文](./README.zh-CN.md)

</div>

---

> **Status:** pre-1.0, under active development. APIs and schemas may change.
>
> **Naming:** the product is **SheJane** / **石间**. `shejane` remains the
> compatibility name for package names, paths, and `SHEJANE_*` environment
> variables.

## What it is

SheJane runs the agent loop **on the user's machine** (a local LangGraph
daemon) while keeping auth, billing, and platform-paid provider keys in a
**cloud control plane**. The desktop app talks to the local daemon over
loopback for the agent flow, and to the cloud API directly for
auth/billing/documents.

```
┌──────────────────────────────────────────────────────────────┐
│  Electron + React client  (local-first chat history)          │
└───────┬───────────────────────────────────────────┬──────────┘
        │ /local/v1/* (loopback, bearer)            │ HTTPS
        ▼                                            ▼
┌─────────────────────────────┐        ┌─────────────────────────┐
│  Local agent harness        │ ─────▶ │  Go API (cloud)         │
│  Python · FastAPI · uvicorn │        │  Postgres · S3          │
│  LangGraph 1.2 + deepagents │        │  Stripe billing         │
│  AsyncSqlite checkpoints    │        │                         │
│                             │        │  Holds ALL platform-    │
│  Tools run locally OR proxy │        │  paid provider keys —   │
│  billed ones through the    │        │  never the daemon.      │
│  cloud Tool Gateway         │        │                         │
└─────────────────────────────┘        └─────────────────────────┘
```

A standalone **admin panel** (`admin/`) handles the model registry, credit
rates, users, orders, and audit logs.

## Current shape

| Area | Current implementation |
|---|---|
| Product | Local-first desktop chat with a cloud account/billing/model plane. |
| Models | `Auto`, `auto.fast`, and `auto.smart` resolve in the Go API against enabled admin-defined chat models; the daemon does not classify fast/deep tiers. |
| Billing | Unified credits with reserve -> settle -> release for LLM and cloud tools; Stripe Checkout is a one-time top-up flow. |
| Documents | Multi-file PDF/DOCX/XLSX/image attachments in the composer; document Q&A uses temporary S3 objects, not a team vector library. |
| Local agent | LangGraph/deepagents run loop with HITL approvals, checkpoints, subagents, skills, MCP, local schedules, verification, and progress ledger. |
| Business integrations | No built-in Lark/Feishu connector. Future platform integrations should use standard tools or MCP instead of private runtime paths. |
| Security posture | Open-source hardening is in `main`: `.env*` is ignored/guarded, production Postgres fails closed without `POSTGRES_PASSWORD`, local tools are workspace/approval bounded, and provider keys stay in the Go API. |

Deliberately deferred: semantic memory/summary with embeddings, one-click
recovery orchestration across failure categories, cross-device chat sync,
admin refunds/manual order mutation, and app signing/notarization.

## Features

- **Unified composer** — questions, file attachments (PDF / DOCX / XLSX /
  images), URLs, and complex tasks all go through one input.
- **Local agent harness** — LangGraph + deepagents middleware stack:
  planning, tool calls, memory, context compaction, verification, and
  human-in-the-loop permission gating.
- **Auto model catalog** — admins configure model IDs, providers, vendor
  metadata, capability tiers, token prices, and image pricing; users see Auto
  plus enabled chat models.
- **Tools**
  - Filesystem over an authorized workspace
  - Office read **and** write — `.docx` / `.xlsx` / `.pptx` (copy-on-write, original never touched)
  - PDF: server-side text + metadata extraction (Poppler), plus an on-demand `pdf.inspect` tool
  - Code execution in isolated **E2B microVM** sandboxes (matplotlib figures render inline)
  - Web fetch + cloud-billed web search (Tavily)
  - Image generation / editing (cloud-billed)
  - Playwright-managed browser (search / read / screenshot / click / type)
  - Memory, skills, and MCP servers (stdio / HTTP / SSE)
- **In-app document preview** — side panel renders `.docx` / `.xlsx` /
  `.pptx` outlines and PDFs (Chromium viewer), with download.
- **Cloud control plane** — JWT auth, a credit ledger (reserve → settle →
  release), LLM routing (DeepSeek / OpenAI-compatible / Anthropic), Stripe
  one-time credit top-ups, and S3-backed document storage.
- **Local-first history** — chat lives in the browser (IndexedDB); the
  backend stores usage metadata + billing, not full chat bodies.
- **Secret boundary by design** — platform-paid provider keys live only in
  the Go API; the daemon proxies billed tools through the cloud Tool
  Gateway. Enforced by hooks, CI, and runtime config checks.

## Quick start

Prerequisites: **Go 1.25+**, **Node 22+**, **Python 3.12+ with [uv](https://docs.astral.sh/uv/)**, **Docker**.

```bash
make setup-hooks            # install lefthook git hooks (once)
cp .env.example .env        # MOCK_LLM=true by default — no provider key needed
make dev-electron           # Docker (Postgres/API) + daemon + Vite + Electron
```

`MOCK_LLM=true` returns canned LLM responses, so the full stack runs with
zero external credentials. To use a real model, set `MOCK_LLM=false` and a
provider key in `.env` (a DeepSeek key covers most of it). See
[`.env.example`](./.env.example) for the full, commented config schema.

Trouble? `make doctor` diagnoses the common "why isn't dev working" causes.
Never commit `.env`; only `.env.example` is tracked.

## Tech stack

| Layer | Stack |
|---|---|
| Client | Electron · React 18 · Vite · TypeScript · Tailwind 4 · shadcn/ui |
| Daemon | Python 3.12 · FastAPI · uvicorn · LangGraph 1.2 · deepagents |
| API | Go 1.25 · Postgres · S3 · Stripe |
| Admin | React · Vite · shadcn/ui |

## Project layout

```
api/             Go API: auth, credit ledger, LLM routing, Tool Gateway, Stripe, documents, admin
local-host/      Python LangGraph daemon (the local agent harness) + tools + middleware
client/          Electron + React user app
admin/           Standalone admin panel
docs/            Architecture, run-loop, SSE protocol, operations
e2e/             Playwright end-to-end tests
```

## Documentation

- **[CLAUDE.md](./CLAUDE.md)** — architecture, the critical invariants, where things live, common commands.
- **[docs/harness-runtime-stages.md](./docs/harness-runtime-stages.md)** — the canonical target P1-P12 stages and mandatory pre-change comparison order.
- **[docs/harness-stage-improvement-notes.md](./docs/harness-stage-improvement-notes.md)** — consolidated keep, replace, delete, migration, and acceptance decisions for P1-P12.
- **[docs/run-loop.md](./docs/run-loop.md)** — the current implementation from POST to terminal (middleware, HITL, SSE events).
- **[docs/client-sse-protocol.md](./docs/client-sse-protocol.md)** — the client ↔ daemon SSE wire format.
- **[docs/document-tool-policy.md](./docs/document-tool-policy.md)** — attachment/tool mixing rules.
- **[docs/operations.md](./docs/operations.md)** — deployment + operations runbook.
- **[docs/roadmap.md](./docs/roadmap.md)** — current priorities and deferred work.
- **[spec.md](./spec.md)** — the local agent harness specification.

## Testing

```bash
make lint        # ruff + gofmt + go vet + secret-boundary guard
make test        # all four stacks (Go + Python + client + admin)
make build       # production build for API + client + admin + daemon deps
make test-e2e    # Playwright simulated end-to-end
```

Default tests are deterministic — no real LLM, Stripe, S3, Tavily, or
network. Real-service smoke tests are opt-in (`make smoke-*`).

## Contributing

PRs welcome — see **[CONTRIBUTING.md](./CONTRIBUTING.md)** for setup and the
workflow, and **[AGENTS.md](./AGENTS.md)** for the backend/frontend/testing
rules. Be kind: **[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)**.

Security issues: please follow **[SECURITY.md](./SECURITY.md)** (private
report), not a public issue.

## License

Copyright (c) 2026 TAO LIANG <tliang92@gmail.com>.

SheJane uses a dual-license model:

- Community use: [GNU Affero General Public License v3.0 only](./LICENSE) (`AGPL-3.0-only`).
- Proprietary distribution, closed-source modification, embedding, white-labeling, or other use that does not comply with the AGPL requires a [separate commercial license](./COMMERCIAL_LICENSE.md).

The SheJane name and logo are not licensed under the AGPL. See [TRADEMARKS.md](./TRADEMARKS.md). External contributions require agreement to [CLA.md](./CLA.md), and third-party components remain under the licenses listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
