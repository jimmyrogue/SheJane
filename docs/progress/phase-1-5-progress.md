# Phase 1.5 Progress Tracker

Updated: 2026-05-10

## Goal

Phase 1.5 turns the Phase 1 mock chat into a real LLM-backed chat flow. The first provider target is DeepSeek through the existing OpenAI-compatible provider path.

## Boundary

- In scope: real DeepSeek provider config, streaming usage parsing, local smoke script, operations notes, and README updates.
- Out of scope: a full admin dashboard UI, team management, manual credit adjustment screens, cloud history sync, RAG, file parsing, and new paid plan logic.

## Status Legend

- `Not started`: no file or test exists yet.
- `Red`: failing test created and verified.
- `Green`: focused tests pass.
- `Verified`: full verification command passed after integration.
- `Configured only`: code/config exists, but real external credentials are required for live verification.
- `Blocked`: cannot be completed without external credentials or infrastructure.

## Checklist

| Area | Status | Evidence |
| --- | --- | --- |
| Scope decision | Verified | Phase 1.5 is real LLM provider integration, not an admin UI build |
| DeepSeek API compatibility | Verified | Official docs confirm OpenAI-compatible `/chat/completions`, SSE streaming, and `stream_options.include_usage` |
| Provider request payload | Green | `TestOpenAICompatibleProviderRequestsUsageInStream` covers `stream_options.include_usage=true` |
| Usage-only SSE parsing | Green | `TestOpenAICompatibleProviderStreamsContentAndUsageOnlyEvent` covers final usage chunks with empty `choices` |
| DeepSeek default config | Green | `FAST_PROVIDER_BASE_URL=https://api.deepseek.com`, `FAST_MODEL=deepseek-v4-flash` |
| Local real LLM smoke | Green | `scripts/smoke-real-llm.sh` registers a user, sends a real chat, and fails if response is still mock |
| Operator documentation | Green | `docs/operations.md` explains Docker management, logs, SQL checks, and admin-system plan |
| README | Green | Root README documents Phase 1.5 real DeepSeek setup and smoke command |
| Live DeepSeek verification | Verified | User configured a real provider key locally and confirmed chat now talks to the real API |
| Final verification | Verified | `bash -n scripts/smoke-real-llm.sh`, `make test`, and `make build` passed locally; real-provider smoke was completed by user |

## Admin System Decision

There is a product-level plan for an admin system, but it should not block Phase 1.5. The recommended path is:

1. Add read-only operations visibility first: users, calls, provider cost, credits, failures.
2. Add controlled manual actions second: credit grant, account disable/enable, payment reconciliation notes.
3. Add team management after individual usage and billing are stable.

For now, system management is done through Docker, API logs, PostgreSQL queries, and external provider dashboards.

## Phase 1.5 Closeout

Status: locally complete and user verified.

Accepted local workflows:

- Configure a real DeepSeek/OpenAI-compatible provider key.
- Run the app with `MOCK_LLM=false`.
- Send a chat message through the product UI.
- Confirm the assistant response comes from a real provider instead of the mock provider.

Remaining non-local item:

- Production deployment still needs target host, DNS, secrets, and post-deploy smoke verification.
