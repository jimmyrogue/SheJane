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

- `services/runtime/` — Python LangGraph daemon (the local agent harness): runs the agent loop, tools, and middleware over loopback HTTP.
- `apps/desktop/` — Electron/React client; local projection of Runtime-owned conversations.
- `packages/runtime-client/` — public TypeScript SDK for Runtime commands, SSE, snapshots, and generated protocol types.
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
cd services/runtime && uv run python -m pytest
pnpm --filter @shejane/desktop test --run
pnpm --filter @shejane/runtime-client test
```

Use `make smoke-local-host` for a deterministic Runtime HTTP smoke.

## Environment And Secrets

- There is no root `.env`. Never print or commit real secrets from module env files.
- Runtime BYOK keys enter through Runtime settings and live in the operating-system credential store.
- Local default ports:
  - Desktop Vite: `http://localhost:55173`
  - Runtime: managed dynamically by Electron; source default `http://127.0.0.1:17371`

## Runtime Model Rules

- Desktop reads enabled models from Runtime and submits concrete `local:<provider>:<model>` selections.
- Do not reintroduce Auto, fast/deep UX, Go Cloud model discovery, or daemon-side model classifiers in Desktop/Runtime.
- Runtime provider configuration lives in SQLite; provider secrets live in the operating-system credential store.

## Frontend Rules

Desktop UI expectations:

- Runtime owns authoritative conversations and task state; Desktop stores a disposable local projection and pending commands.
- Keep import/export behavior intact.
- Follow the SheJane visual system in `docs/ui/shejane-design-system.md`: warm paper + ink, seal red only for brand/running/critical states, moss only for online/success, and single-color typographic attachment glyphs instead of colorful file icons.

## Testing Expectations

Use TDD for new behavior whenever practical:

1. Add a focused failing test.
2. Run the focused command and see the expected failure.
3. Implement the smallest passing change.
4. Run focused tests, then `make test`.

Add or update tests when touching:

- Runtime provider/model validation or model picker behavior
- local conversation projection and data import/export
- SSE parsing or chat store behavior

## Documentation Expectations

- Update `README.md` for user/developer setup changes.
- Update `docs/operations.md` for operational, Runtime settings, packaging, or release changes.
- Keep docs truthful about boundaries. Mark unimplemented future work as future work, not hidden capability.

## Git And Generated Files

- Do not revert user changes.
- Do not commit or reset unless the user asks.
- Do not check in build output from `apps/desktop/dist`.
- Prefer `rg` and `rg --files` for repository searches.
- Use `apply_patch` for manual edits.
