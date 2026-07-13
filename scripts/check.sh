#!/usr/bin/env bash
set -euo pipefail

check_platform_keys() {
  local forbidden=(OPENAI_API_KEY TAVILY_API_KEY ANTHROPIC_API_KEY STRIPE_SECRET_KEY AWS_SECRET_ACCESS_KEY)
  local key_alt read_pattern hits
  key_alt="$(IFS='|'; echo "${forbidden[*]}")"
  read_pattern="(environ\.(get|setdefault)\(|environ\[|getenv\()[\"']($key_alt)[\"']"
  hits="$(
    grep -rIn -E "$read_pattern" services/runtime/local_host 2>/dev/null \
      | grep -v -E '(/tests/)' \
      || true
  )"
  [[ -z "$hits" ]] && return

  echo "❌ Runtime code reads a provider key directly from process env:" >&2
  echo "$hits" >&2
  return 1
}

check_release_tags() {
  local components=(runtime desktop runtime-sdk)
  local component other file expected
  for component in "${components[@]}"; do
    file=".github/workflows/release-${component}.yml"
    expected="tags: [\"${component}-v*\"]"
    grep -Fq "$expected" "$file" || {
      echo "❌ ${file} must contain ${expected}" >&2
      return 1
    }
    for other in "${components[@]}"; do
      if [[ "$other" != "$component" ]] && grep -Fq "tags: [\"${other}-v*\"]" "$file"; then
        echo "❌ ${file} also triggers ${other}" >&2
        return 1
      fi
    done
    if grep -Eq 'tags:[[:space:]]*\["v\*"\]' "$file"; then
      echo "❌ ${file} still accepts the legacy v* tag" >&2
      return 1
    fi
  done
}

case "${1:-all}" in
  all)
    check_platform_keys
    check_release_tags
    ;;
  platform-keys) check_platform_keys ;;
  release-tags) check_release_tags ;;
  *)
    echo "Usage: $0 [all|platform-keys|release-tags]" >&2
    exit 2
    ;;
esac
