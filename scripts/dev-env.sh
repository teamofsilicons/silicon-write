#!/usr/bin/env bash
# Environment for running Silicon Write locally against the local Silicon Accounts test stack
# (public http://localhost:9890, API http://127.0.0.1:9889) and its Postgres on 127.0.0.1:5471.
# Source it: `. scripts/dev-env.sh`. Secrets come from the stack's seeded apps file.
WRITE_TEST_HOME="${WRITE_TEST_HOME:-$HOME/.silicon-write-test}"
APPS_JSON="$WRITE_TEST_HOME/apps.json"
_app_field() {
  python3 -c "import json,sys; a=[x for x in json.load(open('$APPS_JSON'))['apps'] if x['app_id']==sys.argv[1]][0]; print(a[sys.argv[2]])" "$1" "$2"
}
export WRITE_ENVIRONMENT=development
export WRITE_BIND="${WRITE_BIND:-127.0.0.1:4371}"
export WRITE_API_URL="${WRITE_API_URL:-http://127.0.0.1:4371}"
export WRITE_WEB_URL="${WRITE_WEB_URL:-http://localhost:4370}"
export WRITE_DATABASE_URL="${WRITE_DATABASE_URL:-postgres://postgres@127.0.0.1:5471/silicon_write}"
export ACCOUNTS_URL="${ACCOUNTS_URL:-http://127.0.0.1:9889}"
export WRITE_APP_ID=write
export WRITE_APP_SECRET="$(_app_field write secret)"
export WRITE_ACCOUNTS_WEBHOOK_SECRET="$(_app_field write webhook_secret)"
export WRITE_TICKET_SECRET="${WRITE_TICKET_SECRET:-local-development-ticket-secret-0123456789abcdef}"
export WRITE_DATA_DIR="${WRITE_DATA_DIR:-$PWD/.dev/data}"
export WRITE_TING_URL="${WRITE_TING_URL-http://127.0.0.1:4372}"
export WRITE_TING_APP_ID=ting
export TING_STUB_SECRET="$(_app_field ting secret)"
