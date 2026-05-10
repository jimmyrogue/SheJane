# Phase 2 Progress - Agentic Chat Direction

Updated: 2026-05-10

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

## Current State

- Phase 2A document upload and single-file question answering remain implemented and useful.
- The current UI still contains a separate document-reading page; this is now considered a transitional surface.
- The next implementation phase should merge chat and document reading into one composer before adding broader tool execution.
- Cloud-compatible Agent Run APIs should be designed before Local Agent Host implementation so Web and Electron share the same event model.

## Next Implementation Candidates

1. **Phase 2.1 Unified Composer MVP**
   - Merge normal chat and document-reading entry.
   - Allow attachments on a normal message.
   - Reuse existing S3 document upload/complete/ask flow behind the composer.

2. **Phase 2.2 Cloud-Compatible Agent Run**
   - Add `agent_runs` and `agent_events`.
   - Add run/event/stream/cancel APIs.
   - Add event timeline UI and admin read-only observation.

3. **Phase 2.3 Local Agent Host MVP**
   - Add Electron/local host boundary.
   - Add local health/tools/runs/permissions APIs.
   - Start with read-only local file and safe utility tools before shell/write tools.

## Boundaries

- No provider key is sent to client or Local Host.
- Admin sees usage, run summaries, tool failures, and audit, not private unsynced local content.
- Web can run only cloud-limited tools.
- Local files, shell, browser, IDE, and local MCP require Local Host and explicit permission.
- Scene cards and user-selected prompt templates are no longer the Phase 2 product direction.
