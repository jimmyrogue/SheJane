#!/usr/bin/env bash
# Export Runtime's OpenAPI schema without starting the server.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${ROOT_DIR}/runtime/sdk/openapi.json"
trap 'rm -f "${TARGET}.tmp"' EXIT

cd "${ROOT_DIR}/runtime"

uv run python - <<'PY' > "${TARGET}.tmp"
import json
import sys
from shejane_runtime.config import reset_settings_for_tests
from shejane_runtime.server import create_app

settings = reset_settings_for_tests()
app = create_app(settings)
schema = app.openapi()
json.dump(schema, sys.stdout, indent=2, sort_keys=True, ensure_ascii=False)
sys.stdout.write("\n")
PY

mv "${TARGET}.tmp" "${TARGET}"
echo "✅ openapi.json → ${TARGET}"
