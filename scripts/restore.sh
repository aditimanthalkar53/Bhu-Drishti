#!/usr/bin/env sh
# Restore a backup made by scripts/backup.sh:   ./scripts/restore.sh backups/20261018-020000
# Stops the backend and engine while the files are replaced.
set -eu
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: don't rewrite container paths like /data
HERE="$(pwd -W 2>/dev/null || pwd)"
SRC="${1:?usage: restore.sh backups/<timestamp>}"
[ -f "$SRC/bhu-drishti.sqlite" ] && [ -f "$SRC/engine-data.tar.gz" ] || { echo "no backup found in $SRC" >&2; exit 1; }
docker compose stop backend engine
trap 'docker compose start engine backend' EXIT   # bring the app back even if a step fails
docker compose run --rm --no-deps -v "$HERE/$SRC:/restore:ro" --entrypoint sh backend -c "cp /restore/bhu-drishti.sqlite /data/bhu-drishti.sqlite && rm -f /data/bhu-drishti.sqlite-wal /data/bhu-drishti.sqlite-shm && chown -R node:node /data"
docker compose run --rm --no-deps -v "$HERE/$SRC:/restore:ro" --entrypoint sh engine -c "tar -C /data -xzf /restore/engine-data.tar.gz && chown -R 10001:10001 /data"
echo "restored from $SRC"
