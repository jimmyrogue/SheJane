# Presentations plugin

The Presentations Managed Worker provides `presentation.read`, `presentation.create`, `presentation.edit`, and `presentation.render`. It never modifies inputs or discovers host Office tools. An authorized PPTX may supply its theme, masters, and layouts; otherwise creation uses a deterministic 16:9 deck. Animations, transitions, and audio/video are detected and reported because PDF/PNG previews cannot represent them faithfully.

Build the reproducible Linux/arm64 onedir Worker used by the macOS arm64 VM Gate:

```bash
plugins/office/presentations/build_worker_linux_arm64.sh /tmp/presentations-worker
```

Package the Worker only after the matching Office Runtime Asset exists:

```bash
cd services/runtime

uv run python ../../plugins/office/presentations/build_package.py \
  --platform linux/arm64 \
  --runtime-asset-digest sha256:<matching-office-runtime-asset-digest> \
  --worker /tmp/presentations-worker \
  --output dist/presentations-0.1.0-linux-arm64.shejane-plugin
```

Publishing requires the same Runtime Asset, sandbox conformance, schema, frozen Worker, render golden, signing, and notarization Gates as the other Office plugins. Generated executables, archives, and Office engines are release output and are not committed.
