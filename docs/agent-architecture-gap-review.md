# Agent Architecture Gap Review

Updated: 2026-06-11

This review reconciles the current SheJane docs and code with the agent
architecture patterns in LangGraph, OpenAI Agents SDK, Anthropic long-running
harness guidance, and MCP. It is an implementation-facing snapshot, not a
product promise.

## Source Of Truth

- Current run lifecycle: [run-loop.md](run-loop.md)
- Wire protocol: [client-sse-protocol.md](client-sse-protocol.md)
- Operations boundary: [operations.md](operations.md)
- Product direction: [../spec.md](../spec.md)
- Current priorities: [roadmap.md](roadmap.md)

Treat [migration-langgraph.md](migration-langgraph.md) as historical context.
Treat [specs/universal-tool-primitives.md](specs/universal-tool-primitives.md)
as a target vocabulary, not the current tool registry.

## External Baseline

| Reference | What matters for SheJane | Current fit |
|---|---|---|
| LangGraph | Durable execution, checkpoints, thread IDs, streaming, memory/store, interrupt/resume. | Strong fit: `AsyncSqliteSaver`, per-run `thread_id`, HITL resume, SSE envelope, local event log. |
| OpenAI Agents SDK | Agents, tools, handoffs, guardrails, sessions, tracing, human approval for tools. | Partial fit: tools, subagents, guard middleware and event tracing exist; handoff input filtering and web loop session recovery are still thin. |
| Anthropic long-running harness | Incremental work, progress artifacts, feature ledger, clean state before handoff, real end-to-end verification. | Partial fit: checkpoints, diagnostics handoff, `task.progress` feature ledger, ledger freshness diagnostics, and verification loop exist; enforced clean-state handoff middleware is still missing. |
| MCP | Host-client-server split, one MCP client per server, explicit tool/resource discovery, lifecycle notifications. | Partial fit: local MCP adapter exists; security/docs should keep command/env secrecy and per-server allow/disable behavior explicit. |

Reference URLs:

- https://docs.langchain.com/oss/python/langgraph/overview
- https://openai.github.io/openai-agents-python/
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- https://modelcontextprotocol.io/docs/learn/architecture

## Current Completed Surface

- Python/FastAPI local daemon has replaced the old Node local host.
- LangGraph/deepagents run loop is wired with checkpointing, HITL permission
  pause/resume, subagents, skills, memory writeback, reflection, retries,
  tool limits, context editing, PII redaction, and observable events.
- SSE wire envelope is standardized and tested.
- Cloud Control Plane owns auth, billing, model catalog, provider keys, Stripe,
  S3 documents, admin, and audit.
- Local Host proxies platform-paid tools through Cloud Tool Gateway:
  `web.search`, `image.*`, `pdf.inspect`, and gated `code.execute`.
- Local tools include `web.fetch`, workspace/filesystem/shell via deepagents,
  `workspace.open`, `open.*`, `clipboard.*`, `task.verify`, memory, office,
  user questions, and MCP tools.
- Web build has a shallow cloud tool loop for API-backed tools.

## Gaps Found

### Fixed In This Pass

1. `browser.task` was visible to the model while always configured with
   `browser_llm=None`. The registry now hides it unless browser-use and a
   browser LLM are both wired.
2. The web cloud tool loop returned `hitStepCap=true` but the API wrapper did
   not surface a user-visible event. It now emits `run.budget_warning` with
   `reason=max_steps_reached`.
3. `operations.md` still documented Node `npm run dev` local-host commands and
   granular Playwright browser tools as current. It now reflects the Python
   daemon and current tool surface.
4. `universal-tool-primitives.md` now explicitly marks its `fs.*` and granular
   browser vocabulary as a target spec, not current implementation.
5. `SHEJANE_LOCAL_FALLBACK_MODELS` no longer wires LangChain
   `ModelFallbackMiddleware` in the daemon. Stale env values are ignored with a
   warning; if fallback is introduced later, it must live in the Go model
   gateway so provider keys and credit accounting stay server-side.
6. Tool vocabulary drift is now resolved for the current runtime contract:
   `/local/v1/tools` exposes deepagents filesystem/shell tools
   (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `execute`)
   using deepagents' own schemas, client labels cover those names, and `fs.*`
   remains documented as future primitive vocabulary.
7. Web cloud tool-loop Stop now aborts the browser-driven loop. `chatStore`
   owns a per-run `AbortController`, passes its signal through
   `api.runCloudToolLoop` into both LLM streaming and Tool Gateway fetches, and
   settles an intentional abort as `run.canceled` instead of an error.
8. Web cloud tool-loop orphan recovery is now explicit. On conversation
   load/refresh, `chatStore` marks client-generated `run_...` cloud
   `streaming` messages as `error` with a `run.failed` timeline item, while
   leaving server-backed cloud run IDs and local harness runs untouched.
9. The web build no longer carries a production `WEB_TOOL_DEFINITIONS` shadow
   catalog. `/api/v1/agent/tool-capabilities` now returns cloud tool
   `description` and `inputSchema`, and `webToolsFromCapabilities()` maps only
   configured API-supplied definitions.
10. Cloud Tool Gateway model-facing schemas now have a checked-in artifact:
    `api/internal/httpapi/cloud_tool_schemas.json`. The Go capabilities endpoint
    embeds that artifact, and the Python daemon has a cross-runtime contract test
    that verifies `web.search`, `image.*`, `pdf.inspect`, and `code.execute`
    expose matching model-visible fields. `web.search` now uses the shared
    `max_results` argument name, while the Go gateway still accepts legacy
    `maxResults` calls for compatibility.
11. LLM credit reservation now estimates the full request shape rather than
    only `role` + `content`: reasoning text, assistant tool calls, tool
    arguments, and tool definitions are included in both up-front reservation
    and no-usage fallback paths. This is still a lightweight estimate, not a
    provider-exact tokenizer.
12. Admin has a run trace surface: `GET /api/v1/admin/agent-runs/{id}/trace`
    joins the run summary, persisted events, LLM calls, and Tool Gateway calls
    for one run, and the admin Agent Runs table can open that trace read-only.
13. Anthropic prompt caching is now gateway-owned. The Go Anthropic provider
    adds top-level `cache_control={"type":"ephemeral"}` for long estimated
    requests in both streaming and tool-completion paths, while the local daemon
    keeps provider-specific cache markers out of its wire contract.
14. The web cloud tool loop now has a real HTTP-facing client contract test:
    `client/src/shared/api/cloudToolLoop.contract.test.ts` drives
    `SheJaneAPI.runCloudToolLoop` through fetch, named LLM SSE, Tool Gateway
    JSON envelopes, Auto model resolution, idempotency keys, and the second
    model turn's assistant/tool history shape.
15. Verification now has a bounded repair loop for the concrete
    `task.verify` path. `VerificationLoopMiddleware` detects failed structured
    verification when the model is about to finalize, appends a repair
    instruction, and jumps back to the model up to
    `SHEJANE_LOCAL_VERIFY_REPAIR_MAX` times. Fuzzy LLM critic scores remain
    advisory.
16. Local run diagnostics now include a compact `handoff` summary derived from
    run status, event types, permissions, artifact metadata, and recent
    failures. The diagnostics panel surfaces it, and exports keep it alongside
    the raw event list without exposing artifact bodies or checkpoint messages.
17. The local harness now has a first-class feature ledger tool:
    `task.progress` writes a durable `progress_ledger` artifact with summary,
    status, acceptance criteria, decisions, touched files, validation commands,
    unresolved risks, and next actions. Diagnostics expose the latest entry as
    `feature_ledger`, and the diagnostics panel renders it.
18. Handoff diagnostics now grade progress ledger freshness. The handoff
    summary includes `ledger_state` (`not_required`, `fresh`, `missing`, or
    `stale`) and `ledger_message`; runs that actually need handoff context
    surface missing/stale ledgers as blockers and next actions without exposing
    checkpoint messages or artifact bodies.
19. Handoff diagnostics now classify the latest `run.failed` / `tool.failed`
    event as transient, auth, quota, permission, configuration, workspace,
    validation, fatal, or unknown, with `recoverable`, `retryable`, and
    `suggested_action` fields. The same module now also returns a runtime
    retry decision with `should_retry`, `delay_s`, and a fail-fast reason.
20. Cloud Tool Gateway gateway-layer failures now get bounded retry/backoff in
    the local daemon. `web.search`, `image.*`, `pdf.inspect`, and
    `code.execute` all share the gateway helper, so transient `httpx.HTTPError`
    failures and non-JSON transient HTTP responses (`429`, `500`, `502`, `503`,
    `504`) are retried through the shared retry decision with the same
    `tool_call_id` / idempotency key before surfacing as
    `gateway_unreachable` / `gateway_transient_response`. Structured Tool
    Gateway envelopes are not retried because they may already represent a
    provider call and ledger/audit record.
21. Long-running handoff hygiene now has a bounded completion guard.
    `ProgressLedgerGuardMiddleware` detects final local-agent answers after
    non-progress tool work when no fresh `task.progress` entry exists after the
    latest tool result. It asks the model to refresh the durable progress
    ledger and jumps back to the model once, while simple no-tool answers and
    runs with a fresh ledger pass through.
22. Ledger-level trace is now direct for single-run admin forensics.
    `GET /api/v1/admin/agent-runs/{id}/trace` includes
    `wallet_transactions` for the run's usage reservations, and the admin trace
    dialog renders those reserve/settle/release rows alongside events, LLM
    calls, and Tool Gateway calls.
23. Tool result envelopes now flow into failure diagnostics. A LangChain
    `ToolMessage` whose content is a JSON/dict envelope with `ok: false` is
    translated as `tool.failed`, not `tool.completed`, and carries structured
    `error_code`, `recoverable`, `retryable`, and `message` fields into
    `handoff.failure`.
24. Model and tool retry budgets are now separate. `ModelRetryMiddleware` uses
    `max_model_retries` / `SHEJANE_LOCAL_MAX_MODEL_RETRIES`, while
    `ToolRetryMiddleware` and Cloud Tool Gateway transport retry keep using
    `max_tool_retries`; the client Advanced panel can override them
    independently per run.
25. Durable memory now has workspace namespace isolation. Workspace runs bind
    `MemoryWritebackMiddleware` and `memory.search` to
    `("notes", "workspace", <workspace-hash>)`; no-workspace runs keep the
    legacy `("notes", "global")` namespace, and `DELETE /local/v1/memory`
    clears all `("notes", ...)` namespaces.
26. Durable memory now distinguishes run notes from explicit user facts.
    `MemoryWritebackMiddleware` still writes the compact `{goal, answer}`
    run summary as `kind=run_note`, but user messages that explicitly say
    `remember...` / `记住...` also produce `kind=user_fact` records with
    `source=explicit_user_request`. This gives memory.search a more
    explainable fact layer without guessing facts from ordinary conversation
    or assistant output.
27. Pre-run chat history truncation is now configurable instead of a fixed
    magic number. `max_history_turns` / `SHEJANE_LOCAL_MAX_HISTORY_TURNS`
    defaults to 40, is clamped to 1-200, can be overridden from the client
    Advanced panel per run, and still surfaces the dropped-count notice in the
    prompt `<state>` layer.
28. Permission/input pauses now carry their own compact handoff snapshot.
    `run.waiting` includes `handoff.ledger_state`, `ledger_message`, and the
    latest `feature_ledger` summary so stream replayers and exported timelines
    can tell whether a pause has clean progress context without calling the
    diagnostics endpoint. Passive wait-surface events (`permission.required`,
    `question.asked`, `run.waiting`) no longer make a freshly written ledger
    stale by themselves; real tool results, permission decisions, and terminal
    failures still do.
29. Structured Cloud Tool Gateway failures now default to non-retryable unless
    the cloud result explicitly says otherwise. The daemon still retries
    transport errors and unstructured transient HTTP responses with the same
    idempotency key, but once the gateway returns a structured provider result
    (`ok:false`) the local result carries `retryable:false` by default so
    future policy layers do not accidentally re-drive provider calls that may
    already have billing/audit side effects.
30. Pre-run history truncation now preserves a compact deterministic summary.
    When the client or daemon drops older prior turns, it keeps a bounded
    no-LLM digest of selected early/late omitted turns. The client sends this
    in the omission marker, and the daemon adds its own dropped-history summary
    to the `<state>` layer, so long threads retain some early decisions and
    constraints instead of only saying "messages were omitted."
31. Verification state is now part of the diagnostics handoff contract.
    `handoff.verification` records the latest machine-readable `task.verify`
    result, including pass/fail status, reason, and counts. A later passing
    verification suppresses stale earlier `task.verify` failures from
    `handoff.failure`, while a latest failed verification is promoted into
    blockers and next actions. The client diagnostics panel renders this state.
32. Retryable structured tool-result envelopes now have bounded retry.
    `ToolResultRetryMiddleware` retries allowlisted tools when they return a
    `ToolMessage` envelope with `ok:false` and `retryable:true`, using the
    shared retry decision and the same `max_tool_retries` budget as exception
    retry. Non-retryable envelopes still pass through to the model and
    diagnostics unchanged.
33. Model gateway errors now fail durably with structured diagnostics.
    Cloud `llm.error` frames raise `BackendLLMError` with code, request ID,
    provider, recoverable, and retryable metadata. `ModelRetryMiddleware`
    now consults the shared retry decision, retries only transient or
    explicitly retryable model errors, and re-raises when exhausted, so the run
    ends as `run.failed` instead of completing with a synthetic error answer.
    `handoff.failure` can classify these failures directly from structured
    fields.
34. User-input pauses now use their own durable run state. Pure `user.ask`
    interrupts set the run to `waiting_input` instead of `waiting_permission`,
    daemon restart recovery keeps both pause states resumable, and diagnostics
    treats `waiting_input` as a handoff point for progress-ledger freshness.
    The client also renders this as a distinct "waiting for your answer" pause
    in the message bubble, progress headline, and inactive-chat attention dot.
35. Failure classification is now shared by diagnostics and model retry policy.
    `failure_policy.classify_failure_payload` owns the category/recoverable/
    retryable contract, so quota/config/auth/workspace/fatal errors do not get
    retried merely because a gateway message contains `429`, while true
    transient failures still drive bounded model retry and diagnostics.
36. Failed background conversations now surface as user attention in the
    sidebar. When an inactive chat's latest assistant turn ends in `error`, it
    gets the same once-per-version attention dot as completed or paused runs,
    so recoverable auth/quota/config failures are not silently buried.
37. Local run diagnostics now expose a safe latest-checkpoint summary.
    `/local/v1/runs/{id}/diagnostics` reads the newest `AsyncSqliteSaver`
    checkpoint and returns only `id`, `run_id`, `step`, `reason`,
    `messages_count`, and `created_at`, preserving the no-full-prompt/no-full-
    checkpoint-messages diagnostics boundary.
38. Advanced `maxHistoryTurns` now applies before client-side history
    truncation for local runs. The client uses the same per-run setting when
    deriving the `history` payload it sends to the daemon, so values above the
    previous hard-coded 20-message client cap can actually reach the local
    harness. Invalid local values are clamped to at least one message.
39. Mid-loop tool-result criticism now uses the current user turn, not stale
    conversation history. `ToolResultCriticMiddleware` previously extracted
    the first human message from LangGraph state; multi-turn local runs pass
    prior chat history before the current request, so critic verdicts could be
    judged against an older task. It now selects the latest human message while
    preserving single-turn behavior.
40. Advanced run-loop budget knobs now have daemon-side safety clamps.
    `max_model_calls`, `max_model_retries`, `max_tool_retries`,
    `research_search_limit`, and `tool_selector_max_tools` now share the same
    bounded ranges for env Settings and per-run Advanced overrides. This
    prevents corrupted localStorage, old clients, or hand-written API calls
    from setting negative or excessive budgets that could break the LangGraph
    loop or create runaway cost.
41. `run.failed` timeline items now keep daemon error detail visible outside
    diagnostics. The Local Host emits `run.failed` with `error` and `type`, but
    the client timeline only read `message`, reducing ordinary chat history to
    a generic "task failed" label. The timeline now falls back to `error` while
    preserving `message` compatibility.
42. Empty failed local-run bubbles now surface the failure reason. In-band
    `run.failed` events can arrive before any assistant text streamed; the
    message state was marked `error`, but the bubble body stayed blank unless
    the user opened timeline/diagnostics. Finalization now fills an empty
    failed bubble from the latest `run.failed` label while preserving any
    partial answer text that already streamed.
43. Memory run-note writeback now uses the current user turn in multi-turn
    runs. The middleware previously stored the first human message as
    `run_note.goal`; when local runs carried prior chat history, workspace
    memory could index an old task under the latest answer. It now uses the
    latest human message for the run-note goal while still scanning all human
    messages for explicit `remember` / `记住` facts.
44. Failure diagnostics now render user-action guidance in the active UI
    locale. `handoff.failure` still carries the daemon's raw category and
    `suggested_action` for export/API stability, but the diagnostics panel now
    maps failure categories to localized labels/actions, localizes the daemon's
    fixed `handoff.next_actions`, and filters duplicate failure suggested
    actions so Chinese UI users do not see raw enum names or English
    remediation text.
45. Failure classification now exposes a machine-readable policy hint.
    `handoff.failure.action_kind` maps the shared failure category/retryability
    into `retry`, `user_action`, `repair`, `operator_action`, or `inspect`.
    The diagnostics panel renders the same hint as a localized policy badge,
    giving the next retry/pause layer a stable input without changing the
    current run status machine or re-driving side-effecting tools.
46. Terminal `run.failed` events now carry the same failure-policy summary.
    `_run_failed_payload` enriches both model-gateway and generic exceptions
    with `category`, `recoverable`, `retryable`, `action_kind`, and
    `suggested_action` while preserving legacy `error` / `type` fields, so
    stream/replay consumers can react before fetching full diagnostics.
47. Ordinary failed-run UI now consumes that terminal policy hint. The client
    stores `failureCategory`, `failureRetryable`, `failureActionKind`, and
    `failureSuggestedAction` on the local timeline item, appends the localized
    short action-kind label to `run.failed` text, and uses the latest failed
    run label as the failed progress headline instead of hiding it behind
    aggregate tool counts.
48. Workspace failures now outrank generic permission wording in the shared
    failure policy. `path_outside_workspace` / workspace-path errors are
    classified as `workspace` even when the message also says `denied`, while
    ordinary `permission_denied` remains a permission failure, so diagnostics
    and UI hints point users to workspace authorization instead of a stale
    approval prompt.
49. Long-history state now reports original conversation depth, not retained
    slice depth. The daemon still forwards only the capped recent history, but
    `<state>` computes `turn_count` from the full pre-truncation history plus
    the current goal, so the model can see that a run is continuing a long
    thread even after older messages were summarized and dropped.
50. Client-side omission markers now use the same message-count semantics as
    the daemon state layer. The synthetic history marker says how many earlier
    messages were omitted, not how many conversation turns, so long-thread
    summaries do not overstate or understate preserved context.
51. `memory.search` now clamps model-supplied result limits before hitting the
    store. The tool keeps the same namespace-bound search semantics, but
    `limit` is stabilized to 1-20 so a bad tool argument cannot silently return
    no memory or flood the agent context with too many notes.
52. Shared failure policy no longer lets `retryable:true` override categories
    that require user, repair, or operator action. Explicit retryability is
    accepted only for `transient` or otherwise `unknown` failures; auth, quota,
    configuration, workspace, validation, and fatal implementation errors keep
    non-retry action kinds even if an upstream envelope is overly optimistic.
53. End-of-run reflection now critiques the latest user turn, not the first
    human message in the thread. This matches the mid-loop tool critic's
    current-turn behavior and removes one source of stale multi-turn critic
    verdicts before any future automatic repair policy can safely consume them.
54. Reflection output is now visible in diagnostics without leaking checkpoint
    messages. `/local/v1/runs/{id}/diagnostics` exposes a compact
    `reflection` summary from the latest checkpoint (`ai_messages`,
    `tool_results`, `final_answer_chars`, and critic scores/notes/raw), and
    the diagnostics panel renders it. This keeps critic evidence reviewable
    while end-of-run reflection remains advisory.
55. Tool-result retry now honors the same shared failure policy as diagnostics
    and model retry. `ToolResultRetryMiddleware` still requires an allowlisted
    tool and an `{ok:false,retryable:true}` envelope, but it now also asks
    `failure_policy` whether the failure category is actually retryable. This
    prevents auth, quota, configuration, workspace, validation, and fatal
    implementation failures from being retried just because a tool envelope was
    overly optimistic.
56. `memory.search` now prioritizes explicit user facts over automatic run
    notes. Search still uses the namespace-bound LangGraph store and the same
    clamped result limit, but returned items are stably re-ranked so
    `kind=user_fact` records from explicit `remember` / `记住` requests appear
    before `kind=run_note` summaries. This gives the agent a clearer signal
    about user-declared facts without adding embedding or LLM extraction cost.
57. Deterministic omitted-history summaries now preserve middle-of-thread
    constraints and decisions. The client omission marker and daemon `<state>`
    digest still keep bounded head/tail excerpts, but they reserve summary
    slots for omitted turns that contain strong decision, requirement, or
    memory cues such as `决定`, `必须`, `记住`, `decision`, `must`, or
    `remember`. This reduces long-thread drift without adding semantic
    summarization calls.
58. Shared failure policy now treats `recoverable:false` as stronger than a
    conflicting `retryable:true`. This removes the impossible state where a
    model or tool failure could be marked non-recoverable but still drive
    automatic retry, keeping future policy consumers conservative when upstream
    envelopes disagree with themselves.
59. Mid-loop tool critic verdicts now normalize the model's `usable` field
    before mutating tool results. This fixes a common LLM JSON shape where
    `"usable": "false"` is returned as a string; nudge/block modes now treat
    explicit false-like strings as unusable, while missing or ambiguous values
    still fail open as usable.
60. Handoff failure diagnostics no longer treat recovered ordinary tool
    failures as current blockers for completed runs. `handoff.failure` now
    represents a current failure that still needs action; a completed run with
    a later successful tool event keeps the old `tool.failed` in the event
    history/recent event types, but does not surface it as the active
    `failure`. Latest failed `task.verify` results remain visible through
    `handoff.verification` and blockers.
61. Explicit memory facts now get exact-duplicate suppression on writeback.
    Before writing a `kind=user_fact` record, `MemoryWritebackMiddleware`
    searches the current namespace and skips the write when an identical fact
    already exists. This is a conservative first step toward fact merging:
    repeated "remember" requests no longer flood memory.search, while
    semantically similar but textually different facts are not guessed as
    equivalent.
62. Production weak secret handling now fails fast. The production compose
    stack injects `SHEJANE_ENV=production`, the API entrypoint uses
    `config.LoadStrict`, and startup rejects weak/default `JWT_SECRET` or
    missing/placeholder `CONFIG_ENCRYPTION_KEY` before auth tokens or plaintext
    provider-key storage can become a runtime incident.
63. Failed-run progress now exposes first-step recovery actions. The active
    chat UI no longer stops at localized remediation text: retryable failures
    can re-run the originating user turn, repairable validation failures expose
    a distinct user-triggered repair button that re-enters the local run path,
    quota failures open the existing Stripe top-up path, auth failures refresh
    the Local Host cloud session, workspace failures open the existing
    workspace picker, and configuration / fatal failures can jump to
    diagnostics. These are explicit user clicks, not automatic side-effecting
    retries.
64. User-triggered repair runs now carry durable attempt metadata. The repair
    button still uses the existing local run creation path, but it now starts a
    distinct repair intent with `metadata.intent=repair`, the source run/message
    IDs, the attempt number, and the originating failure category/action kind.
    The new assistant turn also begins with a visible `ui.action.requested`
    timeline item ("repair attempt N"), so diagnostics and future daemon policy
    can distinguish a repair attempt from an ordinary retry.
65. The daemon now consumes repair metadata as a bounded workflow. Local Host
    hydrates `metadata_json` after daemon restart, rejects repair attempts over
    `SHEJANE_LOCAL_REPAIR_WORKFLOW_MAX`, emits `repair.workflow`
    started/completed/failed/rejected/canceled events, and renders repair
    attempt context into the `<state>` layer so the model knows this is a
    source-linked repair attempt rather than an ordinary retry.
66. HITL permission resume now matches deepagents' batched action-request
    contract. `POST /local/v1/permissions/:id` marks one permission row
    resolved, emits a durable `permission.resolved`, waits for every
    permission in the current pause batch, then resumes with an ordered
    `{"decisions": [...]}` list. HTTP-originated `permission.resolved` and
    `question.answered` events are persisted even when the previous stream
    already closed, and the resume stream replays them before `run.resumed`.
67. Local Host tests now isolate external tracing by default. The pytest
    harness forces `LANGSMITH_TRACING=false`, legacy
    `LANGCHAIN_TRACING_V2=false`, and clears inherited LangSmith/LangChain API
    keys so agent-run tests do not emit network traces or fail with external
    rate-limit noise. Production/development tracing remains opt-in through
    explicit environment variables.
68. Post-failure retry confirmations now carry explicit recovery context.
    Billing, local cloud-session refresh, workspace binding, and diagnostics
    follow-up toasts bind retry to `{conversation_id, assistant_message_id}`
    instead of relying on whichever chat is active later. Workspace selection
    also captures the failed conversation before the async OS directory picker
    returns, so navigating during selection cannot bind the authorized
    workspace to the wrong conversation.
69. Quota recovery now observes wallet state before retrying. The checkout
    follow-up action no longer re-runs the failed turn blindly: it refreshes
    `/api/v1/billing/balance`, compares the current wallet to the pre-checkout
    snapshot, and retries only after usable credits, plan, or subscription
    capacity has actually improved. If the Stripe webhook has not landed yet,
    the UI keeps a retryable "finish payment first" confirmation instead of
    starting another quota-failing run.
70. Recovery confirmation retries are now per-target in-flight guarded. The
    retry action for a failed `{conversation_id, assistant_message_id}` enters
    a small client-side recovery gate before truncating and re-running the
    source turn, so double-clicking the same auth/billing/workspace/diagnostics
    follow-up toast cannot create parallel replacement runs for one failed
    message.
71. User-confirmed retry runs now carry durable source metadata. Local recovery
    retries started from failed messages send `metadata.intent=retry` with the
    source run/message IDs, attempt number, and original failure category/action
    kind; the new assistant turn begins with a visible `ui.action.requested`
    timeline item, and the daemon renders the retry context into `<state>` so
    the model can avoid blindly repeating the failed path.
72. Waiting-run handoff ledger risk is now visible in the chat surface. The
    daemon already emits `run.waiting.handoff.ledger_state`; the client now
    preserves that state on the timeline and shows a compact pause warning for
    missing or stale progress ledgers while keeping permission approvals in the
    dedicated approval bar. This makes LangGraph interrupt points more
    understandable without adding automatic resume or side-effecting recovery.
73. Billing recovery now has a bounded checkout observer. After opening Stripe
    checkout for a quota failure, the client performs quiet bounded wallet
    polling; once the backend balance reflects usable credits or upgraded plan
    capacity, it refreshes the retry notice for the failed turn. It still does
    not auto-run the failed task: the replacement run starts only after the
    user clicks the explicit retry action.
74. Auth/session recovery now has a pending-target observer. If a failed auth
    recovery action cannot refresh the local cloud session immediately, the
    client keeps the failed `{conversation_id, assistant_message_id}` as a
    pending recovery target. A later login/token repair that makes the daemon's
    cloud session `connected` refreshes the explicit retry prompt for that same
    failed turn, without automatically creating a replacement run.
75. `memory.search` now performs bounded candidate overfetch before local
    re-ranking. A small model-supplied result limit no longer cuts explicit
    `kind=user_fact` records out of the candidate set before the user-fact-first
    priority can apply; returned results remain clamped to the requested 1-20
    range, while candidate reads are capped at 50.
76. Client-side omission markers are now protected during daemon-side history
    truncation. When Advanced `max_history_turns` makes the client and daemon
    apply the same cap, the daemon keeps the synthetic "earlier context was
    omitted" marker as a compressed history anchor and spends the remaining
    budget on recent real messages; any extra dropped real messages still get
    summarized in `<state>`, so the two compaction layers no longer erase or
    double-summarize the client's early-history digest.
77. `memory.search` now uses recency as a stale-fact mitigation. After bounded
    overfetch and `kind=user_fact` priority, results within the same memory kind
    sort by `updated_at` / `created_at` newest-first. A later explicit user fact
    can therefore outrank an older explicit fact when the model asks for a small
    limit, while full semantic merging and verification remain future work.
78. User-triggered repair actions now use the same recovery-target discipline
    as retries. Clicking "try repair" resolves the failed
    `{conversation_id, assistant_message_id}` directly, records the source
    metadata on the new repair run, and enters a per-target in-flight guard so
    rapid repeated clicks cannot create duplicate repair runs for the same
    failed assistant message.
79. Quota recovery checkout creation is now per-target in-flight guarded.
    Clicking "top up" for a failed `{conversation_id, assistant_message_id}`
    starts at most one checkout-session creation request at a time, so rapid
    repeated clicks cannot open multiple Stripe sessions for the same failed
    turn before the wallet observer and explicit retry confirmation take over.

### Remaining High-Priority Design Issues

1. **Context management is still shallow**
   `max_history_turns` removes the hard-coded 40-message cap and omitted
   history now gets a deterministic compact digest that keeps head/tail
   excerpts plus obvious decision/constraint/memory turns; the client also
   honors the same per-run setting before sending local history to the daemon,
   and daemon truncation protects the client's omission marker instead of
   treating it as disposable oldest history. This is still an excerpt-style
   fallback, not semantic summarization. The next step is to coordinate
   LLM/semantic pre-run conversation summaries with deepagents' in-run
   summarization so long tasks preserve decisions without dragging stale or
   irrelevant turns forward forever.

2. **Verification is only partially automatic**
   `task.verify` failures now trigger a capped repair loop and the latest
   structured verification result is visible in diagnostics, but fuzzy
   `tool_critic` and end-of-run reflection scores remain advisory. The
   mid-loop critic and end-of-run reflection now evaluate against the current
   user turn in multi-turn chats, mid-loop `usable` verdicts are normalized
   before nudge/block mutation, and reflection output is visible in
   diagnostics. The next step is still to decide which critic verdicts are
   reliable enough to drive automatic repair without excess cost or false
   positives.

3. **Memory is still shallow**
   Current memory is useful but not yet a strong semantic long-term memory:
   namespace isolation, explicit user-requested fact records, current-turn
   run-note writeback, bounded candidate overfetch before user-fact-first
   ranking, same-kind recency sorting, and exact duplicate user-fact suppression
   are in place, but LLM/semantic fact extraction, vector/semantic retrieval,
   semantic fact merging, and stale-fact verification are still future work.

4. **Post-failure user-action flow is still thin**
   Automatic retry/backoff now has a shared runtime decision:
   `failure_policy.build_retry_decision` maps the same classification used by
   `handoff.failure` into `should_retry`, `delay_s`, and a fail-fast reason.
   Cloud Tool Gateway transport / unstructured transient responses, retryable
   structured tool-result envelopes, and model gateway errors all consume that
   decision; explicit `retryable:true` can no longer turn user-action,
   validation, fatal, or operator-action categories into automatic retry. What
   remains thin is the layer after the first user action: chat now renders
   localized next-step guidance and exposes explicit buttons for retry, billing
   top-up, repair, local cloud-session refresh, workspace selection, and
   diagnostics. Local cloud-session refresh and workspace binding now observe
   successful fixes and offer explicit retry confirmation for the failed turn;
   billing, session, workspace, and diagnostics confirmations carry explicit
   `{conversation_id, assistant_message_id}` recovery context, and workspace
   authorization is bound to the failed conversation even if the user navigates
   while the OS directory picker is open. Quota top-up opens checkout and the
   follow-up action checks wallet state before retrying, so a retry only starts
   after the backend balance reflects new usable credits or subscription
   capacity; checkout-session creation is per-target in-flight guarded, and a
   bounded checkout observer now also notices when the backend balance updates
   after payment and refreshes the explicit retry prompt without auto-running
   the failed task. Diagnostics actions open the run panel
   and give a "fix configuration, then retry" confirmation for the same failed
   turn. Those confirmation retries, plus user-triggered repair actions, now
   share per-target in-flight guards, so the same failed message cannot spawn
   duplicate replacement runs from rapid repeated clicks. User-confirmed retry
   runs now also carry source run/message IDs,
   attempt, failure category, and action kind into local run metadata and the
   daemon `<state>` layer. User-triggered repair has durable run metadata,
   daemon-side attempt bounds, visible workflow events, and repair context in
   the model state. Waiting runs now surface missing or stale handoff ledger
   state directly in the chat progress line, so a paused LangGraph interrupt is
   not silently missing recovery context. The broader flow still does not
   automatically observe configuration fixes, automatically resume/retry after
   every fix type, or coordinate multi-step post-fix recovery across auth,
   billing, workspace, config, and repair flows.

## Recommended Next Loop

1. Turn post-failure action buttons into recovery orchestration: after config /
   multi-step billing / workspace fixes, offer or perform a bounded resume/retry
   with clear user confirmation for side-effecting runs.
2. Turn the first-step recovery actions into a unified recovery orchestrator:
   track whether the required login/config/billing/workspace fix actually
   happened, then offer or perform a bounded retry with clear user
   confirmation for side-effecting runs.
3. Decide whether dirty long-running pauses should only warn via
   `run.waiting.handoff` or should trigger a bounded pre-pause `task.progress`
   refresh for specific safe categories.
