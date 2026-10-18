#!/bin/sh
# Start as root only to make sure the data volume belongs to the app user (volumes created by older,
# root-run versions are owned by root), then drop privileges for good and run the server as 'node'.
set -e
if [ "$(id -u)" = "0" ]; then
  if [ "$(stat -c %u /data)" != "$(id -u node)" ]; then
    chown -R node:node /data
  fi
  exec su-exec node "$@"
fi
exec "$@"
