#!/usr/bin/env sh
# Back up Bhu-Drishti's data: the user/report database (SQLite, consistent snapshot while running)
# and the engine's saved jobs/areas. Run from the repo root on the server, e.g. daily from cron:
#   0 2 * * *  cd /opt/bhu-drishti && ./scripts/backup.sh >> backups/backup.log 2>&1
# Keeps the newest $KEEP backups (default 14). Copy the backups/ folder off the server as well.
set -eu
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: don't rewrite container paths like /data
KEEP="${KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="backups/$STAMP"
mkdir -p "$OUT"

# 1. SQLite: VACUUM INTO writes a clean, consistent copy even while the backend is serving requests
docker compose exec -T backend rm -f /data/backup.sqlite   # left over from an interrupted run
docker compose exec -T backend node -e "
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync('/data/bhu-drishti.sqlite').exec(\"VACUUM INTO '/data/backup.sqlite'\");"
docker compose cp backend:/data/backup.sqlite "$OUT/bhu-drishti.sqlite"
docker compose exec -T backend rm -f /data/backup.sqlite

# 2. engine data: finished jobs, traces, custom areas (the tile cache is skipped; it rebuilds itself)
docker compose exec -T engine tar -C /data --exclude='cache.sqlite*' -czf - . > "$OUT/engine-data.tar.gz"

# 3. Postgres instead of SQLite (only if DATABASE_URL points at the db service)
if [ -n "${BACKUP_POSTGRES:-}" ]; then
  docker compose exec -T db pg_dump -U bhudrishti bhudrishti | gzip > "$OUT/postgres.sql.gz"
fi

echo "backup written to $OUT"
ls -1d backups/20* 2>/dev/null | sort | head -n "-$KEEP" | xargs -r rm -rf
