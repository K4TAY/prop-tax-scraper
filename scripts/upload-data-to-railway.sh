#!/usr/bin/env bash
# Upload local county data to Railway volume via POST /api/data/restore.
# Default: data/tx/bexar → /data/tx/bexar
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${STATE:-tx}"
COUNTY="${COUNTY:-bexar}"
LOCAL_DATA="${DATA_DIR:-$ROOT/data/${STATE}/${COUNTY}}"
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

echo "Packing $LOCAL_DATA (state=$STATE county=$COUNTY) ..."
cd "$LOCAL_DATA"
INCLUDE=()
[[ -d csv ]] && INCLUDE+=(csv)
[[ -d processed ]] && INCLUDE+=(processed)
[[ -f neighborhoods.json ]] && INCLUDE+=(neighborhoods.json)
if [[ ${#INCLUDE[@]} -eq 0 ]]; then
  echo "Nothing to pack" >&2
  exit 1
fi
# Avoid macOS AppleDouble ._* files that Linux would count as *.csv
export COPYFILE_DISABLE=1
tar czf "$TGZ" "${INCLUDE[@]}"
ls -lh "$TGZ"
echo "Archive csv entries: $(tar tzf "$TGZ" | grep -E '\.csv$' | grep -v '/\._' | wc -l | tr -d ' ')"

echo "Uploading to ${BASE_URL}/api/data/restore?state=${STATE}&county=${COUNTY} ..."
curl -sS -X POST \
  -H "x-upload-token: ${TOKEN}" \
  -H "Content-Type: application/gzip" \
  --data-binary @"$TGZ" \
  "${BASE_URL}/api/data/restore?state=${STATE}&county=${COUNTY}" | python3 -m json.tool

echo "Done."
