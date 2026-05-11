# Phase 2 Progress - Local Agent Harness Direction

Updated: 2026-05-11

## Goal

Replace the old Phase 2 direction of scene cards, prompt templates, and separate document-reading/task-agent pages with a unified Agentic Chat UX backed by a Local Agent Harness.

Long-term target: **Local Agent Harness + Cloud Control Plane**.

- Local Agent Harness owns the 12 harness components: orchestration loop, tools, memory, context management, prompt construction, output parsing, state management, error handling, guardrails, verification loops, subagent data structures, and lifecycle management.
- Local Host / User Worker executes local tools, permissions, local MCP, files, terminal, browser, IDE, run events, checkpoints, artifacts, and recovery.
- Cloud Control Plane keeps auth, billing, payment, model gateway, temporary documents, admin, audit, and run summaries.

## Completed

- [x] Added root [`spec.md`](../../spec.md) as the Agentic Chat architecture specification.
- [x] Updated [`project-plan.md`](../../project-plan.md) to replace Phase 2 scene-template workbench with Agentic Chat phases.
- [x] Updated [`frontend-spec.md`](../../frontend-spec.md) to define unified composer, run timeline, Local Host boundary, and Phase 2/3/4 acceptance criteria.
- [x] Updated [`backend-spec.md`](../../backend-spec.md) to define Cloud Control Plane responsibilities, agent run/event tables, cloud-compatible run APIs, and Local Host cooperation.
- [x] Updated [`README.md`](../../README.md) to explain the new Phase 2 direction while preserving the current Phase 2A document capability as a transitional implementation.
- [x] Updated [`docs/operations.md`](../operations.md) with Agentic Chat operational boundaries and Local Host/cloud responsibilities.
- [x] Implemented Phase 2.1 unified composer in the user client.
- [x] Reused existing Phase 2A document upload, complete, and ask APIs behind the unified composer.
- [x] Stored attached-document answers in local chat history instead of a separate document-answer panel.
- [x] Implemented Phase 2.2 cloud-compatible Agent Run MVP:
  - `agent_runs` / `agent_events` migration and store support.
  - `POST /api/v1/agent/runs`, `GET /api/v1/agent/runs/{id}`, `GET /api/v1/agent/runs/{id}/events`, `GET /api/v1/agent/runs/{id}/stream`, `POST /api/v1/agent/runs/{id}/cancel`.
  - Agent event SSE with `run.created`, `run.started`, `skill.selected`, `tool.requested`, `tool.completed`, `llm.started`, `llm.delta`, `run.completed`, `run.failed`, `run.canceled`.
  - Document attachments now execute through the Agent Run `document.read` tool path.
  - Agent LLM calls reuse wallet reservation/settlement and write `llm_call_records(scene=agent)`.
  - Admin web has a read-only Agent Runs observation tab.
- [x] Replaced root [`spec.md`](../../spec.md) with the Local Agent Harness spec and 12-component implementation model.
- [x] Added Phase 2.3a daemon foundation:
  - New [`local-host/`](../../local-host) Node/TypeScript module.
  - Loopback `GET /local/v1/health`.
  - Pairing-token protected `GET /local/v1/tools`, `POST /local/v1/runs`, `GET /local/v1/runs/{id}`, `GET /local/v1/runs/{id}/stream`, `POST /local/v1/runs/{id}/cancel`, permission stub, artifact stub.
  - Typed tool registry for `time.now`, `workspace.open`, `file.read`, `file.search`, `shell.run`.
  - Local SQLite store for runs/events and in-memory store for tests.
  - Electron preload exposes Local Host base URL.
  - React client probes Local Host health only in Electron and displays `本地 Harness` / `云端受限`.
- [x] Implemented Phase 2.4 Harness Loop MVP:
  - Local TAO loop with model call -> tool call -> observation -> next model call.
  - `time.now`, `file.read`, `file.search`, and permission-gated `shell.run`.
  - Workspace boundary protection for file and shell tools.
  - Permission request persistence and approval execution path.
  - Cloud `/api/v1/agent/llm` model gateway with wallet settlement and `llm_call_records(scene=agent_local)`.
  - Cloud `/api/v1/agent/tool-events` redacted summary intake.
  - OpenAI-compatible provider non-streaming tool-call completion parser.

## Current State

- Phase 2A document upload and single-file question answering remain implemented and are now exposed through the normal chat composer.
- The separate document-reading product surface has been removed from the user client.
- The user client now sends normal questions and attached-document questions through the cloud-compatible Agent Run protocol.
- Electron can detect the local daemon foundation. The local daemon can run the MVP TAO loop when provided a cloud access token and an authorized workspace path.
- Cloud events are short-lived operational records; local chat history remains in IndexedDB.

## Next Implementation Candidates

1. **Permission and Artifact UI**
   - Render local permission requests, approvals/denials, workspace picker, and artifact previews in the unified composer.

2. **MCP Runtime Adapter**
   - Connect allowlisted local MCP tools to the user-worker runtime while keeping per-tool permission and audit events.

## Boundaries

- No provider key is sent to client or Local Host.
- Admin sees usage, run summaries, tool failures, and audit, not private unsynced local content.
- Web can run only cloud-limited tools.
- Local files, shell, browser, IDE, and local MCP require Local Harness and explicit permission.
- Scene cards and user-selected prompt templates are no longer the Phase 2 product direction.
