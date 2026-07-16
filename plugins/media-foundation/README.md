# Media Foundation plugin

This Managed Worker plugin uses only an exact `org.ffmpeg.runtime` asset. It never discovers or invokes host FFmpeg binaries. The first Actions provide bounded metadata, thumbnails, frames, and audio extraction.

The Linux/arm64 asset, onedir Worker, deterministic plugin package, hostile corpus,
cancellation replay, and media goldens pass locally in the production macOS VM. The
release workflow repeats those checks against the final packaged VM. Registry remains
closed until that signed/notarized workflow succeeds; every other execution platform
still needs its own equivalent Gate. See `docs/plugins/phase6-media-foundation-research.md`.
