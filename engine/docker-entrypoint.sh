#!/bin/sh
# Start as root only to make sure the data volume belongs to the app user (volumes created by older,
# root-run versions are owned by root), then drop privileges for good and run the engine as 'aeqe'.
set -e
if [ "$(id -u)" = "0" ]; then
  if [ "$(stat -c %u /data)" != "10001" ]; then
    chown -R 10001:10001 /data
  fi
  exec setpriv --reuid=10001 --regid=10001 --init-groups "$@"
fi
exec "$@"
