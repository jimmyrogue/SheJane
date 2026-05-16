#!/usr/bin/env bash
# One-shot clean rebuild + relaunch of the whole dev stack.
#
#   1. Kill stale dev processes (tsx local-host, vite, electron) and free their
#      ports — local-host's `tsx` has no file-watch and the dev script reuses a
#      live port, so a stale process is the #1 "my changes didn't take" trap.
#   2. Rebuild every Docker image (api, admin, postgres) so backend / admin
#      static build changes actually ship.
#   3. Launch the dev stack (client + local-host + electron) via dev-electron.sh
#      with SKIP_DOCKER=1 (compose was just rebuilt here, no need to do it twice).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[dev-fresh] stopping stale dev processes…"
pkill -f 'tsx src/index.ts' 2>/dev/null || true
pkill -f 'vite' 2>/dev/null || true
pkill -f electron 2>/dev/null || true

for port in 17371 55173 5174; do
  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "[dev-fresh] freeing port $port (pids: $pids)"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
done

echo "[dev-fresh] rebuilding Docker images (api, admin, postgres)…"
docker compose up -d --build

echo "[dev-fresh] launching dev stack (client + local-host + electron)…"
exec env SKIP_DOCKER=1 "$ROOT_DIR/scripts/dev-electron.sh"
