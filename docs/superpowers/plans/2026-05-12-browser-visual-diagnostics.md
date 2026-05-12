# Phase 2.19 and 2.20 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add browser visual/page verification and an Electron-visible current-run diagnostics panel so browser research becomes easier to trust and debug.

**Architecture:** Phase 2.19 adds one read-only Local Host tool, `browser.verify`, that checks the current managed browser page against expected text/status and can attach a screenshot artifact. Phase 2.20 reuses the existing redacted diagnostics API and adds client UI to fetch, inspect, and export diagnostics for the current assistant run, without exposing full artifact bodies by default.

**Tech Stack:** Node/TypeScript Local Host, Vitest, React/TypeScript client, Playwright E2E, existing Local Host loopback APIs.

---

### File Map

- Modify `local-host/src/tools/registry.ts`: register `browser.verify`.
- Modify `local-host/src/tools/executor.ts`: implement `browser.verify`, shared page verification helpers, optional screenshot artifact.
- Modify `local-host/src/harness/runner.ts`: add verification check and prompt guidance for `browser.verify`.
- Modify `local-host/src/tools/browserEnvironment.test.ts`: tool-level tests for verify pass/fail/no-page.
- Modify `local-host/src/harness/runner.test.ts`: harness loop test that stores screenshot artifact and emits verification result.
- Modify `client/src/features/chat/chatStore.ts`: labels for `browser.verify`.
- Modify `client/src/shared/local-data/types.ts`: optional diagnostics metadata on timeline items if needed.
- Modify `client/src/App.tsx`: current-run diagnostics button, diagnostics panel, and export path.
- Modify `client/src/styles.css`: diagnostics panel styles.
- Modify `client/src/App.test.tsx`: component tests for diagnostics open/export and verify label.
- Modify `e2e/tests/helpers.ts`: mock current-run diagnostics.
- Modify `e2e/tests/client.spec.ts`: simulated user test for opening current-run diagnostics.
- Modify `spec.md`, `project-plan.md`, `docs/operations.md`, and `docs/progress/phase-2-local-harness-progress.md`: document Phase 2.19/2.20 scope and verification.

### Task 1: Phase 2.19 Browser Verify Tool

**Files:**
- Modify: `local-host/src/tools/browserEnvironment.test.ts`
- Modify: `local-host/src/tools/registry.ts`
- Modify: `local-host/src/tools/executor.ts`
- Modify: `local-host/src/harness/runner.ts`
- Modify: `local-host/src/harness/runner.test.ts`

- [x] **Step 1: Write failing tool tests**

Add tests proving:
- `browser.verify` before a page exists returns `browser_page_required`.
- `browser.verify` with `expectText` present returns `verification_status=passed`.
- `browser.verify` with `expectText` missing returns `ok=true`, `verification_status=failed`, and a screenshot artifact when `includeScreenshot=true`.

Run: `cd local-host && npm test -- --run src/tools/browserEnvironment.test.ts -t "browser.verify"`

Expected before implementation: failures showing `unknown_tool`.

- [x] **Step 2: Register the tool**

Add a `browser.verify` tool after `browser.read` with:
- `permissionPolicy: "allow"`
- `isReadOnly: true`
- input fields `expectText`, `requireUsable`, and `includeScreenshot`

- [x] **Step 3: Implement the executor path**

Add `case "browser.verify"` to `executeTool`. Implementation reads the current browser snapshot, classifies `observation_status`, checks whether `expectText` appears in title, description, visible text, URL, or link text, and optionally captures a PNG screenshot artifact.

The tool returns `ok=true` when it can inspect the page, even if verification fails, because failed verification is a successful tool observation. It returns `ok=false` only when no page exists or the browser adapter fails.

- [x] **Step 4: Add harness verification and prompt guidance**

Add `browser_verify_ok` in `verificationChecks`, passing only when `verification_status=passed`. Update the local system prompt to tell the model to call `browser.verify` before final answers when the target information may be visual, tabular, or card-like.

- [x] **Step 5: Add harness test**

Add a runner test where the model opens a page, calls `browser.verify` with `includeScreenshot=true`, receives an artifact reference, emits `verification.completed` with `browser_verify_ok`, and then completes.

Run: `cd local-host && npm test -- --run src/tools/browserEnvironment.test.ts src/harness/runner.test.ts -t "browser.verify|visual verification"`

Expected after implementation: pass.

### Task 2: Phase 2.20 Current Run Diagnostics Panel

**Files:**
- Modify: `client/src/features/chat/chatStore.ts`
- Modify: `client/src/App.tsx`
- Modify: `client/src/styles.css`
- Modify: `client/src/App.test.tsx`
- Modify: `e2e/tests/helpers.ts`
- Modify: `e2e/tests/client.spec.ts`

- [x] **Step 1: Write failing client tests**

Add tests proving:
- `browser.verify` timeline label renders as `验证网页`.
- A local assistant message with `runId` shows a diagnostics button.
- Clicking diagnostics fetches `/local/v1/runs/{id}/diagnostics` and shows status, events count, permissions count, artifacts count, latest checkpoint summary, and recent tool/error events.
- Export downloads a redacted diagnostics JSON blob.

Run: `cd client && npm test -- --run src/App.test.tsx src/features/chat/chatStore.test.ts -t "diagnostics|browser.verify"`

Expected before implementation: failures for missing label/button/panel.

- [x] **Step 2: Implement timeline label**

Add `browser.verify: "验证网页"` to the client tool label map.

- [x] **Step 3: Implement diagnostics panel state**

In `client/src/App.tsx`, add state for the currently viewed diagnostics. Add a button near local assistant timelines when `message.runId` exists. Fetch diagnostics through existing `getLocalRunDiagnostics`.

- [x] **Step 4: Render safe diagnostics summary**

Render:
- run id, status, goal
- events count, permissions count, artifacts count
- latest checkpoint id/reason/messages count
- recent `tool.failed`, `run.failed`, `verification.completed`, and `source.collected` events

Do not render artifact content or full checkpoint messages.

- [x] **Step 5: Add current-run diagnostics export**

Reuse Blob download logic with filename `jiandanly-local-run-{runID}-diagnostics.json`. Keep URL revocation.

- [x] **Step 6: Add E2E coverage**

Mock `/local/v1/runs/local-run/diagnostics`, click diagnostics after a local harness run, assert the panel opens and export route is called.

Run: `E2E_CLIENT_PORT=55273 E2E_ADMIN_PORT=55274 make test-e2e`

Expected after implementation: pass.

### Task 3: Docs and Full Verification

**Files:**
- Modify: `spec.md`
- Modify: `project-plan.md`
- Modify: `docs/operations.md`
- Modify: `docs/progress/phase-2-local-harness-progress.md`

- [x] **Step 1: Update docs**

Document:
- Phase 2.19 `browser.verify`, screenshot artifact behavior, and verification semantics.
- Phase 2.20 current-run diagnostics panel, safe fields, and export path.
- Boundaries: no LLM vision judge yet, no user Chrome control, no screenshot OCR of desktop apps, diagnostics remain redacted.

- [x] **Step 2: Run full verification**

Run:

```bash
make test
make build
E2E_CLIENT_PORT=55273 E2E_ADMIN_PORT=55274 make test-e2e
git diff --check
```

Expected: all commands exit 0.

- [x] **Step 3: Manual smoke guidance**

Document the Electron smoke:

```bash
make dev-electron
```

Then ask the agent to search a current webpage, collect sources, call browser verification, open diagnostics for the current run, and export diagnostics.
