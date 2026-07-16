#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || {
  echo "macOS is required to build the Managed Worker VM launcher" >&2
  exit 1
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-${ROOT}/apps/desktop/build/native/shejane-managed-worker-vm}"
SOURCE="${ROOT}/apps/desktop/native/managed-worker-vm.swift"
ENTITLEMENTS="${ROOT}/apps/desktop/build/managed-worker-vm.entitlements.plist"
TEMPORARY="${OUTPUT}.tmp"
trap 'rm -f "${TEMPORARY}"' EXIT

mkdir -p "$(dirname "${OUTPUT}")"
xcrun swiftc -O "${SOURCE}" -framework Virtualization -o "${TEMPORARY}"
IDENTITY="${SHEJANE_CODESIGN_IDENTITY:--}"
CODESIGN_ARGS=(--force --sign "${IDENTITY}")
if [[ "${IDENTITY}" != "-" ]]; then
  CODESIGN_ARGS+=(--options runtime --timestamp)
fi
codesign "${CODESIGN_ARGS[@]}" --entitlements "${ENTITLEMENTS}" "${TEMPORARY}"
"${TEMPORARY}" --self-test
codesign -d --entitlements - "${TEMPORARY}" 2>&1 \
  | grep -Fq 'com.apple.security.virtualization'
mv "${TEMPORARY}" "${OUTPUT}"
