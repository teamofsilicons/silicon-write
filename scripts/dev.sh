#!/usr/bin/env bash
# Runs the Silicon Write service locally (see scripts/dev-env.sh for what it connects to).
#   scripts/dev.sh            build and run in the foreground
#   scripts/dev.sh --detach   run in the background (log: .dev/write-api.log, pid: .dev/write-api.pid)
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/dev-env.sh
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
DB_NAME="${WRITE_DATABASE_URL##*/}"
if ! "$PG_BIN/psql" -h 127.0.0.1 -p 5471 -U postgres -tAc "select 1 from pg_database where datname = '$DB_NAME'" | grep -q 1; then
  "$PG_BIN/createdb" -h 127.0.0.1 -p 5471 -U postgres "$DB_NAME"
  echo "dev: created database $DB_NAME"
fi
mkdir -p .dev "$WRITE_DATA_DIR"
cargo build -p write-api
if [ -f .dev/write-api.pid ] && kill -0 "$(cat .dev/write-api.pid)" 2>/dev/null; then
  kill "$(cat .dev/write-api.pid)"; sleep 0.5
fi
if [ "${1:-}" = "--detach" ]; then
  nohup ./target/debug/write-api >.dev/write-api.log 2>&1 &
  echo $! >.dev/write-api.pid
  for _ in $(seq 1 50); do curl -sf "$WRITE_API_URL/readyz" >/dev/null && break; sleep 0.2; done
  curl -sf "$WRITE_API_URL/readyz" >/dev/null && echo "dev: write-api ready on $WRITE_API_URL (log .dev/write-api.log)" || { tail -20 .dev/write-api.log; exit 1; }
else
  exec ./target/debug/write-api
fi
