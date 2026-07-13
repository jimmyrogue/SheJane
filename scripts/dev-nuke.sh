#!/usr/bin/env bash
# Scorched-earth dev reset — the level above `dev-fresh`.
#
# `dev-fresh` does `docker compose up -d --build`, which rebuilds
# images WITH the layer cache and only recreates containers whose
# config changed. That covers ~90% of "my change didn't take" cases.
# This script exists for the other 10%:
#
#   • A poisoned build-cache layer survives `--build` (the classic
#     "client image is stale even though the Dockerfile builds from
#     source" trap — a `COPY . .` layer cache-hit skips `pnpm
#     build`). `--no-cache` defeats it.
#   • A wedged container that `up -d` won't recreate. `down
#     --remove-orphans` + `--force-recreate` guarantees fresh
#     containers.
#
# What it does NOT do: wipe volumes. Postgres data (uploaded
# documents, conversations, credits) is PRESERVED. If you ever need
# a truly empty DB, run `docker compose down -v` manually first —
# that's destructive and deliberately not wired into this script.
#
# Steps:
#   1. Ensure Docker is up (auto-start Docker Desktop on macOS).
#   2. Kill stale native dev processes (daemon / vite / electron)
#      and free their ports — same prelude as dev-fresh.
#   3. `docker compose down --remove-orphans` — stop + remove all
#      containers (keeps named volumes).
#   4. `docker compose build --no-cache` — rebuild every image from
#      scratch, ignoring the layer cache.
#   5. `docker compose up -d --force-recreate` — recreate all
#      containers from the fresh images.
#   6. Launch the native dev stack (client vite + local-host +
#      electron) via dev-electron.sh with SKIP_DOCKER=1.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Docker preflight FIRST — bail before killing the user's dev
# processes if the daemon is unreachable (mirrors dev-fresh.sh).
ensure_docker() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "[dev-nuke] Docker daemon 未运行。请先启动 Docker 后重试。" >&2
    exit 1
  fi
  echo "[dev-nuke] Docker 未运行，正在启动 Docker Desktop…"
  open -a Docker >/dev/null 2>&1 || open -a "Docker Desktop" >/dev/null 2>&1 || {
    echo "[dev-nuke] 无法自动启动 Docker Desktop。请手动打开 Docker 后重试。" >&2
    exit 1
  }
  for _ in $(seq 1 90); do
    if docker info >/dev/null 2>&1; then
      echo "[dev-nuke] Docker 就绪。"
      return 0
    fi
    sleep 2
  done
  echo "[dev-nuke] 等待 Docker 启动超时（~3 分钟）。请确认 Docker Desktop 已打开后重试。" >&2
  exit 1
}

ensure_docker

echo "[dev-nuke] stopping stale dev processes…"
# SIGKILL (-9): uvicorn traps SIGTERM and can outlive a graceful
# kill; the same applies to the Electron main process. Don't be
# polite — see dev-fresh.sh / daemon-restart skill for the war story.
pkill -9 -f 'python -m local_host' 2>/dev/null || true
pkill -9 -f 'vite' 2>/dev/null || true
# Scope the Electron kill to THIS app's main script so we don't take
# down Docker Desktop (also an Electron app) right before we need it.
pkill -9 -f 'electron/main\.cjs' 2>/dev/null || true

for port in 17371 55173 5174; do
  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "[dev-nuke] freeing port $port (pids: $pids)"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
done

echo "[dev-nuke] docker compose down --remove-orphans (volumes kept)…"
docker compose -f infra/cloud/docker-compose.yml down --remove-orphans

echo "[dev-nuke] docker compose build --no-cache (this takes a while)…"
docker compose -f infra/cloud/docker-compose.yml build --no-cache

echo "[dev-nuke] docker compose up -d --force-recreate…"
docker compose -f infra/cloud/docker-compose.yml up -d --force-recreate

echo "[dev-nuke] launching dev stack (client + local-host + electron)…"
exec env SKIP_DOCKER=1 "$ROOT_DIR/scripts/dev-electron.sh"
