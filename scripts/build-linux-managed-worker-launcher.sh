#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s)" == "Linux" ]] || exit 0

case "${SHEJANE_LINUX_ARCH:-$(uname -m)}" in
  aarch64 | arm64) goarch=arm64 ;;
  x86_64 | amd64) goarch=amd64 ;;
  *) echo "unsupported Linux Managed Worker architecture" >&2; exit 1 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${root}/runtime/build/managed-worker-linux/shejane-managed-worker-linux"
mkdir -p "$(dirname "${output}")"
if [[ -n "${SHEJANE_BWRAP_SOURCE:-}" ]]; then
  "${root}/scripts/build-linux-bubblewrap.sh" \
    "${SHEJANE_BWRAP_SOURCE}" "$(dirname "${output}")/bubblewrap"
fi
[[ -x "$(dirname "${output}")/bubblewrap/shejane-bwrap" ]] || {
  echo "verified bubblewrap must be built before the Linux Runtime" >&2
  exit 1
}
CGO_ENABLED=0 GOOS=linux GOARCH="${goarch}" \
  go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' \
  -o "${output}" "${root}/runtime/native/managed-worker-linux/main.go"
"${output}" --help >/dev/null
