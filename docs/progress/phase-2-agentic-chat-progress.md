# Phase 2 Progress - Agentic Chat Direction

Updated: 2026-05-11

## Goal

Replace the old Phase 2 direction of scene cards, prompt templates, and separate document-reading/task-agent pages with a unified Agentic Chat direction.

Long-term target: **Local Agent Host + Cloud Control Plane**.

- Local Agent Host executes local tools, permissions, local MCP, files, terminal, browser, IDE, run events, and recovery.
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

## Current State

- Phase 2A document upload and single-file question answering remain implemented and are now exposed through the normal chat composer.
- The separate document-reading product surface has been removed from the user client.
- The user client now sends normal questions and attached-document questions through the cloud-compatible Agent Run protocol.
- Cloud events are short-lived operational records; local chat history remains in IndexedDB.

## Next Implementation Candidates

1. **Phase 2.2b Cloud Web Tools**
   - Add guarded `web.fetch` and optional `web.search` provider.
   - Add SSRF protection, text extraction, result-size caps, and source metadata.
   - Reuse the same Agent Run event model.

2. **Phase 2.3 Local Agent Host MVP**
   - Add Electron/local host boundary.
   - Add local health/tools/runs/permissions APIs.
   - Start with read-only local file and safe utility tools before shell/write tools.

## Boundaries

- No provider key is sent to client or Local Host.
- Admin sees usage, run summaries, tool failures, and audit, not private unsynced local content.
- Web can run only cloud-limited tools.
- Local files, shell, browser, IDE, and local MCP require Local Host and explicit permission.
- Scene cards and user-selected prompt templates are no longer the Phase 2 product direction.
