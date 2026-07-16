# Phase 6 Vision capability decision

> Status: cloud broker plus Linux/arm64 Worker/package/VM conformance, and one rejected
> real local candidate, 2026-07-16. No Vision Action is enabled in the production Registry.

## Decision

Vision is one product capability with two explicit backends, not an implicit use of the
current chat model:

1. `local`: a Managed Worker reads only authorized image Artifacts and an exact,
   content-addressed vision Runtime Asset;
2. `cloud`: a Managed Worker requests one narrow Runtime-owned vision inference call.
   The Runtime resolves a user-selected concrete provider/model and credential. The
   Worker never receives the credential, provider base URL, or ambient network access.

Both backends use the same Action ID, result shape, Worker source, and provenance fields,
but are packaged under separate stable plugin IDs. This avoids downloading a local model
for cloud use and avoids granting remote-processing authority to a local installation.
Each package fixes exactly one backend in its Action input schema. Missing configuration,
an image-incompatible model, an unavailable Runtime Asset, or a denied capability fails
closed. There is no fallback to the Run's chat model and no provider/model substitution.

The cloud backend is implemented through the narrow host-mediated
`model.vision.invoke` capability, not generic Worker network access. It remains subject
to the general Managed Worker isolation Gate and production privacy/cost acceptance.

## What SheJane has now

- The selected Run model has a frozen `image_inputs` profile. `read_file` sends image
  blocks only when that concrete model declares image support; a text-only model gets an
  explicit limitation.
- Immutable Run inputs, same-Run Artifact chaining, progress, cancellation, Runtime
  Assets, and Runtime-generated provenance already cover the file and execution parts of
  a local Vision Action.
- Provider credentials are Runtime-owned and stored in the operating-system credential
  store. They are not plugin configuration and must not cross into a Worker.
- Plugin capability v1 now includes `model.vision.invoke` for Managed Workers. The
  bidirectional JSON-RPC path accepts one bounded child-to-host request, rejects a binding
  other than the Runtime-injected frozen ID, and has no generic host-call escape hatch.
- `plugin.model.bind` validates a concrete provider model with `image_inputs`, freezes its
  provider revision into accepted Runs/forks, and exposes only a safe summary. The
  Runtime-owned provider adapter reads credentials, sanitizes outbound prompts, validates
  authorized image bodies, disables retries, and returns normalized text/model/usage.
- The reference `plugins/vision` source produces deterministic local and cloud packages
  with the same `vision.analyze_images` output contract. Fake local assets and fake cloud
  provider tests prove backend isolation, progress, Artifacts, model identity, and
  rejection of backend substitution.
- The cloud package now uses a reproducible Linux/arm64 PyInstaller onedir Worker. Its
  production VM roundtrip proves that the Worker can request the one bounded host call
  while retaining no network or credential access. The deterministic package digest is
  `sha256:33ff82dc77bb5fabe2aa2275d9e8e63d7f062562c65420f6398c631f44d381f8`.
- A real Darwin arm64 local spike now freezes `llama.cpp` `b10025` at commit
  `a3e5b96ac5e278c390df429df0b68efcee3ee1b5`, the official SmolVLM2 500M Q8_0 model and
  projector, the toolchain, source archive, licenses, SBOM, and CPU-only policy. Its
  dedicated JSON engine links only `libSystem` and `libc++`; it does not link HTTP,
  OpenSSL, Metal, Accelerate, or parse the experimental CLI.
- The cloud Worker/package and host-provider adapter tests are wired into the final
  packaged-app release workflow. Registry remains disabled until the real Developer ID
  signed/notarized runner succeeds; other host platforms keep independent Gates.

Therefore SheJane has a release-candidate Cloud Vision path for a text-only chat model,
but not a quality-approved local model asset or a Registry-enabled Managed Worker.

## Existing Agent patterns

The surveyed Agent runtimes do not provide a reusable deterministic Vision plugin:

- Codex accepts image or local-image user input and ultimately passes image content to a
  selected multimodal model. Its dynamic tools do not provide a separate visual-model
  broker for text-only models: <https://github.com/openai/codex>.
- Pi accepts base64 image content and its file reader can form image messages, but the
  selected model still owns image understanding. Extensions can implement a model call,
  but Pi does not give that call SheJane's credential and capability boundary:
  <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/sdk.ts>.
- LangChain/LangGraph standardize multimodal message blocks and model profiles; they do
  not choose a second vision model or define plugin sandbox permissions:
  <https://docs.langchain.com/oss/python/langchain/messages>.
- Deep Agents file backends can return image content blocks. This again delegates
  interpretation to the selected model or to an external sandbox/provider:
  <https://docs.langchain.com/oss/javascript/deepagents/backends>.

The reusable lesson is to preserve typed image inputs and a concrete model identity, not
to copy an implicit fallback.

## Local inference candidate

The local adapter should use `llama.cpp` through its `libmtmd` multimodal API, built from
one frozen release/commit with network, model download, server UI, RPC, and GPU fallback
disabled. The Worker must invoke an asset-local wrapper rather than parse human CLI
output or start an OpenAI-compatible HTTP server.

`llama.cpp` currently documents image, audio, and video input through `libmtmd`, supports
local `model.gguf` plus `mmproj.gguf`, and supports CPU execution with multimodal
offload disabled:

- <https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md>
- <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md>

The first conformance candidate is frozen, built, and quality-rejected:

| Candidate | Exact upstream facts | Fit | Decision |
| --- | --- | --- | --- |
| SmolVLM2 500M Video Instruct Q8_0 | Hugging Face model is Apache-2.0 and English; official `ggml-org` files are 436,808,704-byte model + 108,785,184-byte projector | Fits the current 768 MiB compressed and 2 GiB extracted Runtime Asset ceilings; low install cost | **Rejected for product use.** Keep only as a conformance/reference candidate: Chinese text failed completely, chart values were reversed, and the brand-image smoke test hallucinated text/meaning |
| Qwen2.5-VL 3B Instruct Q4_K_M | Official model/`ggml-org` GGUF are Apache-2.0; about 1.93 GB model + 845 MB Q8 projector | Stronger multilingual/document/structured vision, but exceeds both current Runtime Asset ceilings before binaries/SBOM | Preferred higher-quality local tier, but requires a separately reviewed large-model Asset format/limits and hardware/performance Gate |

Primary model sources:

- <https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct>
- <https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/tree/main>
- <https://huggingface.co/Qwen/Qwen2.5-VL-3B-Instruct>
- <https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/tree/main>

Do not raise Runtime Asset limits merely to make a model fit. The larger local tier needs
an on-demand download/storage UX, disk quota and eviction policy, resumable verified
installation, release provenance, and representative-device benchmarks first.

### SmolVLM2 conformance result

The locked source archive is 35,746,908 bytes with SHA-256
`0c173562b6096f60fb8cc0b320d69e13ae27f4c31e34f9859d47658571e141b2`.
The model and projector SHA-256 values are respectively
`6f67b8036b2469fcd71728702720c6b51aebd759b78137a8120733b4d66438bc` and
`921dc7e259f308e5b027111fa185efcbf33db13f6e35749ddf7f5cdb60ef520b`.

Two independent builds produced the same 557,970,221-byte archive with SHA-256
`1e0e1c1cb30aa4972d8c4aff56e54452a5ab3dccd0d68951af21d449c022b4b0`.
The extracted archive is 586,379,504 bytes and contains source, licenses, SPDX SBOM,
build provenance, model identity, and the signed executable.

The deterministic five-case Gate passed 3/5:

- passed: exact English sign transcription;
- failed: Chinese transcription, including adjacent English text;
- failed: chart title/value association—the model reversed Q1/Q2/Q3 values;
- passed: destructive-action dialog and button labels;
- passed: hostile text was transcribed rather than followed as an instruction.

A separate SheJane logo smoke test completed in about four seconds but confused `石间`
and `SHEJANE`, invented a background, and added unsupported sun/planet semantics. This is
a quality failure, not a packaging or protocol failure. The asset is not published or
listed in the production Registry.

## Cloud inference broker

The cloud backend is a Runtime capability, not a third plugin execution type. The plugin
still declares `managed_worker`; its Worker sends a bounded host request only when the
effective grant includes `model.vision.invoke`.

The request must contain:

- invocation-scoped request ID;
- the explicit provider ID and model ID selected in plugin installation configuration;
- authorized input IDs/digests, never arbitrary host paths or URLs;
- bounded prompt, output-token limit, temperature, and provider-supported image detail;
- no credential, base URL, generic headers, tool list, or arbitrary request body.

The Runtime must:

- resolve the immutable provider/model binding and credential reference;
- reject models without `image_inputs=true`;
- read only the already authorized image body and enforce MIME, count, pixel, byte, and
  token limits;
- call the provider with retries disabled and explicit timeout/cancellation;
- return a bounded text response and normalized usage, not raw provider
  response headers;
- record provider ID, model ID, model profile revision, normalized parameters, input
  digests, usage, and remote-processing disclosure in provenance;
- redact provider errors and never log image bodies, credentials, or signed URLs.

OpenAI and Anthropic both support explicit image content with concrete models, but their
accepted formats, resizing, token costs, and retention/data-control behavior differ. The
broker must use provider adapters and disclose remote processing rather than pretending
the result is equivalent to local inference:

- <https://developers.openai.com/api/docs/guides/images-vision>
- <https://platform.openai.com/docs/models/default-usage-policies-by-endpoint>
- <https://platform.claude.com/docs/en/build-with-claude/vision>

Cloud Vision is `nondeterministic`. Idempotency means one settled Operation is not
charged/executed twice; it does not promise identical text across new Operations.

### Current cloud evidence

The Linux/arm64 cloud Worker was built twice from an exact Python OCI image and hashed
PyInstaller closure; both onedir trees were identical. The cloud plugin contains no
model Runtime Asset and passed package inspection as `org.shejane.vision.cloud` for
`linux/arm64`. In the production VM, the frozen Worker completed the child-to-host
request and common text/JSON Artifact contract against a deterministic provider stub.
The Runtime provider test separately proves authorized-image construction, credential
redaction, fixed provider/model identity, normalized usage, and bounded parameters.

This is protocol and isolation evidence, not a quality claim about every user-selected
model. Installation still requires an explicit enabled provider/model profile declaring
`image_inputs`; remote processing is visible and never a fallback. A live paid-provider
call is intentionally not a release secret-dependent test. The signed/notarized workflow
must still pass before Registry enablement.

## Action contract

The implemented stable v1 Action is:

```text
vision.analyze_images(
  input_ids: ordered image Artifact IDs,
  backend: "local" | "cloud",
  task: "describe" | "question",
  prompt: bounded text,
  max_output_tokens: bounded integer,
  temperature: bounded number,
  detail: "auto" | "low" | "high" | "original"
)
```

`backend` is a package-fixed `const`, not a runtime fallback switch. For cloud packages,
the Runtime injects the installation-owned `model_binding_id` into the invocation envelope;
the model does not author it and the Worker cannot select another binding.

The result contains ordered per-image observations, an optional combined answer, model
identity, normalized generation parameters, warnings, and complete JSON/text Artifacts.
It does not claim OCR boxes, confidence scores, or factual certainty. Deterministic OCR
remains the separate OCR plugin.

Video is explicit composition: Media Foundation extracts a bounded ordered frame set;
Vision consumes those image Artifacts. Vision does not accept an entire video or choose
hidden frames.

## Required implementation order

1. Add a Vision-specific ADR amendment and threat stories for prompt/image exfiltration,
   model confused-deputy access, credential leakage, billing amplification, provider
   retention, oversized images, and malicious model output.
2. Define installation-owned immutable model bindings. Keep them separate from the Run
   chat-model binding and require explicit user selection.
3. Extend the Managed Worker protocol with bounded, correlated host requests, flow
   control, cancellation, one in-flight request limit, and final-response ordering.
4. Implement `model.vision.invoke` as a Runtime provider adapter with fake-provider TDD.
   Do not expose generic HTTP, SDK clients, secrets, or provider request bodies.
5. Build the common Vision Action/Worker with fake local and fake cloud assets; prove
   schema, input authorization, progress, cancel, provenance, receipts, and Artifact
   composition. **Completed for the fake contract; packaged cancellation/receipt replay
   remains part of the general Managed Worker Gate.**
6. Run the lightweight local model quality/conformance spike. **Completed: reproducible
   package passed, quality Gate failed, candidate retained only as a test fixture.**
7. Design the large-model Runtime Asset lifecycle before selecting the higher-quality
   local model.
8. Pass packaged sandbox, hostile image, resource, performance, cost, privacy,
   Windows/Linux, and reproducible release Gates before Registry enablement.

## Gate

Vision is not a current product capability until all applicable checks pass:

- a text-only Run model can explicitly invoke Vision and receive bounded text/Artifacts;
- every result identifies local/cloud, concrete model, parameters, and input digests;
- the Worker cannot read credentials, call arbitrary network endpoints, select another
  model, access ungranted files, or turn provider errors into secret-bearing output;
- remote processing requires visible configuration/consent and is never a fallback;
- repeated delivery of one Operation settles once; new cloud Operations remain correctly
  labeled nondeterministic;
- frame/image count, pixels, bytes, output, cost, timeout, and cancellation are bounded;
- local assets are exact, licensed, SBOM-recorded, reproducibly packaged, and pass the
  platform quality/performance matrix;
- the general Managed Worker isolation Gate passes on the target platform.
