#!/usr/bin/env bash
# Defense in depth: the local-host daemon must NEVER read platform-paid
# provider keys from its environment. The architecture is:
#
#   daemon  ──POST /api/v1/agent/tools/execute──▶  cloud API
#                                                   │
#                                                   ├─ OpenAI key (model registry)
#                                                   ├─ Tavily key (.env)
#                                                   ├─ Anthropic key (model registry)
#                                                   └─ … any future provider
#
# Pre-this-fix `tools/image.py` had `os.environ.get("OPENAI_API_KEY")`
# and called OpenAI directly, which (a) made image generation depend
# on per-user env config, (b) bypassed the credit ledger, (c) leaked
# the platform's OpenAI quota across users. Same was true of
# `tools/web.py` with TAVILY_API_KEY via langchain-tavily.
#
# This check is a guardrail against the pattern coming back. Allowed
# locations:
#   • `_gateway.py` — the proxy itself (doesn't read keys; it forwards
#     to the cloud which holds them).
#   • `tests/` — tests may set/unset these keys via monkeypatch to
#     verify defense in depth.
#   • Comments / docstrings — explanations of WHY the daemon doesn't
#     read these keys.
#
# Exit 1 if a real usage sneaks in. Used as a pre-commit hook AND a
# CI lint stage; fast enough to run on every staged-file batch.

set -uo pipefail

FORBIDDEN=(OPENAI_API_KEY TAVILY_API_KEY ANTHROPIC_API_KEY STRIPE_SECRET_KEY AWS_SECRET_ACCESS_KEY)
DAEMON_DIR="services/runtime/local_host"

# Only flag lines that look like ACTUAL READS of the env var, not
# docstrings/comments mentioning the name. Real-read patterns:
#
#   os.environ.get("OPENAI_API_KEY")     ← Python dict-style
#   os.environ["OPENAI_API_KEY"]
#   getenv("OPENAI_API_KEY")             ← os.getenv shorthand
#   os.environ.setdefault("OPENAI_API_KEY", ...)
#
# Tests are allowed (they may need to set/unset for defense-in-depth
# checks). The proxy module `_gateway.py` is allowed (it forwards to
# cloud — doesn't read keys itself, but adding it now makes future
# refactors safer).
key_alt="$(IFS='|'; echo "${FORBIDDEN[*]}")"
read_pattern="(environ\.(get|setdefault)\(|environ\[|getenv\()[\"']($key_alt)[\"']"

hits="$(
  grep -rIn -E "$read_pattern" "$DAEMON_DIR" 2>/dev/null \
    | grep -v -E '(/tests/|/_gateway\.py:)' \
    || true
)"

if [[ -z "$hits" ]]; then
  exit 0
fi

cat >&2 <<EOF
❌ Daemon code reads a platform-paid key directly from env.

Platform keys belong in the cloud API only. Tools that need them must
proxy through \`local_host/tools/_gateway.py:call_tool_gateway\` (which
posts to \`POST /api/v1/agent/tools/execute\` — the API holds the
keys and bills credits per call).

Offending lines (real reads, not docstrings):
EOF
echo "$hits" >&2
exit 1
