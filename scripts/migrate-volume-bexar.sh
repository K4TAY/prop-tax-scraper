#!/usr/bin/env bash
# One-time (or safe-repeatable) migrate legacy volume layout:
#   /data/csv, /data/processed, /data/neighborhoods.json
# → /data/tx/bexar/{csv,processed}/ + neighborhoods.json
set -euo pipefail

DATA_ROOT="${DATA_DIR:-/data}"
DEST="${DATA_ROOT}/tx/bexar"

mkdir -p "${DEST}/csv" "${DEST}/processed"

move_tree() {
  local src="$1"
  local dst="$2"
  if [[ ! -d "$src" ]]; then
    echo "skip missing $src"
    return 0
  fi
  local count
  count="$(find "$src" -maxdepth 1 -type f | wc -l | tr -d ' ')"
  echo "moving ${count} files from $src → $dst"
  # Move files; skip if destination already has same name
  find "$src" -maxdepth 1 -type f -print0 | while IFS= read -r -d '' f; do
    base="$(basename "$f")"
    if [[ -e "${dst}/${base}" ]]; then
      # Prefer keeping dest; remove source duplicate to avoid double import later
      rm -f "$f"
    else
      mv "$f" "${dst}/${base}"
    fi
  done
}

move_tree "${DATA_ROOT}/csv" "${DEST}/csv"
move_tree "${DATA_ROOT}/processed" "${DEST}/processed"

if [[ -f "${DATA_ROOT}/neighborhoods.json" && ! -f "${DEST}/neighborhoods.json" ]]; then
  mv "${DATA_ROOT}/neighborhoods.json" "${DEST}/neighborhoods.json"
  echo "moved neighborhoods.json"
elif [[ -f "${DATA_ROOT}/neighborhoods.json" && -f "${DEST}/neighborhoods.json" ]]; then
  rm -f "${DATA_ROOT}/neighborhoods.json"
  echo "removed duplicate root neighborhoods.json (dest already has one)"
fi

echo "--- result ---"
echo -n "dest csv: "; find "${DEST}/csv" -maxdepth 1 -name '*.csv' | wc -l | tr -d ' '
echo -n "dest processed: "; find "${DEST}/processed" -maxdepth 1 -name '*.csv' | wc -l | tr -d ' '
echo -n "root csv left: "; find "${DATA_ROOT}/csv" -maxdepth 1 -name '*.csv' 2>/dev/null | wc -l | tr -d ' '
echo -n "root processed left: "; find "${DATA_ROOT}/processed" -maxdepth 1 -name '*.csv' 2>/dev/null | wc -l | tr -d ' '
ls -la "${DEST}" | head -20
