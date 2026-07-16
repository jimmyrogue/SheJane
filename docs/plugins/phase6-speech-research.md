# Phase 6 Speech capability decision

> Decision date: 2026-07-16. Primary stage: P10. Adjacent stages: P6 immutable input and Runtime Asset leases, P9 tool routing/review, P11 cancellation and descendant cleanup, P12 receipt and Artifact settlement.

## Outcome

Speech is a deterministic, offline Managed Worker plugin. The first implementation freezes one local stack rather than selecting an engine at runtime:

```text
normalizer  org.ffmpeg.runtime 8.1.2+shejane.1
engine      whisper.cpp 1.8.6, commit 23ee03506a91ac3d3f0071b40e66a430eebdfa1d
model       OpenAI Whisper large-v3-turbo, Q5_0 GGML
source      OpenAI checkpoint SHA-256 aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a
execution   CPU only, one thread, greedy, temperature 0, no fallback
task        transcription only
timestamps  segment timestamps only
network     none
```

The plugin exposes one bounded Action, `speech.transcribe`. It accepts one immutable audio attachment or same-Run audio Artifact, normalizes it with the already frozen FFmpeg Runtime Asset to mono 16 kHz signed 16-bit PCM WAV, and transcribes it with an exact `org.whisper.runtime` asset. The Action returns bounded segment metadata and a short transcript view; complete UTF-8 text, SRT and canonical JSON are optional file-backed Artifacts.

There is no implicit chat-model audio path, remote ASR fallback, host `ffmpeg`, host Python, model download, model selector, translation, diarization, VAD, or GPU/provider switching. A future cloud Speech plugin or live-voice transport is a separate capability with its own provider/model identity and consent boundary.

## Existing-agent comparison

- Codex keeps normal durable turns text/image-oriented. Its current app-server has a separate experimental thread-scoped Realtime path for appending audio and streaming transcript/audio notifications; those realtime notifications are transport events rather than durable ThreadItems. This is a useful reason to keep future live voice separate from file transcription, not a local deterministic ASR implementation: [Codex protocol v1](https://github.com/openai/codex/blob/main/codex-rs/docs/protocol_v1.md) and [Codex app-server realtime protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).
- Pi's current core `UserMessage` and `ToolResultMessage` types accept text and images, not audio. Its maintainer-provided transcription example is instead a file-to-text skill that calls an external Groq Whisper API. The reusable pattern is the explicit tool boundary, not its remote provider: [Pi message types](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) and [Pi transcription skill](https://github.com/badlogic/pi-skills/blob/main/transcribe/SKILL.md).
- LangGraph is a low-level orchestration runtime; LangChain's message layer can carry standardized audio blocks, while the selected model/provider owns actual audio support. LangChain also separates concise model-visible tool content from supplementary `artifact` data: [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview) and [LangChain messages and audio blocks](https://docs.langchain.com/oss/python/langchain/messages).
- Deep Agents can read common audio files and pass audio content blocks when the selected model supports them, but its multimodal guidance warns that large binary results should live in a backend and be represented by concise text plus a path or URL. Its model capability remains provider-dependent: [Deep Agents multimodal](https://docs.langchain.com/oss/python/deepagents/multimodal) and [Deep Agents models](https://docs.langchain.com/oss/python/deepagents/models).

SheJane therefore follows Pi's explicit file-to-text shape for durable Runs, LangChain's text-versus-Artifact separation, and Codex's separation of live audio transport from normal durable task state. The source audio never becomes a base64 model message.

## Engine comparison

| Candidate | Strengths | Deterministic desktop packaging cost | Decision |
| --- | --- | --- | --- |
| `whisper.cpp` | Plain C/C++, CPU-only inference, integer quantization, native builds for macOS, Linux and Windows, full JSON and segment timestamps | Small native closure; model conversion/quantization and every target build must be locked and reproduced | Selected |
| `faster-whisper` + CTranslate2 | Strong CPU throughput, INT8, mature segment and word timestamps, optional VAD | Python, PyAV/FFmpeg libraries, CTranslate2, tokenizer and optional Silero model form a larger closure; CTranslate2's published wheel matrix lists Windows x86-64 but not Windows Arm64 | Rejected for v1 |
| `sherpa-onnx` / other ONNX wrappers | Broad CPU/platform support and many ASR model families | Adds ONNX Runtime plus a larger multi-model surface; timestamp fields are model-dependent and may be absent, so one stable Speech schema still needs model-specific policy | Separate future plugin candidate |
| direct ONNX Runtime Whisper | Exact provider selection is possible | SheJane would have to own feature extraction, tokenizer, autoregressive decoding, language detection, long-form stitching and timestamp alignment | Rejected |
| OpenAI Whisper Python | Canonical reference implementation and official model download hashes | PyTorch and Python are a substantially larger frozen runtime than the native C++ path | Release-builder reference only |

`whisper.cpp` 1.8.6 is the current stable upstream release and its tag points at a GitHub-verified signed commit. The project documents CPU-only inference, macOS Intel/Arm, Linux and Windows builds, and an MIT license: [whisper.cpp repository](https://github.com/ggml-org/whisper.cpp), [v1.8.6 release](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.8.6), and [license](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE).

`faster-whisper` remains a good alternative benchmark. It exposes CPU INT8 and word timestamps and publishes materially better CPU throughput than the PyTorch reference in its own fixed benchmark. It also downloads named models from Hugging Face unless an exact local directory is supplied, and optional VAD adds another model and policy surface: [faster-whisper usage and benchmark](https://github.com/SYSTRAN/faster-whisper). CTranslate2 publishes wheels for Linux x86-64/AArch64, macOS x86-64/Arm64 and Windows x86-64, which leaves a gap in SheJane's full Windows target matrix: [CTranslate2 installation](https://opennmt.net/CTranslate2/installation.html).

For ONNX, sherpa-onnx is self-contained and supports desktop/Arm CPU targets, but its C API states that token timestamps may be null when a model does not provide them. That variability is appropriate for a separate concrete engine plugin, not a hidden fallback under `speech.transcribe`: [sherpa-onnx overview](https://k2-fsa.github.io/sherpa/onnx/index.html) and [timestamp result contract](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/c-api/c-api.h).

## Model choice

OpenAI describes `large-v3-turbo` as a pruned `large-v3` with four decoder layers instead of 32, providing much faster transcription with a minor quality reduction. The checkpoint is multilingual, has 809 million parameters, and is not trained for translation. Its model card also warns about uneven language performance and hallucinated text: [OpenAI model card](https://huggingface.co/openai/whisper-large-v3-turbo) and [OpenAI Whisper repository](https://github.com/openai/whisper).

The selected Q5_0 GGML form is 547 MiB. For comparison, upstream lists multilingual `small` at 466 MiB, `medium` at 1.5 GiB, unquantized `large-v3-turbo` at 1.5 GiB, and `large-v3` at 2.9 GiB. Q5_0 keeps the stronger turbo model near the distribution size of `small`; no smaller model is silently chosen on low-memory machines: [whisper.cpp model inventory](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md).

The release builder must not trust a floating pre-converted model. OpenAI's source maps `large-v3-turbo` to an HTTPS checkpoint whose URL embeds SHA-256 `aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a` and verifies downloaded bytes against it: [OpenAI model loader](https://github.com/openai/whisper/blob/main/whisper/__init__.py). The builder freezes OpenAI Whisper tag `v20250625` (`31243bad24cc746f07d4c8bfdd2d974872cb1803`), converts that exact checkpoint to GGML, then quantizes it with the exact `whisper.cpp` 1.8.6 tool. The final model SHA-256 becomes part of every `org.whisper.runtime` manifest and must be identical across platform assets.

## Action contract

`speech.transcribe` has one explicit `input_id` and these bounded arguments:

- `language`: one supported ISO-639-1 code or `auto`; the resolved language is returned. No silent language retry occurs.
- `initial_prompt`: optional, at most 512 UTF-8 characters, included in provenance and never treated as secret state.
- `max_segments` and `max_characters`: explicit inline/result ceilings; full accepted output remains available only through requested Artifacts.
- `include_text_artifact`, `include_srt_artifact`, and `include_json_artifact`: explicit output choices.

The normalized response includes:

- exact engine version/commit, model name, quantization, model SHA-256, CPU provider and thread count;
- input duration, requested language, resolved language and normalization parameters;
- ordered segments with integer `start_ms`, `end_ms` and normalized text;
- aggregate segment/character counts and explicit truncation state;
- optional Artifact names.

Segment timestamps are stable v1 contract data. `whisper.cpp` calls its word-level timestamps experimental, so token/word timestamps do not enter the first public schema: [whisper.cpp timestamp documentation](https://github.com/ggml-org/whisper.cpp#word-level-timestamp-experimental). Diarization is also excluded; stereo channel labeling and speaker-identity models are materially different capabilities.

## Audio normalization and composition

The upstream CLI expects 16-bit WAV and recommends FFmpeg conversion to 16 kHz mono PCM: [whisper.cpp input contract](https://github.com/ggml-org/whisper.cpp#quick-start). SheJane already has a fixed, content-addressed `org.ffmpeg.runtime`, so Speech requires both assets:

```text
org.ffmpeg.runtime  -> bounded decode/resample to private 16 kHz mono PCM WAV
org.whisper.runtime -> exact model inference over that private WAV
```

The Worker invokes only asset-local executables and records the normalizer and inference asset digests in Runtime provenance. It never compiles FFmpeg into a second Speech-specific asset and never discovers host tools.

Direct audio attachments use this internal normalization stage. Video composition remains explicit: `media.extract_audio` creates a same-Run WAV/FLAC Artifact, then `speech.transcribe(input_id=...)` consumes that Artifact. Speech does not accept video MIME types and does not hide frame/audio selection.

## Determinism and safety rules

- Build `whisper.cpp` without Metal, Core ML, CUDA, Vulkan, OpenVINO, BLAS, FFmpeg, SDL, microphone, server, examples unrelated to the engine wrapper, or runtime downloads.
- Ship a small SheJane `speech-engine` wrapper over the C API instead of accepting arbitrary `whisper-cli` arguments or parsing human console output.
- Run CPU only with one inference thread and one processor, greedy decoding, `best_of=1`, temperature `0`, temperature fallback disabled, flash attention disabled, and fixed locale/timezone.
- Keep transcription only. Translation is rejected because turbo is not trained for it; VAD, diarization, hidden silence retries, model fallback and prompt rewriting are disabled.
- Normalize all timestamps to integer milliseconds, remove NUL/unsafe controls, normalize line endings, preserve segment order, and emit canonical UTF-8 JSON/SRT/text.
- Treat engine JSON as untrusted: validate schema, nesting, finite values, timestamp monotonicity, duration bounds, text/segment counts and engine identity before creating Artifacts.
- At most one input, two hours decoded duration, 16,000 Hz, one channel, 20,000 segments, 500,000 transcript characters and 64 MiB aggregate text/JSON/SRT output. Compressed input bytes, decoded PCM bytes, stderr/stdout, wall time and RSS remain separately host-bounded.
- Source audio, normalized WAV and model weights never enter SQLite, receipts, SSE or model context. Normalized WAV stays in private staging and is removed at P11.
- Cancellation terminates the Worker, FFmpeg and inference descendants and removes normalized audio plus uncommitted outputs. A failed decode, model load, malformed engine response, timeout or output overflow settles no Artifact.

The same plugin digest, both Runtime Asset digests, input digest, arguments and platform target define one input-stable execution identity. Same-host repeated runs must have identical normalized logical output and Artifact hashes. Cross-platform floating-point and SIMD behavior may move decoding boundaries, so release evidence must not claim byte-identical inference across CPU architectures without proof; every platform instead has an explicit golden baseline and records its exact asset digest.

## Runtime Asset and supply-chain contract

```text
id       = org.whisper.runtime
version  = 1.8.6+large-v3-turbo-q5-0.shejane.1
platform = darwin/arm64 | darwin/amd64 | linux/arm64 | linux/amd64 | windows/arm64 | windows/amd64
digest   = canonical SheJane Runtime Asset SHA-256
```

Each platform payload contains the reviewed `speech-engine`, exact Q5_0 model, native dependency closure, licenses, SBOM and build provenance. OpenAI Whisper and whisper.cpp are MIT licensed: [OpenAI Whisper license](https://github.com/openai/whisper/blob/main/LICENSE) and [whisper.cpp license](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE).

The release process must:

1. lock and verify the exact `whisper.cpp` source commit/tag and source archive bytes, stating the upstream authentication level honestly;
2. lock OpenAI Whisper conversion source, every build dependency and the official checkpoint SHA-256;
3. perform checkpoint loading/conversion in an isolated, credential-free release builder with network disabled after verified inputs arrive;
4. produce one canonical converted/quantized model, prove two same-host model builds byte-for-byte identical, and reuse those exact model bytes in every native asset;
5. freeze compiler, linker, CMake, SDK/deployment target and build flags per platform; reject undeclared dynamic libraries, GPU/provider backends, network clients and host-path discovery;
6. sign/authenticate native deliverables according to the platform release policy and publish source, patches, licenses, SBOM and provenance beside each asset.

## Release Gate

1. source/tag/checkpoint locks, authentication evidence, licenses, SBOM, model conversion provenance and native closure pass;
2. two clean same-host builds produce identical model bytes, Runtime Asset archives and canonical asset digests;
3. exact-version English, Mandarin, Japanese and mixed Latin-script fixtures cover explicit language and `auto`, accents, noise, music, silence, low volume, long pauses, code terms and prompt terms;
4. segment text and timestamps pass same-platform goldens; cross-platform parity is measured and any permitted timestamp tolerance is explicit rather than hidden;
5. malformed/truncated audio, decompression bombs, two-hour boundary, excessive segments/text and hostile metadata fail within time/memory/output limits;
6. direct normalization and `media.extract_audio -> speech.transcribe` same-Run Artifact chaining both pass without copying media into JSON/checkpoints;
7. timeout and user cancellation leave no Worker, FFmpeg/inference descendant, normalized WAV or partial Artifact;
8. packaged-app sandbox conformance blocks host files, network, loopback, IPC and undeclared executables while allowing only declared input, private output and exact Runtime Assets;
9. macOS, Windows and Linux assets pass equivalent native contracts, including a real Windows Arm64 build, before that target is advertised;
10. Plugin Registry remains fail closed until the platform's general Managed Worker trust/resource Gate passes.

## Current implementation boundary

The repository already has every cross-plugin protocol Speech needs: immutable content-addressed Run inputs, ordered same-Run Artifact binding, file-backed Artifact bodies, progress, cooperative/forced cancellation, exact Runtime Asset leases and Runtime-generated provenance. Media Foundation already supplies the fixed FFmpeg normalizer asset.

The repository now contains the strict `speech.transcribe` schemas, deterministic package template/builder, Managed Worker, and fake-asset contract tests. The Worker verifies the immutable input, uses only the two declared Runtime Assets, requests fixed CPU decoding, validates exact engine/model identity and bounded segment timestamps, keeps the complete transcript in optional text/SRT/JSON Artifacts, and removes private normalization files and uncommitted outputs on failure.

The macOS arm64 `org.whisper.runtime` reference candidate is also implemented. It uses a narrow native C++ wrapper over the whisper.cpp C API and accepts only FFmpeg-normalized 16 kHz mono PCM s16 WAV. It does not compile the upstream example audio decoders. The model builder independently converted and quantized the official checkpoint twice with identical bytes:

```text
converted F16 SHA-256  1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69
Q5_0 model SHA-256     394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2
Q5_0 model size        574041195 bytes
```

Source-prefix normalization removed temporary build paths from the Mach-O. Two clean native asset builds then produced identical 550,354,244-byte archives:

```text
archive SHA-256        4db7913414a03bf5e4a5f4aa477ee182df9b33b42f01885f71f4173613beda26
canonical asset digest sha256:e1694501072ce6a85a53701374372f1a24a7371c434333d4e0ba5524c4336a41
```

Runtime installed the final asset and the real Worker completed the same input twice with identical normalized output and text/SRT/JSON Artifact hashes. The Runtime Asset compressed ceiling is now 768 MiB, independently from the ordinary plugin package ceiling, so this reviewed 525 MiB archive installs without relaxing the 2 GiB extracted-tree or 50,000-entry limits.

The actual macOS arm64 execution target is now a Linux/arm64 asset plus frozen onedir
Worker. Two complete 525 MiB archives are byte-identical, and the Runtime canonical
asset/package identities are fixed:

```text
archive SHA-256   883900b63f0cbf54542837459cd387124e2dc5fcdcbc56709d930991f5795cdd
canonical digest  sha256:dc6ec9da48a51f1f8cae40d8e84a4596608449a0721ca45af6b87d4cd6bb4f11
plugin digest     sha256:763fa8657b443e212035b95e06b54582c2accd21560f16e007e44d5bd326a956
```

In the production VM, repeat execution produced identical logical output and
text/SRT/JSON hashes. Explicit English and Mandarin synthetic speech, Japanese `auto`
detection under deterministic background noise/two-tone interference and a four-second
pause, three hostile audio forms, cancellation with no partial output, and a two-run
300-second performance ceiling pass. A 66.7-second, 45%-gain Rishi English fixture also
passes from first sentence through last under the same deterministic background, with
an explicit technical-term prompt. A real `media.extract_audio` FLAC Artifact feeds
`speech.transcribe` through the file boundary without inline media bytes. An engine
response reporting 7,200,001 milliseconds is rejected before Artifact creation. The
observed two-run cold-start time was 129 seconds on the local host.
Proper nouns remain normal probabilistic ASR: `SheJane` became `She Jane`/`She Janes`
and `石间` became `时间`, even with an initial prompt. The plugin must not promise
dictionary-constrained names or treat `initial_prompt` as a correction guarantee.

The asset/model/Worker/package and real VM tests are wired into
`release-desktop.yml`. A real Developer ID signed and notarized run has not passed, so
`release_ci_gate` and Registry remain closed. Real music, mixed-language/Latin-script
breadth, a real encoded two-hour boundary corpus, excessive segment/text/output cases,
Linux/amd64 and Windows native gates remain open. No host-installed Whisper/FFmpeg or
chat-model audio capability counts as current SheJane Speech support.
