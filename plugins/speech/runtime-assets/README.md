# Whisper Runtime Asset

This directory builds the exact `org.whisper.runtime` used by `speech.transcribe`.

The canonical model build accepts only the locked whisper.cpp source archive, OpenAI Whisper source archive, official `large-v3-turbo` checkpoint, and the exact hashed Darwin arm64 package closure in `model-requirements-darwin-arm64.lock` (Python 3.12.10, CMake 4.4.0, Torch 2.7.1, and NumPy 2.2.6). It converts and quantizes the model to the locked Q5_0 SHA-256. Darwin and Linux/arm64 builders create a CPU-only `speech-engine` with no Metal, Core ML, Accelerate, BLAS, RPC, curl, or host-tool fallback.

```bash
uv run python plugins/speech/runtime-assets/build_model_darwin.py \
  --whisper-source /path/to/whisper.cpp-v1.8.6.tar.gz \
  --openai-source /path/to/openai-whisper-v20250625.tar.gz \
  --checkpoint /path/to/large-v3-turbo.pt \
  --python /path/to/locked-python \
  --output /tmp/ggml-large-v3-turbo-q5_0.bin

uv run python plugins/speech/runtime-assets/build_darwin.py \
  --whisper-source /path/to/whisper.cpp-v1.8.6.tar.gz \
  --openai-source /path/to/openai-whisper-v20250625.tar.gz \
  --checkpoint /path/to/large-v3-turbo.pt \
  --model /tmp/ggml-large-v3-turbo-q5_0.bin \
  --output /tmp/whisper.shejane-runtime-asset

uv run python plugins/speech/runtime-assets/build_linux_arm64.py \
  --whisper-source /path/to/whisper.cpp-v1.8.6.tar.gz \
  --openai-source /path/to/openai-whisper-v20250625.tar.gz \
  --checkpoint /path/to/large-v3-turbo.pt \
  --model /tmp/ggml-large-v3-turbo-q5_0.bin \
  --output /tmp/whisper-linux-arm64.shejane-runtime-asset
```

The Linux/arm64 archive and Worker pass local packaged-VM repeatability, bounded
performance, English/Mandarin, deterministic-noise Japanese auto-detection, accented
long-form English, hostile-input, cancellation, and Media Artifact composition checks.
No archive is a published product capability until the real signed/notarized release
workflow passes. Windows, Linux/amd64, real music, mixed-language and Latin-script
breadth, a real encoded two-hour boundary corpus, excessive segment/text/output cases,
and their native Gates remain separate requirements.
