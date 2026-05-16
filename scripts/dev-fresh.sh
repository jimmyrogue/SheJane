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

# Docker preflight FIRST — if the daemon can't be reached we bail out *before*
# killing the user's running dev processes, instead of dumping a raw
# `docker compose` connection error.
ensure_docker() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "[dev-fresh] Docker daemon 未运行。请先启动 Docker 后重试。" >&2
    exit 1
  fi
  echo "[dev-fresh] Docker 未运行，正在启动 Docker Desktop…"
  open -a Docker >/dev/null 2>&1 || open -a "Docker Desktop" >/dev/null 2>&1 || {
    echo "[dev-fresh] 无法自动启动 Docker Desktop。请手动打开 Docker 后重试。" >&2
    exit 1
  }
  for _ in $(seq 1 90); do
    if docker info >/dev/null 2>&1; then
      echo "[dev-fresh] Docker 就绪。"
      return 0
    fi
    sleep 2
  done
  echo "[dev-fresh] 等待 Docker 启动超时（~3 分钟）。请确认 Docker Desktop 已打开后重试。" >&2
  exit 1
}

ensure_docker

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
