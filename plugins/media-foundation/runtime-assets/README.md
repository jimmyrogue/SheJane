# FFmpeg Runtime Asset

`ffmpeg-8.1.2.lock.json` freezes the upstream source archive, official release signature key, permitted LGPL build policy, and forbidden configuration. Verify downloaded inputs offline before any build:

```bash
python verify_source.py \
  --source ffmpeg-8.1.2.tar.xz \
  --signature ffmpeg-8.1.2.tar.xz.asc \
  --signing-key ffmpeg-devel.asc
```

The key fingerprint must be established from a trusted release-process channel, not merely from the downloaded key file. The locked fingerprint matches FFmpeg's published release key as verified on 2026-07-16.

The native builders currently target Darwin/arm64 and Linux/arm64. Linux uses the
locked Debian OCI/toolchain closure and packages asset-local zlib; it passes the same
codec/protocol, license, SBOM, version, dependency, and reproducibility checks. Other
targets remain unavailable until they implement equivalent builders and native Gates.

The Darwin builder also freezes Xcode, Apple Clang, SDK, GNU Make, and the macOS 11.0 deployment target. It rejects a missing codec/format capability, extra network protocol, undeclared dynamic library, or mismatched Mach-O minimum version. Build twice from the same verified inputs, then verify byte reproducibility and the canonical Runtime Asset identity:

```bash
cd services/runtime
uv run python ../../plugins/media-foundation/runtime-assets/verify_release.py \
  --asset /path/to/first.shejane-runtime-asset \
  --reproducible-copy /path/to/second.shejane-runtime-asset
```

`archive_sha256` verifies the downloadable ZIP bytes. `canonical_digest` is the content-addressed identity that belongs in a plugin manifest; they are deliberately different digest domains.

Run the real Worker acceptance suite against the candidate before release:

```bash
cd services/runtime
SHEJANE_FFMPEG_RUNTIME_ASSET=/path/to/first.shejane-runtime-asset \
SHEJANE_TEST_MEDIA_WORKER=/path/to/media-foundation-worker \
SHEJANE_TEST_MACOS_VM_ASSETS=/path/to/manifest.json \
  uv run python -m pytest tests/test_media_foundation_runtime_asset.py -q
```
