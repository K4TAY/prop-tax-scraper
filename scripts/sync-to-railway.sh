#!/usr/bin/env bash
# Sync local Postgres (prop_tax) → Railway Postgres for the linked project.
# Direction: LOCAL (source) → RAILWAY (destination). Never the reverse.
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

echo "=== Sync direction: LOCAL (source) → RAILWAY (destination) ==="

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

# Refuse if destination looks like localhost
if echo "$PUBLIC_URL" | grep -Eqi 'localhost|127\.0\.0\.1'; then
  echo "Refusing: Railway URL resolved to localhost — wrong direction risk." >&2
  exit 1
fi

echo "Source (local):  $LOCAL_DB"
echo "Target (Railway): $(echo "$PUBLIC_URL" | sed -E 's#://([^:/]+):[^@]+@#://\1:***@#')"

local_psql() {
  if [[ "$LOCAL_DB" == postgres*://* || "$LOCAL_DB" == postgresql*://* ]]; then
    psql "$LOCAL_DB" "$@"
  else
    psql -d "$LOCAL_DB" "$@"
  fi
}

# Only county data + cad_sources (leave Railway auth/users alone)
TABLE_ARGS=()
while IFS= read -r t; do
  [[ -n "$t" ]] && TABLE_ARGS+=(-t "$t")
done < <(local_psql -tAc "
  SELECT tablename FROM pg_tables
  WHERE schemaname='public'
    AND (
      tablename LIKE '%_properties'
      OR tablename LIKE '%_neighborhoods'
      OR tablename IN ('properties','neighborhoods','cad_sources')
    )
  ORDER BY 1;
")
if [[ ${#TABLE_ARGS[@]} -eq 0 ]]; then
  echo "No county/cad tables found on local DB" >&2
  exit 1
fi
echo "Dumping ${#TABLE_ARGS[@]} LOCAL table flags → $DUMP_FILE"
if [[ "$LOCAL_DB" == postgres*://* || "$LOCAL_DB" == postgresql*://* ]]; then
  pg_dump --no-owner --no-acl -Fc -f "$DUMP_FILE" "${TABLE_ARGS[@]}" "$LOCAL_DB"
else
  pg_dump --no-owner --no-acl -Fc -f "$DUMP_FILE" "${TABLE_ARGS[@]}" -d "$LOCAL_DB"
fi

echo "Local (source) counts:"
local_psql -tAc "
SELECT 'cad_sources='||COUNT(*) FROM cad_sources
UNION ALL
SELECT 'county_property_tables='||COUNT(*) FROM information_schema.tables
  WHERE table_schema='public' AND table_name LIKE '%_properties'
UNION ALL
SELECT 'property_rows≈'||COALESCE(SUM(n_live_tup),0)::text FROM pg_stat_user_tables
  WHERE relname LIKE '%_properties' OR relname='properties';
"

echo "Dropping remote county/app data tables (idempotent replace; auth tables kept)…"
psql "$PUBLIC_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND (
        tablename LIKE '%_properties'
        OR tablename LIKE '%_neighborhoods'
        OR tablename IN ('properties', 'neighborhoods', 'cad_sources')
      )
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', r.tablename);
  END LOOP;
END $$;
SQL

echo "Restoring LOCAL dump INTO Railway…"
pg_restore --no-owner --no-acl --dbname="$PUBLIC_URL" "$DUMP_FILE" \
  || {
    # pg_restore exits 1 on some non-fatal warnings (e.g. auth tables already exist)
    echo "pg_restore finished with warnings (exit $?); verifying row counts…"
  }

echo "Railway (destination) counts:"
psql "$PUBLIC_URL" -tAc "
SELECT 'cad_sources='||COUNT(*) FROM cad_sources
UNION ALL
SELECT 'county_property_tables='||COUNT(*) FROM information_schema.tables
  WHERE table_schema='public' AND table_name LIKE '%_properties'
UNION ALL
SELECT 'property_rows≈'||COALESCE(SUM(n_live_tup),0)::text FROM pg_stat_user_tables
  WHERE relname LIKE '%_properties' OR relname='properties';
"

echo "Done. Direction was LOCAL → Railway. Dump at $DUMP_FILE"
