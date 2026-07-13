#!/usr/bin/env bash
# Defense in depth: Runtime must never read provider keys from its process
# environment. BYOK credentials belong in the Runtime credential store;
# provider keys belong in the operating-system credential store.
#
# This check is a guardrail against the pattern coming back. Allowed
# locations:
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
# Tests are allowed (they may need to set/unset for defense-in-depth checks).
key_alt="$(IFS='|'; echo "${FORBIDDEN[*]}")"
read_pattern="(environ\.(get|setdefault)\(|environ\[|getenv\()[\"']($key_alt)[\"']"

hits="$(
  grep -rIn -E "$read_pattern" "$DAEMON_DIR" 2>/dev/null \
    | grep -v -E '(/tests/)' \
    || true
)"

if [[ -z "$hits" ]]; then
  exit 0
fi

cat >&2 <<EOF
❌ Daemon code reads a platform-paid key directly from env.

Provider keys belong in Runtime's credential store. Optional Cloud service
keys belong in the Runtime credential store and must not enter process env.

Offending lines (real reads, not docstrings):
EOF
echo "$hits" >&2
exit 1
