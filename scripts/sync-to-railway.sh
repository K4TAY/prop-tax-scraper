#!/usr/bin/env bash
# Sync local Postgres (prop_tax) → Railway Postgres for the linked project.
# Prefers DATABASE_PUBLIC_URL; otherwise builds one from DATABASE_URL + TCP proxy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOCAL_DB="${LOCAL_DATABASE_URL:-${LOCAL_DB_NAME:-prop_tax}}"
DUMP_FILE="${DUMP_FILE:-/tmp/prop-tax-scraper-sync.dump}"
PROXY_HOST="${RAILWAY_PG_PROXY_HOST:-}"
PROXY_PORT="${RAILWAY_PG_PROXY_PORT:-}"

if ! command -v railway >/dev/null; then
  echo "railway CLI required" >&2
  exit 1
fi
if ! command -v pg_dump >/dev/null || ! command -v pg_restore >/dev/null; then
  echo "pg_dump and pg_restore required" >&2
  exit 1
fi

echo "Resolving Railway public Postgres URL…"
PUBLIC_URL="$(
  PROXY_HOST="$PROXY_HOST" PROXY_PORT="$PROXY_PORT" python3 - <<'PY'
import json, os, re, subprocess, urllib.parse

raw = subprocess.check_output(
    ["railway", "variables", "--service", "Postgres", "--json"],
    text=True,
)
d = json.loads(raw)
url = d.get("DATABASE_PUBLIC_URL") or ""
if url and "railway.internal" not in url:
    print(url)
    raise SystemExit(0)

internal = d.get("DATABASE_URL") or ""
if not internal:
    raise SystemExit("Postgres service has no DATABASE_URL")

u = urllib.parse.urlparse(internal)
host = os.environ.get("PROXY_HOST") or ""
port = os.environ.get("PROXY_PORT") or ""

# Fall back: discover TCP proxy domain/port from Railway-provided vars if present
if not host:
    host = d.get("RAILWAY_TCP_PROXY_DOMAIN") or ""
if not port:
    port = str(d.get("RAILWAY_TCP_PROXY_PORT") or "")

if not host or not port:
    raise SystemExit(
        "No DATABASE_PUBLIC_URL and no TCP proxy host/port. "
        "Enable public TCP proxy on Postgres, or pass "
        "RAILWAY_PG_PROXY_HOST / RAILWAY_PG_PROXY_PORT."
    )

print(
    urllib.parse.urlunparse(
        (
            u.scheme,
            f"{u.username}:{u.password}@{host}:{port}",
            u.path or "/railway",
            "",
            "",
            "",
        )
    )
)
PY
)"

echo "Target: $(echo "$PUBLIC_URL" | sed -E 's#://([^:/]+):[^@]+@#://\1:***@#')"

echo "Dumping local database → $DUMP_FILE"
if [[ "$LOCAL_DB" == postgres*://* || "$LOCAL_DB" == postgresql*://* ]]; then
  pg_dump --no-owner --no-acl -Fc -f "$DUMP_FILE" "$LOCAL_DB"
else
  pg_dump --no-owner --no-acl -Fc -f "$DUMP_FILE" -d "$LOCAL_DB"
fi

echo "Local counts:"
if [[ "$LOCAL_DB" == postgres*://* || "$LOCAL_DB" == postgresql*://* ]]; then
  psql "$LOCAL_DB" -tAc "SELECT 'neighborhoods='||COUNT(*) FROM neighborhoods UNION ALL SELECT 'properties='||COUNT(*) FROM properties;"
else
  psql -d "$LOCAL_DB" -tAc "SELECT 'neighborhoods='||COUNT(*) FROM neighborhoods UNION ALL SELECT 'properties='||COUNT(*) FROM properties;"
fi

echo "Dropping remote app tables (idempotent replace)…"
psql "$PUBLIC_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP TABLE IF EXISTS properties CASCADE;
DROP TABLE IF EXISTS neighborhoods CASCADE;
SQL

echo "Restoring into Railway…"
pg_restore --no-owner --no-acl --dbname="$PUBLIC_URL" "$DUMP_FILE"

echo "Railway counts:"
psql "$PUBLIC_URL" -tAc "SELECT 'neighborhoods='||COUNT(*) FROM neighborhoods UNION ALL SELECT 'properties='||COUNT(*) FROM properties;"

echo "Done. Dump at $DUMP_FILE"
