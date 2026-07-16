# Darwin arm64 Vision Runtime Asset spike

This directory builds a source-complete, deterministic `org.llama-mtmd.runtime`
conformance asset. The builder accepts only the exact source, model, projector, license,
and Apple toolchain recorded in `llama-mtmd-b10025.lock.json`.

The dedicated `vision-engine` accepts exactly two paths:

```text
vision-engine request.json response.json
```

It loads only the model files beside the executable, uses CPU with one thread and a fixed
seed, has no generic network/provider path, and returns the strict JSON shape consumed by
the Vision Worker. It does not parse `llama-mtmd-cli` output or start an HTTP server.

Example build:

```bash
uv run --project services/runtime python \
  plugins/vision/runtime-assets/build_darwin.py \
  --llama-source /path/to/llama.cpp-b10025.tar.gz \
  --model /path/to/SmolVLM2-500M-Video-Instruct-Q8_0.gguf \
  --projector /path/to/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf \
  --apache-license /path/to/Apache-2.0.txt \
  --output /tmp/org.llama-mtmd.runtime-darwin-arm64.shejane-runtime-asset
```

The resulting package is reproducible, but its model failed the product quality Gate.
Do not publish it or add it to the production Registry.
