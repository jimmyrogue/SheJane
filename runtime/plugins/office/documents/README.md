# Documents plugin

The Documents Managed Worker provides `document.read`, `document.create`, `document.edit`, and `document.render`. It never modifies input files and never discovers host Office installations or tools from `PATH`.

Build the reproducible Linux/arm64 onedir Worker used by the macOS arm64 VM Gate:

```bash
cd runtime
plugins/office/documents/build_worker_linux_arm64.sh /tmp/documents-worker
```

Package one self-contained onedir Worker per platform after the matching Office Runtime
Asset exists:

```bash
cd runtime

uv run python plugins/office/documents/build_package.py \
  --platform linux/arm64 \
  --runtime-asset-digest sha256:<matching-office-runtime-asset-digest> \
  --worker /tmp/documents-worker \
  --output dist/documents-0.1.0-linux-arm64.shejane-plugin
```

CI must run the Worker tests, validate the generated manifest and schemas, verify the exact Runtime Asset reference, execute the platform sandbox conformance suite, and sign/notarize platform executables before publishing. Generated Workers, archives, and Office engines are release output and are not committed.
