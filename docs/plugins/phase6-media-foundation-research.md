# Phase 6 Media Foundation capability decision

> Decision date: 2026-07-16. Primary stage: P10. Adjacent stages: P6 input and asset lease, P11 cleanup, P12 Artifact settlement.

## Outcome

The source tree contains pinned Darwin/arm64 and Linux/arm64 FFmpeg Runtime Asset
builders. The Linux/arm64 asset, frozen onedir Worker, deterministic plugin package,
hostile-input corpus, cancellation/replay, and exact media goldens pass locally in the
production macOS VM. Media Foundation remains unavailable to installed plugins until
the signed/notarized release workflow proves the same final packaged-app Gate. No
host-installed FFmpeg counts as product capability.

The selected design is:

1. build `ffmpeg` and `ffprobe` from an authenticated FFmpeg release in SheJane-owned release infrastructure;
2. publish one content-addressed `org.ffmpeg.runtime` asset per supported platform and architecture;
3. compile without `--enable-gpl` or `--enable-nonfree`, disable network and capture devices, and retain the exact source, signature verification evidence, configure line, patches, license, and SBOM beside the binary release;
4. make Media Foundation a `managed_worker` plugin whose manifest freezes the exact asset version and digest;
5. pass only Runtime-owned `/input` references and private `/output` staging paths; never invoke a host `ffmpeg` from `PATH` and never move media bytes through JSON, SSE, receipts, or SQLite;
6. keep the plugin disabled on any platform that has not passed its native Asset, sandbox, hostile-input, deterministic-output, and golden parity Gate.

FFmpeg 8.1.2 is fixed rather than floating. The lock contains the release tarball SHA-256, verified release-key fingerprint, reviewed component matrix, Darwin toolchain/SDK/deployment target, and Linux OCI/toolchain/package closure.

## Why existing agent libraries do not fill the gap

- Codex currently treats selected images as attachments and uses `@` mentions for workspace files. This is a context-selection UX, not an isolated media pipeline or a pinned codec runtime: <https://github.com/openai/codex/issues/9978>.
- Pi provides an agent/runtime and extension surface but no host-enforced media Artifact engine: <https://github.com/badlogic/pi-mono>.
- LangChain's MCP/content-block support can carry multimodal response blocks, but it does not supply local codec binaries, immutable file references, process isolation, or Artifact settlement: <https://docs.langchain.com/oss/python/langchain/mcp>.

These systems remain useful references for selection and message projection, but none replaces SheJane's Runtime Asset, receipt, sandbox, and Artifact contracts.

## Why SheJane must own the FFmpeg build

FFmpeg states that it publishes source rather than official executable packages and that release tarballs are cryptographically signed. This makes third-party static-binary packages unsuitable as the authoritative supply chain for an open-source desktop runtime: <https://ffmpeg.org/download.html>.

FFmpeg's own configure contract says `--enable-gpl` changes the resulting binaries to GPL and `--enable-nonfree` makes them unredistributable. Its legal checklist recommends compiling without both options and distributing corresponding source and build details: <https://ffmpeg.org/legal.html>, <https://github.com/FFmpeg/FFmpeg/blob/master/configure>.

The media parser consumes untrusted files and FFmpeg publishes release-specific vulnerability fixes. Asset refresh is therefore a security update with a new immutable version/digest, never an in-place binary replacement: <https://ffmpeg.org/security.html>.

## Runtime Asset contract

The asset identity is:

```text
id       = org.ffmpeg.runtime
version  = 8.1.2+shejane.1
platform = darwin/arm64 | darwin/amd64 | linux/arm64 | linux/amd64 | windows/arm64 | windows/amd64
digest   = canonical SheJane Runtime Asset SHA-256
```

The payload contains only the reviewed `ffmpeg`/`ffprobe` executables, their asset-local dynamic libraries, and required data files. The manifest lists every executable. The SBOM records upstream source identity, compiler/toolchain, configure flags, linked libraries, and license for every component.

Minimum configure policy:

```text
--disable-autodetect
--disable-network
--disable-devices
--disable-ffplay
--disable-doc
--disable-debug
--enable-shared
--disable-static
```

The platform build may explicitly enable only reviewed demuxers, decoders, parsers, filters, image/audio encoders, and file/pipe protocols required by the four Actions. It must never add `--enable-gpl` or `--enable-nonfree`. A codec/format matrix belongs in the lock and golden suite, not in undocumented configure defaults.

## Plugin Actions

The first package exposes four explicit Actions:

| Action | Result | Artifacts |
| --- | --- | --- |
| `media.probe` | bounded container/stream metadata and duration | none |
| `media.thumbnail` | selected timestamp and dimensions | one PNG |
| `media.extract_frames` | exact requested timestamps and per-frame metadata | bounded PNG set |
| `media.extract_audio` | stream choice, duration, sample rate, channels | one WAV or FLAC |

Every Action requires an explicit `input_id`. Timestamp lists, output format, dimensions, stream index, and sample configuration are validated generation parameters and appear in Runtime-generated provenance. No Action accepts an arbitrary FFmpeg argument string.

## Determinism and safety rules

- Invoke binaries by the exact Runtime Asset path, with a fixed minimal environment and no shell.
- Use `-nostdin`, `-hide_banner`, `-loglevel error`, `-nostats`, explicit stream maps, and explicit output formats.
- Remove inherited metadata and variable timestamps from generated files; apply bit-exact flags where the selected codec supports them.
- Bound probe bytes/time, stream count, duration, frame count, image dimensions, stderr, progress frames, wall time, memory, and aggregate Artifact bytes.
- Treat all probe JSON as untrusted: validate types, depth, count, and finite numeric ranges before returning it.
- Report progress from parsed `-progress pipe:2` or an isolated progress descriptor, never by forwarding raw stderr.
- On cancel, terminate the FFmpeg process tree and delete uncommitted staging output.
- Keep external URLs and network protocols disabled in both the build and OS sandbox.

## Release Gate

A platform is supported only when all of the following pass on the packaged application:

1. source signature, lock, canonical asset digest, executable closure, license bundle, and SBOM verification;
2. `ffmpeg -version` and `ffprobe -version` match the lock and contain no GPL/nonfree configuration;
3. hostile and truncated corpus tests fail closed without escaping the Managed Worker sandbox;
4. no host path, loopback, Unix socket/named pipe, credential, or undeclared executable is reachable;
5. metadata, thumbnail, frame, and audio goldens match the platform baseline;
6. large inputs keep bounded Runtime RSS and never enter JSON/checkpoints;
7. timeout and user cancellation leave no worker/FFmpeg descendant or partial Artifact;
8. package and Runtime Asset remain fail-closed in Plugin Registry until the platform's general Managed Worker resource/isolation Gate also passes.

## Implementation order

1. Add the signed-source lock format and asset build/verification scripts.
2. Add a fixture asset with fake `ffmpeg`/`ffprobe` executables to test the Worker contract without consulting host tools.
3. Implement schemas, Worker, package builder, progress, provenance, and deterministic fixture goldens.
4. Produce and audit the first real `darwin/arm64` asset.
5. Repeat native builds and Gates for the remaining release targets.

This deliberately separates “the Worker contract is implemented” from “untrusted media execution is releasable.”

## Current platform evidence

On 2026-07-16, two independent builds on the locked Xcode 26.6 / Apple Clang 21 / macOS SDK 26.5 host were byte-for-byte identical. The candidate records macOS 11.0 in every Mach-O load command and passed Runtime Asset installation plus real `media.probe`, static-image `media.thumbnail`, Matroska/MJPEG `media.extract_frames`, and WAV-to-FLAC `media.extract_audio` execution.

```text
archive SHA-256  = e49050ae5d7995dba176381c9aa4c7b4ac9989d6405f9b539bccd28de8b080ee
canonical digest = sha256:00c4328b012e5bbb35482e9e71c10fa415d046c213b819636ba622a1de9f3b60
```

These identify the earlier Darwin-native reference candidate only. It is not the
current macOS execution target, is not checked into the repository, and is not enabled
in Plugin Registry.

The Linux/arm64 candidate is the real macOS arm64 execution target. Two full asset
builds, each of which also performs two independent native builds internally, produced
identical archives. The asset-local FFmpeg/FFprobe and zlib closure runs as UID/GID
65534 inside the read-only Linux guest rootfs:

```text
archive SHA-256   1a8e20a1e93dea506201f5e9fc24a62507725a964cf890e57d0a68d430661e93
canonical digest  sha256:64026538d7f9638fa0342e67cf22325e37b309e1cf0214ff5f9fa3c754674d55
plugin digest     sha256:035f925bb43fc47bf655a55377eb929085700b8e63ff5a15a9676001d57a8c49
```

The real VM suite passes probe, exact thumbnail/frame/audio hashes, hostile/truncated
inputs, cancellation with no partial Artifact, and deterministic replay. These gates
are wired into `release-desktop.yml` against the final packaged VM assets. Until that
workflow succeeds with real Developer ID signing and notarization, `release_ci_gate`
and Plugin Registry remain closed. Linux/amd64 and Windows require independent assets
and equivalent native evidence.
