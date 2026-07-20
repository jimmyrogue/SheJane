#!/usr/bin/env bash
set -euo pipefail

output="${1:?usage: build_worker_linux_arm64.sh OUTPUT_DIRECTORY}"
root="$(cd "$(dirname "$0")/../../.." && pwd)"
mkdir -p "$(dirname "$output")"
output="$(cd "$(dirname "$output")" && pwd)/$(basename "$output")"
test ! -e "$output" || { echo "output already exists: $output" >&2; exit 1; }

temporary="$(mktemp -d)"
image="shejane-documents-worker-builder:local-$$"
cleanup() {
  rm -rf "$temporary"
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --pull --platform linux/arm64 \
  --file "$root/plugins/office/documents/worker/Dockerfile.linux-arm64" \
  --tag "$image" \
  "$root/plugins/office/documents/worker"

build_worker() {
  local destination="$1"
  mkdir -p "$destination"
  docker run --rm --platform linux/arm64 --network none \
    --user "$(id -u):$(id -g)" \
    --env HOME=/tmp/home \
    --volume "$root:/src:ro" \
    --volume "$destination:/out" \
    "$image" \
    sh -lc '
      mkdir -p "$HOME"
      pyinstaller --clean --noconfirm --onedir \
        --additional-hooks-dir /src/plugins/office/documents/pyinstaller-hooks \
        --name documents-worker \
        --distpath /out \
        --workpath /tmp/pyinstaller-work \
        --specpath /tmp \
        /src/plugins/office/documents/worker/documents_worker.py
    '
}

build_worker "$temporary/first"
build_worker "$temporary/second"
diff -qr "$temporary/first/documents-worker" "$temporary/second/documents-worker"
cp -R "$temporary/first/documents-worker" "$output"
