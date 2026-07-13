#!/usr/bin/env bash
# Export the Runtime OpenAPI schema → packages/runtime-client/openapi.json.
#
# Doesn't actually run the server — calls `app.openapi()` directly so
# this is fast (~1s) and doesn't require a port to be free.
#
# After this, the TS codegen step turns openapi.json into a typed
# `.d.ts` so the client can import generated types instead of
# hand-maintaining interfaces in client.ts. See `make schemas`.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${ROOT_DIR}/packages/runtime-client/openapi.json"

cd "${ROOT_DIR}/services/runtime"

# Inline Python — keeps the export logic versioned next to the call
# site instead of in a separate module that adds an entry point to
# `pyproject.toml`.
uv run python - <<'PY' > "${TARGET}.tmp"
import json
import sys
from local_host.config import reset_settings_for_tests
from local_host.server import create_app

# Use a throwaway settings instance — we never start the server, just
# build the FastAPI app to call app.openapi(). Real DB / store setup
# is skipped via the test settings.
settings = reset_settings_for_tests()
app = create_app(settings)
schema = app.openapi()
# Sort keys deterministically so diff-against-committed is meaningful
# in CI. Without `sort_keys=True` FastAPI's dict ordering can shift
# between Python minor versions and cause false-positive drift PRs.
json.dump(schema, sys.stdout, indent=2, sort_keys=True, ensure_ascii=False)
sys.stdout.write("\n")
PY

mv "${TARGET}.tmp" "${TARGET}"
echo "✅ openapi.json → ${TARGET}"
