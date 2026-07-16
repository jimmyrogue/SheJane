# SheJane Plugin Action Protocol v1

> Status: v1 contract under implementation. WASI execution is available; Managed Worker and its Vision host call remain behind the platform isolation release Gate.

An Action is a bounded function call owned by the Runtime:

```text
ActionExecutor.invoke(invocation) -> result
```

`WasiActionAdapter` and `ManagedWorkerActionAdapter` implement that interface. Agent tools, `/commands`, `@plugin` references, Skills, and MCP resources are callers or discovery layers; none receives an executor-specific escape hatch.

The canonical envelopes are:

- [`plugin-action-input.v1.schema.json`](../../schemas/plugin-action-input.v1.schema.json)
- [`plugin-action-result.v1.schema.json`](../../schemas/plugin-action-result.v1.schema.json)
- [`plugin-action-progress.v1.schema.json`](../../schemas/plugin-action-progress.v1.schema.json)

## Runtime ownership

The plugin does not create authority or durable state. The Runtime owns:

- selected plugin version and immutable package digest;
- `invocation_id` and stable `operation_id`;
- capability grants and effective limits;
- input materialization and output staging;
- timeout, cancellation, process/instance cleanup, and log ceilings;
- input, output, and Artifact schema validation;
- receipt state, Artifact persistence, replay, and final settlement.

The primary target stage is P6, where the Run receives a frozen Action catalog and plugin execution lease. P10 performs each invocation through the existing tool review and receipt path. P11 proves the instance/process tree and staging lease are closed. P12 atomically settles the receipt, Artifact records, and Run terminal state.

## Invocation envelope

The invocation binds a call to exact code and exact authority:

| Field | Contract |
| --- | --- |
| `schema_version` | Exactly `1` |
| `invocation_id` | Unique UUID for this execution attempt |
| `operation_id` | Stable Runtime idempotency identity reused by receipt/recovery logic |
| `action` | Plugin ID, semantic version, package SHA-256, and Action ID |
| `arguments` | Validated against the Action input schema before launch |
| `inputs` | Authorized immutable files, each with virtual path, MIME, size, and SHA-256 |
| `grants` | Effective capabilities, never merely requested capabilities |
| `limits` | Effective timeout, memory, and staged output limits |
| `environment` | Explicit locale and timezone only |
| `model_binding_id` | Runtime-injected safe binding ID, present only when an Action has a frozen model binding |

No host filesystem path, inherited environment map, model key, Runtime token, credential-store handle, arbitrary command, or network socket appears in v1.

Inputs are mounted or materialized under `/input`. The listed paths are the complete readable set. They are immutable for the duration of the call. The adapter rejects absolute host paths, backslashes, `.`/`..` segments, symlink escapes, device files, and post-validation path substitution.

For v1 Actions with the conventional `input_id` or ordered `input_ids` argument, each ID may select either an immutable Run attachment or a file-backed Artifact already settled by an earlier tool call in the same Run. Artifact binding is not a shared workspace escape hatch: Runtime checks exact Run ownership, declared `consumes` MIME, blob storage, size, and SHA-256, then rematerializes only those bodies under generated `/input/artifacts/...` paths. Inline Artifacts, cross-Run IDs, missing bodies, and incompatible MIME types fail as unavailable input. The ordered IDs are part of Action arguments, while every Artifact's exact ID/MIME/size/SHA-256 strengthens the downstream receipt's tool version and is repeated in invocation provenance. Each Action schema must bound and, where required, de-duplicate `input_ids`; Runtime does not invent an unbounded batch default.

## Result envelope

The result echoes both identities and has exactly one logical outcome:

- `succeeded`: contains `output`, validated against the Action output schema, and zero or more Artifact candidates;
- `failed`: contains a stable structured `error` and no `output`.

Artifact candidates refer only to `/output` staging paths. They are untrusted claims. Before persistence the Runtime opens the staged object without following escaping links, verifies type and size, recomputes its digest, applies plugin and Run quotas, and then promotes it to Runtime-owned Artifact storage. A plugin cannot create a durable Artifact directly.

Inline text remains capped at 32 MiB. File-backed Artifacts are capped at 2 GiB per item, 4 GiB per Run, 16 GiB per principal, and 64 GiB for the local store; the effective Action limit is the lower of these platform ceilings and the frozen manifest's `output_mb`.

`error.retryable` is advice, not permission to retry. Existing receipt state decides whether a retry is safe. An external side effect with unknown outcome remains `outcome_unknown` until reconciled.

## Idempotency and recovery

The protocol does not claim exactly-once execution. It supplies the identities needed for SheJane's existing receipt semantics:

1. P10 prepares a receipt for `operation_id` and the digest of validated arguments.
2. If an identical operation is already completed, the Runtime returns the recorded result without launching code.
3. A new attempt gets a new `invocation_id` but retains the operation identity.
4. If the Runtime loses contact after a potentially effectful call, it does not blindly invoke again.
5. Candidate files become authoritative only in the Runtime settlement transaction.

`pure` Actions may be recomputed. `input_stable` Actions should return the same logical output for identical plugin digest, input digests, arguments, explicit environment, and capability set. `nondeterministic` Actions must expose their non-deterministic inputs explicitly where possible and receive stricter replay handling.

The plugin-specific `tool_version` is `plugin-action-v1:sha256:<digest>` over compact, key-sorted UTF-8 JSON containing the protocol tag; plugin ID/version/digest; Action ID and Action schema digest; admission-time inputs normalized by `id,path` with path/MIME/size/SHA-256; sorted effective capabilities; effective limits; explicit locale/timezone; and the normalized frozen model binding when one exists. When `input_id` selects a same-Run Artifact created after admission, Runtime appends a deterministic Artifact binding digest over its ID/MIME/size/SHA-256 before preparing the receipt. Attempt-specific `invocation_id` and `operation_id` are excluded. Existing `tool_operation_identity` then combines that strengthened version with Run, execution namespace, tool call ID/name, and normalized Action arguments. The plugin platform does not create a second receipt identity algorithm.

## WASI adapter

One invocation creates one fresh Component instance. The initial capability set is empty. In v1 the Host passes only authorized input bytes as function arguments and receives candidate Artifact bytes in the internal Component response. It does not preopen `/input` or `/output`, call `add_wasip2()`, or expose host paths, network, environment, clocks, or real randomness.

The Phase 0 spike selected direct Wasmtime Component Model rather than Extism. The decisive requirements are:

- no guest filesystem at all in v1; Runtime alone owns staging;
- deterministic interruption or equivalent bounded execution;
- hard memory, output, table/instance, and wall-clock limits;
- predictable packaging on all desktop platforms;
- a narrow typed Component export without broad custom Host Functions.

All unresolved Component imports are installed as traps. The Rust `wasm32-wasip2` runtime currently requests `wasi:random/insecure-seed` during initialization; the Host supplies a fixed deterministic tuple and nothing else. Fuel and Store limits bound execution. The current byte-passing ABI is deliberately limited to small deterministic Actions; add streaming resources only after measured memory pressure and a separate capability review.

The v1 byte-map ABI enforces a 16 MiB aggregate buffered input ceiling and a 16 MiB aggregate buffered Artifact ceiling. Larger files require a `managed_worker` package; Runtime never silently changes a frozen package's execution kind.

## Managed Worker adapter

One invocation creates one short-lived process. The process starts with a minimal fixed environment and private working/staging directories. Large data moves through staged files, not stdout.

Control messages use UTF-8, newline-delimited JSON-RPC 2.0 with hard frame and nesting limits:

```text
initialize(protocol_version, plugin identity, actions, grants, limits)
invoke(operation_id, invocation envelope)
model/vision/invoke(model_binding_id, input_ids, task, prompt, max_output_tokens, temperature?, detail?)
notifications/progress(schema_version, invocation_id, operation_id, sequence, phase, completed?, total?, unit?, message?)
cancel(operation_id, reason)
result(operation_id, result envelope)
shutdown()
```

Progress is a replaceable snapshot, not a durable log. `sequence` starts at 1 and increases by exactly one; `phase` is a bounded machine-readable label. The Runtime accepts at most 100,000 frames, exposes no more than 64 phase transitions, coalesces repeated updates to at most four per second, and forces the latest accepted snapshot before the terminal result. Progress events never enter `local_events` or the model context.

`model/vision/invoke` is the only v1 Worker-to-Runtime request. It is available only to a `managed_worker` Action whose frozen grant contains `model.vision.invoke` and whose Run binding contains the same `model_binding_id`. One invocation may issue it once. The request may name at most 16 already-authorized input IDs, an 8,000-character prompt, at most 8,192 output tokens, temperature from 0 through 2, and `detail` of `low`, `high`, `auto`, or `original`. Unknown fields, a different binding, a second call, or any unlisted host method fails closed.

The Runtime injects the frozen binding ID into the invocation envelope; it is not a model-authored Action argument. The Runtime resolves the frozen provider/model record, rechecks `image_inputs`, materialized MIME/size/SHA-256 and a 20 MiB/40-megapixel image budget, obtains the key from the credential store, sanitizes outbound text, builds the provider-native request, and disables provider retries. The Worker never receives the key, credential reference, base URL, arbitrary headers/options, raw provider request/response, or network access. The response contains only bounded normalized text, safe model identity, and normalized token usage. Cloud Vision is `nondeterministic`; the existing receipt prevents a completed Operation from being launched and billed twice but does not promise identical inference across new Operations.

The worker must complete `initialize` before one `invoke`. Unknown versions, methods, fields, duplicate terminal results, stdout contamination, oversized frames, malformed UTF-8/JSON, or identity mismatch fail closed. `stderr` is an untrusted, bounded diagnostic stream and never carries protocol data.

The initialize result contains four Runtime-expected isolation facts:

```json
{"protocol_version":1,"process_isolated":true,"access_isolated":true,"resource_isolated":false,"sandboxed":false}
```

`access_isolated` means the platform adapter enforces file/network/credential/IPC access.
`resource_isolated` means hard CPU, memory, process-tree, disk, and wall-time policy is
enforced without relying on a racy parent poller. `sandboxed` may be true only when both
are true. The host supplies the expected values; it does not trust a Worker to attest its
own containment.

The Runtime derives one host-owned `SandboxLimits` value from the effective Action limits and platform policy. It includes wall time, CPU time, aggregate memory, process count, scratch bytes, committed output bytes, stdout/stderr bytes, and protocol frame bytes. The manifest cannot enlarge these values. A platform backend returns `SandboxEvidence` with its target, backend identity, policy digest, and independently observed proofs; Worker JSON is checked against that expectation but is never the evidence source.

Cancellation is best effort: send `cancel`, allow a short grace period, then terminate the entire process tree. Timeout and Runtime shutdown follow the same cleanup path. Pooling is outside v1.

Process supervision is not permission isolation. The adapter may mark a worker `sandboxed` only when the platform-specific OS adapter actually enforces the declared file, network, credential, process, and resource policy. Without both access and hard resource proof, untrusted Managed Workers cannot be enabled.

## Error classes

Adapter implementations map failures to stable codes. Initial categories are:

| Category | Examples | Retry posture |
| --- | --- | --- |
| `invalid_invocation` | envelope or Action schema failure | never |
| `capability_denied` | requested operation exceeds grant | never without a new grant |
| `incompatible_runtime` | ABI/protocol/platform mismatch | never in the current installation |
| `resource_exhausted` | timeout, memory, output, frame, or quota limit | only after an explicit policy/input change |
| `plugin_failed` | valid plugin-declared failure | plugin-declared, receipt-controlled |
| `protocol_violation` | malformed or contradictory worker/guest output | never; disable/quarantine candidate |
| `executor_unavailable` | required Runtime or OS isolation missing | retry only after environment changes |
| `model_binding_unavailable` | frozen Vision binding is missing, changed, or unavailable | only after explicit reconfiguration/new Run |
| `vision_provider_failed` | configured provider failed without a safe result | receipt-controlled; never blind retry |
| `cancelled` | Run or user cancellation | never automatically |
| `outcome_unknown` | contact lost after a possibly effectful operation | reconcile; do not blindly retry |

Error messages and logs are untrusted data. The Runtime redacts host paths and secrets before exposing them to the model, UI, or telemetry.

## Conformance requirements

Both adapters must run the same black-box cases:

- valid success and plugin-declared failure;
- unknown field and wrong Action schema;
- package digest, Action ID, and operation identity mismatch;
- input/output traversal, symlink, special-file, and replacement attacks;
- timeout, cancellation, memory/output/frame quota, crash, and malformed result;
- Artifact digest recomputation and atomic promotion;
- recovery before launch, during execution, after staged output, and after settlement;
- no secret/environment leakage and no undeclared network access;
- complete P11 cleanup with no live instance, child process, pipe, or staging lease.

Passing protocol validation alone does not mean an adapter is safe. Capability enforcement and platform sandbox tests are separate release gates.
