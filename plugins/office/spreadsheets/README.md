# Spreadsheets plugin

The Spreadsheets Managed Worker provides `spreadsheet.read`, `spreadsheet.create`, `spreadsheet.edit`, and `spreadsheet.render`. It never modifies inputs or discovers Office tools from the host `PATH`. Date-times are normalized to UTC because XLSX cells do not retain timezone identity; numeric cells follow Excel's IEEE-754 binary64 model; formulas and cached values remain separate until the pinned LibreOffice engine recalculates them.

Build the reproducible Linux/arm64 onedir Worker used by the macOS arm64 VM Gate:

```bash
plugins/office/spreadsheets/build_worker_linux_arm64.sh /tmp/spreadsheets-worker
```

Package the Worker only after the matching Office Runtime Asset exists:

```bash
cd services/runtime

uv run python ../../plugins/office/spreadsheets/build_package.py \
  --platform linux/arm64 \
  --runtime-asset-digest sha256:<matching-office-runtime-asset-digest> \
  --worker /tmp/spreadsheets-worker \
  --output dist/spreadsheets-0.1.0-linux-arm64.shejane-plugin
```

Publishing requires the same Runtime Asset, sandbox conformance, schema, frozen Worker, real recalculation, render golden, signing, and notarization Gates as Documents. Generated executables, archives, and Office engines are release output and are not committed.
