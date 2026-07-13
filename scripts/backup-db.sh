#!/usr/bin/env bash
# Dump the production Postgres, gzip it OUTSIDE the repo, prune old copies,
# and — when the AWS CLI + S3_BUCKET are available — copy it off-site to S3.
#
# Designed to be cron-safe: it logs to stdout/stderr and exits non-zero only
# when the dump itself fails (a missing off-site target is a warning, not a
# failure, so a degraded environment still keeps local snapshots).
#
#   ./scripts/backup-db.sh
#
# Tunables (env):
#   SHEJANE_BACKUP_DIR   where snapshots are written   (default: $HOME/shejane-backups)
#   SHEJANE_BACKUP_KEEP  how many to retain (local+S3) (default: 14)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Load .env so the off-site copy gets S3_BUCKET + AWS_* (the AWS CLI reads
# credentials from the environment). Values are never printed.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

BACKUP_DIR="${SHEJANE_BACKUP_DIR:-$HOME/shejane-backups}"
KEEP="${SHEJANE_BACKUP_KEEP:-14}"
COMPOSE="${COMPOSE_PROD:-docker compose -f infra/cloud/docker-compose.prod.yml}"

mkdir -p "$BACKUP_DIR"
ts="$(date +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/shejane-$ts.sql.gz"

echo "[backup] dumping postgres → $out"
$COMPOSE exec -T postgres pg_dump --clean --if-exists -U shejane -d shejane | gzip >"$out"
# A truncated/empty dump is worse than no dump — fail loudly so cron alerts.
if [ ! -s "$out" ]; then
  echo "[backup] ERROR: dump is empty, removing $out" >&2
  rm -f "$out"
  exit 1
fi
echo "[backup] wrote $out ($(du -h "$out" | cut -f1))"

# Local retention: keep the newest $KEEP, delete the rest.
ls -1t "$BACKUP_DIR"/shejane-*.sql.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm -f
echo "[backup] local copies retained: $(ls -1 "$BACKUP_DIR"/shejane-*.sql.gz 2>/dev/null | wc -l | tr -d ' ')"

# Off-site copy to S3 (the load-bearing part: a backup on the same host is
# not a backup). Skipped with a warning if the CLI or bucket is unavailable.
if command -v aws >/dev/null 2>&1 && [ -n "${S3_BUCKET:-}" ]; then
  dest="s3://$S3_BUCKET/db-backups/shejane-$ts.sql.gz"
  echo "[backup] uploading off-site → $dest"
  aws s3 cp "$out" "$dest" --only-show-errors
  # Remote retention (GNU head -n -N prints all but the last N = the oldest).
  aws s3 ls "s3://$S3_BUCKET/db-backups/" \
    | awk '{print $4}' | grep -E '^shejane-.*\.sql\.gz$' | sort | head -n "-$KEEP" \
    | while read -r old; do
        [ -n "$old" ] && aws s3 rm "s3://$S3_BUCKET/db-backups/$old" --only-show-errors
      done
  echo "[backup] off-site copy complete"
else
  echo "[backup] WARNING: aws CLI or S3_BUCKET unavailable — backup is LOCAL ONLY (not off-site)." >&2
fi

echo "[backup] ✅ done"
