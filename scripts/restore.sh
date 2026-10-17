#!/usr/bin/env sh
# Restore a backup made by scripts/backup.sh:   ./scripts/restore.sh backups/20261018-020000
# Stops the backend and engine while the files are replaced.
set -eu
SRC="${1:?usage: restore.sh backups/<timestamp>}"
docker compose stop backend engine
docker compose run --rm --no-deps -v "$(pwd)/$SRC:/restore:ro" --entrypoint sh backend -c "cp /restore/bhu-drishti.sqlite /data/bhu-drishti.sqlite && rm -f /data/bhu-drishti.sqlite-wal /data/bhu-drishti.sqlite-shm"
docker compose run --rm --no-deps -v "$(pwd)/$SRC:/restore:ro" --entrypoint sh engine -c "tar -C /data -xzf /restore/engine-data.tar.gz"
docker compose start engine backend
echo "restored from $SRC"
