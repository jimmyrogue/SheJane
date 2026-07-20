#!/usr/bin/env bash
# PostToolUse hook — runs after Claude edits / writes a Python file
# inside runtime. Formats + lints so Claude sees its own
# code's lint status BEFORE proposing the next change, instead of
# finding out at commit time via lefthook.
#
# Hook contract: Claude Code pipes a JSON payload on stdin describing
# the tool call. We pull the modified file path and gate on:
#   • .py extension
#   • inside runtime/
#   • not auto-generated (skip __pycache__, .venv, generated.d.ts-ish)
#
# Non-zero exit blocks Claude with the message. We use exit 2 to
# signal "user-visible error" and pipe ruff's report to stderr.
#
# Performance note: ruff is fast (~10ms per file). Don't add slower
# linters here — that breaks the "immediate feedback" property.

set -uo pipefail

# Read stdin JSON payload from Claude Code.
payload=$(cat || true)

# Extract the file path the tool acted on. We accept both Edit and
# Write tool shapes (tool_input.file_path).
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
[[ "$file" == *.py ]] || exit 0

# Resolve to repo root + filter by location.
ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
case "$file" in
  *"$ROOT_DIR/runtime/src/"*|*"$ROOT_DIR/runtime/tests/"*|"runtime/src/"*|"runtime/tests/"*) ;;
  *) exit 0 ;;  # not runtime code
esac
case "$file" in
  *"__pycache__"*|*".venv/"*) exit 0 ;;
esac

# Run ruff format + check ON THIS FILE ONLY (not the whole repo —
# that's what `make lint` is for at commit time).
cd "$ROOT_DIR/runtime"
relpath="${file#"$ROOT_DIR/runtime/"}"
relpath="${relpath#runtime/}"
[[ -f "$relpath" ]] || exit 0  # file was deleted, nothing to check

# Format silently (writes if dirty — that's intentional, Claude
# sees the cleaned result on next read).
uv run ruff format "$relpath" >/dev/null 2>&1 || true

# Then lint. Surface errors so Claude sees them.
if ! uv run ruff check "$relpath" 2>&1; then
  echo "" >&2
  echo "→ ruff found issues in $relpath (above). Fix before continuing." >&2
  exit 2
fi
