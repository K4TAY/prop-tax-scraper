#!/usr/bin/env bash
# Upload local data/csv + data/processed (+ neighborhoods.json) to Railway
# via POST /api/data/restore (volume mounted at DATA_DIR, usually /data).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_DATA="${DATA_DIR:-$ROOT/data}"
BASE_URL="${RAILWAY_APP_URL:-https://prop-tax-scraper-production.up.railway.app}"
TOKEN="${DATA_UPLOAD_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "Set DATA_UPLOAD_TOKEN (same value as on the Railway service)." >&2
  exit 1
fi

if [[ ! -d "$LOCAL_DATA/csv" && ! -d "$LOCAL_DATA/processed" ]]; then
  echo "Nothing to upload under $LOCAL_DATA/{csv,processed}" >&2
  exit 1
fi

TGZ="$(mktemp /tmp/prop-tax-data.XXXXXX.tgz)"
cleanup() { rm -f "$TGZ"; }
trap cleanup EXIT

echo "Packing $LOCAL_DATA ..."
cd "$LOCAL_DATA"
INCLUDE=(csv processed)
if [[ -f neighborhoods.json ]]; then
  INCLUDE+=(neighborhoods.json)
fi
# Avoid macOS AppleDouble ._* files that Linux would count as *.csv
export COPYFILE_DISABLE=1
tar czf "$TGZ" "${INCLUDE[@]}"
ls -lh "$TGZ"
echo "Archive csv entries: $(tar tzf "$TGZ" | grep -E '\.csv$' | grep -v '/\._' | wc -l | tr -d ' ')"

echo "Uploading to ${BASE_URL}/api/data/restore ..."
curl -sS -X POST \
  -H "x-upload-token: ${TOKEN}" \
  -H "Content-Type: application/gzip" \
  --data-binary @"$TGZ" \
  "${BASE_URL}/api/data/restore" | python3 -m json.tool

echo "Done."
