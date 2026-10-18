#!/usr/bin/env bash
# Starts the AEQE engine and the API (which also serves the website) in one container,
# filling in sensible defaults so the image runs with no configuration at all.
set -euo pipefail
cd "$(dirname "$0")"

DATA_DIR="${DATA_DIR:-$HOME/data}"
mkdir -p "$DATA_DIR/engine"

# Login secret: use JWT_SECRET if given, otherwise generate one and keep it in the data folder.
if [ -z "${JWT_SECRET:-}" ]; then
  if [ ! -s "$DATA_DIR/.jwt_secret" ]; then
    python -c "import secrets; print(secrets.token_urlsafe(48))" > "$DATA_DIR/.jwt_secret"
    chmod 600 "$DATA_DIR/.jwt_secret"
  fi
  JWT_SECRET="$(cat "$DATA_DIR/.jwt_secret")"
  echo "start: JWT_SECRET not set, using a generated one (set it as a secret so sign-ins survive a rebuild)"
fi
export JWT_SECRET

# Public address: Hugging Face Spaces tells us its host name; otherwise assume local.
export PORT="${PORT:-7860}"
if [ -z "${PUBLIC_APP_URL:-}" ] && [ -n "${SPACE_HOST:-}" ]; then PUBLIC_APP_URL="https://${SPACE_HOST}"; fi
export PUBLIC_APP_URL="${PUBLIC_APP_URL:-http://localhost:${PORT}}"
export CORS_ORIGIN="${CORS_ORIGIN:-$PUBLIC_APP_URL}"
# a Space page shows the app inside a frame on huggingface.co
if [ -z "${FRAME_ANCESTORS:-}" ] && [ -n "${SPACE_ID:-}" ]; then export FRAME_ANCESTORS="https://huggingface.co"; fi

export NODE_ENV=production HOST=0.0.0.0 STATIC_DIR="$PWD/web"
export ENGINE_URL="http://127.0.0.1:8000"
export SQLITE_PATH="$DATA_DIR/bhu-drishti.sqlite"   # always in the data folder; ignored when DATABASE_URL is set
export TRUST_PROXY="${TRUST_PROXY:-1}"
export AEQE_DATA_DIR="$DATA_DIR/engine" AEQE_PROVIDER="${AEQE_PROVIDER:-auto}"

if [ -n "${DATABASE_URL:-}" ]; then echo "start: accounts and reports in Postgres (DATABASE_URL)"
else echo "start: accounts and reports in SQLite at $SQLITE_PATH (lost if this folder is not persistent)"; fi

# Run both; if either stops, stop the other and exit so the platform restarts the container.
trap 'kill 0' INT TERM
(cd engine && exec python -m uvicorn aeqe.server:app --host 127.0.0.1 --port 8000) &
(cd backend && exec node dist/index.js) &
wait -n
echo "start: a process exited; stopping the container" >&2
kill 0
