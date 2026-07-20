# SheJane Plugin Developer Guide

> v1 preview: WASI packages install and execute. Managed Worker packages remain fail-closed until the current platform's production isolation Gate passes.

A SheJane plugin packages one or more deterministic Actions. Developers choose the execution type that fits the work:

- choose **WASI** for focused transformations with a small dependency surface;
- choose **Managed Worker** for native libraries, Python/Node ecosystems, or heavyweight document and media processing.

This is not an “official versus community” distinction. Every package follows the same manifest, Action, authorization, receipt, and Artifact rules.

## Start with the Action

Describe one bounded operation before choosing a language:

```text
exact inputs -> one Action -> validated JSON + staged Artifact candidates
```

Good Actions include `archive.extract`, `document.render`, `spreadsheet.recalculate`, or `image.ocr`. Avoid broad entrypoints such as `run_code`, `shell`, `execute_workflow`, or an API that accepts arbitrary commands.

An Action should:

- have static Draft 2020-12 input and output JSON Schemas;
- declare all consumed and produced MIME types;
- declare its maximum capabilities and resource limits;
- avoid hidden state and ambient environment;
- make external side effects explicit and safely reconcilable;
- return files only as staged Artifact candidates.

## Choose an execution type

### WASI

Prefer WASI when all necessary work can run with explicit byte/file inputs and no ambient system access. It gives the strongest portable default because the host chooses which capabilities exist.

WASI v1 constraints:

- one fresh instance per Action invocation;
- no network, Shell, subprocess, secret, inherited environment, or whole-workspace access;
- only bytes for listed `/input` references are passed into the Component;
- the guest has no filesystem; it returns candidate Artifact bytes and Runtime alone writes `/output` staging;
- time, memory, CPU/fuel, and output are bounded by the Runtime;
- the package entrypoint is a platform-independent `.wasm` Component using the SheJane v1 WIT ABI.

Use the [Archive fixture](../../runtime/plugins/fixtures/wasi-archive) as the package-shape reference.

### Managed Worker

Choose a Managed Worker only when WASI cannot provide the required ecosystem or quality. Package a self-contained executable for each supported platform.

Managed Worker v1 constraints:

- one short-lived process handles exactly one invocation;
- stdin/stdout carry only bounded, newline-delimited JSON-RPC control frames;
- large data moves through `/input` and `/output` staging;
- stderr is a bounded diagnostic stream;
- Runtime timeout/cancellation terminates the full process tree;
- one package targets exactly one OS/architecture pair;
- large shared engines may be referenced only as exact, host-managed [Runtime Assets](runtime-assets.md);
- no runtime, background task, plugin UI, lifecycle hook, or cross-call memory;
- an untrusted worker is disabled unless that platform's OS isolation adapter is available and enforcing policy.

Changing cwd, clearing environment variables, or running in a child process is not a sandbox. Do not ask users to treat it as one.

Use the [Documents fixture](../../runtime/plugins/fixtures/worker-documents) as the package-shape reference.

## Build the package

Create this minimum layout:

```text
my-plugin/
├── .shejane-plugin/plugin.json
├── actions/my.action.input.json
├── actions/my.action.output.json
└── payload/<entrypoint>
```

Follow the [Manifest v1 specification](manifest-v1.md). Package paths are POSIX, package-relative, and case-sensitive. Do not include symlinks, hard links, device files, duplicate normalized paths, secrets, caches, build logs, or developer-specific absolute paths.

Treat the package as immutable. A changed payload, schema, instruction, or asset requires a new semantic version and produces a new package digest. A detached `.shejane-plugin/signature.json` may be added without changing that digest; it must sign the canonical v1 digest described by the manifest specification.

### Sign for a deployment

The signature envelope never carries its own trust. A deployment operator places the publisher's raw Ed25519 public key in `<data-dir>/plugins/trusted-publishers.json`; the Runtime then binds the envelope `key_id` to both that key and the manifest `publisher.id`. The trust entry may include timezone-aware `not_before` and `expires_at` timestamps, and `status: revoked` blocks future installations.

Keep old trusted keys during a rotation until every package that must remain installable has moved to a new key. Do not put private signing keys, trust-store files, or bundled public keys inside the plugin package. A valid signature does not grant capabilities and does not make a Managed Worker sandboxed.

## Implement the Action protocol

Follow [Action Protocol v1](action-protocol-v1.md). The Runtime supplies a complete invocation envelope. Validate its version and Action identity before doing work.

For a successful call:

1. read only the listed input references;
2. derive output from explicit arguments and inputs;
3. write candidate files only under `/output`;
4. return schema-valid JSON plus relative staged candidates;
5. stop and release resources.

For a failed call, return a stable error code and a user-safe message. Never put secrets, raw host paths, environment dumps, or unbounded dependency output in errors or logs.

`operation_id` belongs to the Runtime. Keep it in logs and calls to explicitly authorized future host capabilities, but do not invent or alter it. `invocation_id` identifies one attempt and may change after recovery.

## Design for repeatability

Choose the narrowest accurate determinism declaration:

- `pure`: output depends only on JSON arguments;
- `input_stable`: output depends on arguments, listed input bytes, plugin digest, explicit locale/timezone, and effective capability configuration;
- `nondeterministic`: unavoidable time, randomness, network, or external state affects output.

For `pure` and `input_stable` Actions:

- sort unordered collections before serialization;
- normalize timestamps and archive metadata when they are not meaningful;
- avoid host locale, timezone, home directory, and random temporary names in logical output;
- pin libraries and data files inside the package;
- make output naming deterministic;
- do not mutate input files.

The Runtime receipt prevents duplicate committed results; it cannot make an arbitrary external side effect exactly-once. If a future capability performs an external mutation, use `operation_id` as its idempotency key and provide an outcome-reconciliation method.

## Add chat entry points

Actions may be selected automatically by the Agent or explicitly by users:

- `@my-plugin` adds a structured required-plugin selection to the submitted command;
- `/my-plugin:command` selects one command declared by the package.

Commands contain instructions and a list of required Action IDs. Keep them declarative. They do not execute setup code and do not bypass approval or capability checks.

Use stable, short command IDs. The UI may localize titles, but the manifest ID is the durable protocol identity.

## Validate and pack locally

Install the Runtime development environment, then use the bundled CLI:

```bash
cd runtime
uv run shejane-plugin validate ../../runtime/plugins/fixtures/wasi-archive
uv run shejane-plugin pack ../../runtime/plugins/fixtures/wasi-archive \
  --output /tmp/archive.shejane-plugin
uv run shejane-plugin inspect /tmp/archive.shejane-plugin
```

`validate` and `inspect` perform no plugin code execution. `pack` validates first and produces a deterministic archive with the same canonical digest. `inspect` reports package identity, execution kind, platform, digest, and whether a detached signature is absent or present but not cryptographically verified. Runtime installation remains responsible for verification against its deployment-owned trust store.

The adapter conformance suite remains repository-owned for v1; run the focused Runtime tests for the chosen execution kind before publishing. A separate plugin test runner should be added only when third-party packages need to invoke that suite without a SheJane source checkout.

## Release checklist

- Manifest and referenced Action schemas validate with no unknown fields.
- Package contains one execution kind and at least one Action.
- Capability requests are minimal and exercised by tests.
- Malformed input, traversal, symlink, timeout, cancellation, quota, and corrupted output cases fail closed.
- Identical fixture input produces the expected logical result.
- No secret, token, credential, host path, or personal file is packaged or logged.
- Managed Worker packages declare and test every platform artifact separately.
- License and publisher metadata are accurate.
- The semantic version changes whenever contract or behavior changes.
- The package digest and optional signature are generated only after canonical packing.

The [security model](security-model.md) is normative: a package that passes functional tests but violates its trust boundaries is not compatible.
