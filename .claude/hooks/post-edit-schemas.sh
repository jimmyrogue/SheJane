#!/usr/bin/env bash
# PostToolUse hook — when Claude edits api_schemas.py (the runtime's
# pydantic source-of-truth), automatically regenerate openapi.json +
# generated.ts so subsequent edits see the up-to-date TS types.
#
# This pre-empts the CI drift guard: the schema files are kept in
# sync continuously rather than at commit time, so Claude never
# proposes a change that references stale types.
#
# Performance: regen is ~2s (Python boot + openapi build + npx
# codegen). Only fires when api_schemas.py specifically was touched,
# not on every Python edit.

set -uo pipefail

payload=$(cat || true)
file=$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    p = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
val = (p.get("tool_input") or {}).get("file_path", "")
print(val)
' 2>/dev/null || true)

[[ -z "$file" ]] && exit 0
case "$file" in
  *api_schemas.py) ;;
  *) exit 0 ;;
esac

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

# Regen. Make output is normally quiet; show only on failure so Claude
# sees what went wrong.
if ! make schemas >/tmp/sync-schemas.log 2>&1; then
  echo "→ make schemas FAILED after editing api_schemas.py:" >&2
  cat /tmp/sync-schemas.log >&2
  exit 2
fi

# Tell Claude WHAT changed in the generated artifacts so it knows
# whether to update consumers.
diff_summary=$(git diff --stat -- \
  runtime/sdk/openapi.json \
  runtime/sdk/src/generated.ts 2>/dev/null | tail -5)
if [[ -n "$diff_summary" ]]; then
  echo "→ make schemas regenerated openapi.json + generated.ts:" >&2
  echo "$diff_summary" >&2
fi
