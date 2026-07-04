# Agent Failure Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement LangGraph-inspired failure recovery across runtime, persistence, and UI so failed or paused agent work has one clear recovery path after retries, user fixes, or app restarts.

**Architecture:** Local-host remains the source of truth for failure classification, retryability, and run/checkpoint state. The renderer derives buttons and banners from persisted assistant messages and local-host events instead of owning recovery semantics. This mirrors LangGraph's split: retry/timeout/error-handler/interrupt in runtime, checkpoint/thread state in persistence, UI as a thin resume/retry surface.

**Tech Stack:** Python FastAPI local-host, LangGraph AsyncSqliteSaver, TypeScript React renderer, IndexedDB local conversations, Vitest, pytest.

---

## File Map

- `local-host/python/local_host/failure_policy.py`  
  Add one runtime-owned `recovery_action` field derived from the existing category/action kind. Keep classification pure and dependency-free.

- `local-host/python/tests/test_failure_policy.py`  
  Lock the recovery-action matrix with focused tests.

- `local-host/python/local_host/runs.py`  
  Ensure every terminal `run.failed` payload includes `recovery_action`; keep `waiting_permission` and `waiting_input` as paused states, not failures.

- `local-host/python/local_host/api_schemas.py`  
  Add `recovery_action` to `DiagnosticsFailure` after local-host tests prove the payload.

- `client/src/shared/local-data/types.ts`  
  Store optional `failureRecoveryAction` on `AgentTimelineItem`.

- `client/src/features/chat/chatStore.ts`  
  Preserve `payload.recovery_action` from `run.failed` and `tool.failed`.

- `client/src/features/chat/recovery.ts`  
  Prefer daemon-provided `failureRecoveryAction`; keep current category fallback for old persisted messages.

- `client/src/features/chat/recovery.test.ts`  
  Add tests for daemon-provided action precedence and legacy fallback.

- `client/src/features/chat/recoverableFailures.ts`  
  Add a tiny scanner for recent persisted failed assistant messages after app restart.

- `client/src/App.tsx`  
  Show one non-blocking startup notice when recent recoverable failures exist; do not auto-run.

- `docs/run-loop.md`  
  Document the LangGraph-style failure layers and the restart behavior.

---

## Phase 0: Current UI Recovery Core

- [x] Extract renderer recovery state to `client/src/features/chat/recovery.ts`.
- [x] Deduplicate retry/repair/recharge in-flight actions per `{conversationID, assistantMessageID}`.
- [x] Keep cloud-session recovery pending scoped to the original user.
- [x] Reuse one failure-to-action mapping in `AgentProgress`.
- [x] Add focused Vitest coverage.

## Phase 1: Runtime-Owned Recovery Action

**Why:** LangGraph keeps failure strategy in runtime policy. The renderer should not be the first place that decides "quota means recharge" or "auth means refresh session".

- [x] Add a failing test in `local-host/python/tests/test_failure_policy.py`:

```python
def test_failure_policy_exposes_recovery_action_for_ui() -> None:
    cases = [
        ("retry", {"error_code": "rate_limit", "message": "provider returned 429"}),
        ("recharge", {"error_code": "insufficient_credits", "message": "quota exhausted"}),
        ("refresh_session", {"error_code": "cloud_session_required", "message": "login first"}),
        ("workspace", {"error_code": "path_outside_workspace", "message": "workspace denied"}),
        ("retry", {"error_code": "permission_denied", "message": "permission denied"}),
        ("repair", {"error_code": "validation_failed", "message": "invalid tool arguments"}),
        ("diagnostics", {"error_code": "missing_api_key", "message": "api key missing"}),
        ("diagnostics", {"error_code": "RuntimeError", "message": "RuntimeError: boom"}),
        ("diagnostics", {"error_code": "unknown_failure", "message": "unexpected failure"}),
    ]

    for expected, payload in cases:
        failure = classify_failure_payload("run.failed", payload)
        assert failure["recovery_action"] == expected
```

- [x] Run:

```bash
cd local-host/python && uv run python -m pytest tests/test_failure_policy.py::test_failure_policy_exposes_recovery_action_for_ui -q
```

Expected: fail because `recovery_action` does not exist.

- [x] Implement the smallest change in `failure_policy.py`:

```python
def _recovery_action(category: str, action_kind: str) -> str:
    if action_kind == "retry":
        return "retry"
    if action_kind == "repair":
        return "repair"
    if category == "quota":
        return "recharge"
    if category == "auth":
        return "refresh_session"
    if category == "workspace":
        return "workspace"
    if category == "permission":
        return "retry"
    return "diagnostics"
```

Add `"recovery_action": _recovery_action(category, action_kind)` to the returned classification dict.

- [x] Run:

```bash
cd local-host/python && uv run python -m pytest tests/test_failure_policy.py -q
```

Expected: all failure policy tests pass.

## Phase 2: Surface The Contract Through Events And Diagnostics

**Why:** Persisted events are our checkpoint-adjacent failure provenance. If `run.failed` carries the recovery action, restart recovery works without preserving UI refs.

- [x] Add `recovery_action` to `DiagnosticsFailure` in `api_schemas.py`:

```python
recovery_action: Literal["retry", "repair", "recharge", "refresh_session", "workspace", "diagnostics"]
```

- [x] Add/adjust a focused local-host test so a failed run diagnostics response includes:

```python
assert diagnostics["handoff"]["failure"]["recovery_action"] == "retry"
```

Use the existing diagnostics/failure tests as the insertion point; do not create a new fixture stack.

- [x] Confirm `_run_failed_payload()` needs no custom logic beyond `classify_failure_payload()`:

```python
for key in ("category", "recoverable", "retryable", "action_kind", "suggested_action", "recovery_action"):
    payload.setdefault(key, classification[key])
```

- [x] Run:

```bash
cd local-host/python && uv run python -m pytest tests/test_runs_http.py tests/test_failure_policy.py -q
```

Expected: pass.

- [x] Run schema generation because `api_schemas.py` changed:

```bash
make schemas
```

Expected: local-host OpenAPI and generated TS types update cleanly.

## Phase 3: Renderer Reads Runtime Recovery Action First

**Why:** The client should remain backward-compatible with old persisted failures, but new failures should use the daemon's decision.

- [x] Add `failureRecoveryAction?: string` to `AgentTimelineItem` in `client/src/shared/local-data/types.ts`.

- [x] In `client/src/features/chat/chatStore.ts`, parse `payload.recovery_action`:

```ts
const failureRecoveryAction = stringValue(payload.recovery_action)
```

and store:

```ts
...(failureRecoveryAction ? { failureRecoveryAction } : {}),
```

- [x] Update `client/src/features/chat/recovery.ts`:

```ts
if (isAgentFailureAction(event.failureRecoveryAction)) {
  return event.failureRecoveryAction
}
```

Keep the existing category/action-kind fallback below it.

- [x] Add a tiny guard:

```ts
function isAgentFailureAction(value: unknown): value is AgentFailureAction {
  return value === 'retry' || value === 'repair' || value === 'recharge' || value === 'refresh_session' || value === 'workspace' || value === 'diagnostics'
}
```

- [x] Add tests in `client/src/features/chat/recovery.test.ts`:

```ts
expect(failureRecoveryAction({
  type: 'run.failed',
  label: 'runtime says diagnostics',
  failureCategory: 'transient',
  failureActionKind: 'retry',
  failureRecoveryAction: 'diagnostics',
})).toBe('diagnostics')
```

- [x] Run:

```bash
cd client && npm test -- --run src/features/chat/recovery.test.ts src/features/chat/chatStore.test.ts
```

Expected: pass.

## Phase 4: Restart Recovery Notice

**Why:** LangGraph resumes from persisted `thread_id`/checkpoint state. Our renderer should similarly derive recovery affordances from persisted conversation events after restart, but should not auto-run.

- [x] Create `client/src/features/chat/recoverableFailures.ts`:

```ts
import type { ChatMessage, Conversation } from '@/shared/local-data/types'
import { failureRecoveryAction, type AgentFailureAction, type RecoveryTarget } from './recovery'

export interface RecoverableFailure {
  target: RecoveryTarget
  action: AgentFailureAction
  message: ChatMessage
  updatedAt: string
}

export function recentRecoverableFailures(conversations: Conversation[], limit = 3): RecoverableFailure[] {
  const failures: RecoverableFailure[] = []
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      if (message.role !== 'assistant' || message.status !== 'error') continue
      const failed = [...(message.agentEvents ?? [])].reverse().find((event) => event.type === 'run.failed')
      const action = failureRecoveryAction(failed)
      if (!action) continue
      failures.push({
        target: { conversationID: conversation.id, assistantMessageID: message.id },
        action,
        message,
        updatedAt: conversation.updatedAt,
      })
    }
  }
  return failures
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}
```

- [x] Add `client/src/features/chat/recoverableFailures.test.ts` covering:
  - ignores successful assistant messages
  - returns newest failed assistant messages first
  - respects limit
  - preserves target IDs

- [x] In `App.tsx`, after conversations load, show one startup notice if failures exist:

```ts
const startupRecoveryNoticeShownRef = useRef(false)
```

Then:

```ts
useEffect(() => {
  if (startupRecoveryNoticeShownRef.current || conversations.length === 0) return
  const [failure] = recentRecoverableFailures(conversations, 1)
  if (!failure) return
  startupRecoveryNoticeShownRef.current = true
  setNotice(t('app.notice.recoverableFailureAfterRestart'), {
    duration: 8000,
    action: {
      label: t('agent.failureAction.retry'),
      onClick: () => {
        setActiveConversationID(failure.target.conversationID)
        setMainView('chat')
      },
    },
  })
}, [conversations, t])
```

The action opens the chat only. It does not auto-run.

- [x] Add i18n strings:

```ts
'app.notice.recoverableFailureAfterRestart': '有任务上次失败后仍可恢复，已为你保留在原对话里',
```

English:

```ts
'app.notice.recoverableFailureAfterRestart': 'A previous failed task can still be recovered from its original chat.',
```

- [x] Run:

```bash
cd client && npm test -- --run src/features/chat/recoverableFailures.test.ts src/App.test.tsx
```

Expected: pass.

## Phase 5: Keep Pauses Separate From Failures

**Why:** LangGraph `interrupt()` is not a failed run. User approvals, questions, and plan approvals should stay `waiting_permission` / `waiting_input`.

- [x] Confirm local-host pause tests:

```python
assert run["status"] in {"waiting_permission", "waiting_input"}
assert not any(event["event_type"] == "run.failed" for event in events)
```

for permission and question pauses.

- [x] Add/confirm renderer tests:

```bash
cd client && npm test -- --run src/features/chat/pendingApproval.test.ts src/features/chat/pendingQuestion.test.ts src/features/chat/pendingPlanApproval.test.ts
```

Expected: pause bars render; no recovery CTA replaces the pause UI.

## Phase 6: Docs And Verification

- [x] Update `docs/run-loop.md` with this contract:

```text
Runtime layer:
retry / timeout / error_handler / interrupt / terminal failed

Persistent layer:
run events + checkpoint + diagnostics handoff carry failure provenance

UI layer:
derive CTA from persisted failure recovery_action; never auto-run after restart
```

- [x] Run focused checks:

```bash
cd local-host/python && uv run python -m pytest tests/test_failure_policy.py tests/test_runs_http.py -q
cd client && npm test -- --run src/features/chat/recovery.test.ts src/features/chat/recoverableFailures.test.ts src/features/chat/components/AgentProgress.test.tsx src/App.test.tsx
git diff --check
```

- [x] Run broader checks before handoff:

```bash
make test
make build
```

If full client Vitest is killed by local resource pressure, report it honestly and include the focused passing tests.

## Deliberately Skipped

- No global Zustand/Redux store. Recovery state is derived from persisted events.
- No auto-run after restart. User action is required.
- No connector-specific recovery framework yet. Lark/document recovery should join only when those errors emit stable `recovery_action` values.
- No new daemon endpoint unless the event payload proves insufficient.
