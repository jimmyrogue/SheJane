#!/usr/bin/env bash
set -euo pipefail

output="${1:?usage: build_worker_linux_arm64.sh OUTPUT_DIRECTORY}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$(dirname "$output")"
output="$(cd "$(dirname "$output")" && pwd)/$(basename "$output")"
test ! -e "$output" || { echo "output already exists: $output" >&2; exit 1; }

temporary="$(mktemp -d)"
image="shejane-pdf-worker-builder:local-$$"
cleanup() {
  rm -rf "$temporary"
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --pull --platform linux/arm64 \
  --file "$root/plugins/pdf/worker/Dockerfile.linux-arm64" \
  --tag "$image" \
  "$root/plugins/pdf/worker"

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
        --name pdf-worker \
        --distpath /out \
        --workpath /tmp/pyinstaller-work \
        --specpath /tmp \
        /src/plugins/pdf/worker/pdf_worker.py
    '
}

build_worker "$temporary/first"
build_worker "$temporary/second"
diff -qr "$temporary/first/pdf-worker" "$temporary/second/pdf-worker"
cp -R "$temporary/first/pdf-worker" "$output"
