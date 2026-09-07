#!/usr/bin/env python3
"""Prepare Cameron County CAD bulk export for portal CSV → Postgres import.

Downloads the official GCC certified spreadsheet from Cameron CAD (True Prodigy
county — no ArcGIS scrape path) and writes a single synthetic hood:

  {DATA_DIR}/tx/cameron/csv/__ALL__.csv
  {DATA_DIR}/tx/cameron/csv/__ALL__.meta.json
  {DATA_DIR}/tx/cameron/neighborhoods.json

Then use the county portal Import CSV button at /c/tx/cameron/.

Usage:
  python3 scripts/prepare_cameron_bulk.py
  python3 scripts/prepare_cameron_bulk.py --xlsx /path/to/export.xlsx
  DATA_DIR=/data python3 scripts/prepare_cameron_bulk.py
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import urllib.request
import zipfile
from pathlib import Path
from xml.etree.ElementTree import iterparse

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
ALL_HOOD = "__ALL__"
EXPORT_URL = (
    "https://gissvr.cameroncad.org/cad/exports/certified/2026/"
    "cameron-2026-GCC-certified-export-20260729.zip"
)

PROPERTY_COLUMNS = [
    "pacs_prop_id",
    "prop_val_yr",
    "geo_id",
    "prop_type_cd",
    "prop_type_desc",
    "dba_name",
    "appraised_val",
    "abs_subdv_cd",
    "mapsco",
    "map_id",
    "agent_cd",
    "hood_cd",
    "hood_name",
    "owner_name",
    "owner_id",
    "addr_line1",
    "addr_line2",
    "addr_line3",
    "addr_city",
    "addr_state",
    "addr_zip",
    "addr_country",
    "pct_ownership",
    "exemptions",
    "state_cd",
    "legal_desc",
    "situs",
    "jurisdictions",
]


def col_to_idx(col: str) -> int:
    n = 0
    for c in col:
        n = n * 26 + (ord(c) - 64)
    return n - 1


def blank(v: object) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    return "" if s.lower() in {"none", "null", "nan"} else s


def join_situs(num: str, prefix: str, street: str, suffix: str, city: str, zip_: str) -> str:
    street_part = " ".join(p for p in (prefix, street, suffix) if p)
    line = " ".join(p for p in (num, street_part) if p).strip()
    if city:
        line = f"{line}, {city}" if line else city
    if zip_:
        line = f"{line} {zip_}" if line else zip_
    return line.strip()


def download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 1_000_000:
        print(f"Using cached download {dest} ({dest.stat().st_size:,} bytes)")
        return dest
    print(f"Downloading {url}")
    urllib.request.urlretrieve(url, dest)
    print(f"Saved {dest} ({dest.stat().st_size:,} bytes)")
    return dest


def extract_xlsx(zip_path: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith(".xlsx")]
        if not names:
            raise SystemExit(f"No .xlsx inside {zip_path}")
        name = names[0]
        target = out_dir / Path(name).name
        if not target.exists():
            print(f"Extracting {name}")
            zf.extract(name, out_dir)
            extracted = out_dir / name
            if extracted != target:
                extracted.replace(target)
        return target


def load_shared_strings(xlsx: Path) -> list[str]:
    ss: list[str] = []
    with zipfile.ZipFile(xlsx) as zf:
        with zf.open("xl/sharedStrings.xml") as fh:
            for _event, elem in iterparse(fh, events=("end",)):
                if elem.tag == f"{NS}si":
                    texts = [t.text or "" for t in elem.iter(f"{NS}t")]
                    ss.append("".join(texts))
                    elem.clear()
    return ss


def iter_sheet_rows(xlsx: Path, shared: list[str]):
    with zipfile.ZipFile(xlsx) as zf:
        with zf.open("xl/worksheets/sheet1.xml") as fh:
            row_vals: dict[int, str] | None = None
            max_col = 0
            for _event, elem in iterparse(fh, events=("end",)):
                if elem.tag == f"{NS}c":
                    ref = elem.get("r", "A1")
                    m = re.match(r"([A-Z]+)", ref)
                    ci = col_to_idx(m.group(1)) if m else 0
                    max_col = max(max_col, ci)
                    t = elem.get("t")
                    v = elem.find(f"{NS}v")
                    val = ""
                    if v is not None and v.text is not None:
                        if t == "s":
                            val = shared[int(v.text)]
                        else:
                            val = v.text
                    if row_vals is None:
                        row_vals = {}
                    row_vals[ci] = val
                    elem.clear()
                elif elem.tag == f"{NS}row":
                    if row_vals is not None:
                        yield [row_vals.get(i, "") for i in range(max_col + 1)]
                    row_vals = None
                    elem.clear()


def map_row(header: list[str], values: list[str]) -> dict[str, str]:
    raw = {header[i]: blank(values[i] if i < len(values) else "") for i in range(len(header))}
    situs = join_situs(
        raw.get("situsNum", ""),
        raw.get("situsPrefix", ""),
        raw.get("situsStreet", ""),
        raw.get("situsSuffix", ""),
        raw.get("situsCity", ""),
        raw.get("situsZip", ""),
    )
    market = raw.get("marketValue", "")
    return {
        "pacs_prop_id": raw.get("pID", ""),
        "prop_val_yr": raw.get("valueYear") or raw.get("pYear", ""),
        "geo_id": raw.get("geoID", ""),
        "prop_type_cd": raw.get("propType", ""),
        "prop_type_desc": raw.get("propType", ""),
        "dba_name": raw.get("dba", ""),
        "appraised_val": market,
        "abs_subdv_cd": raw.get("sub_code", ""),
        "mapsco": "",
        "map_id": "",
        "agent_cd": raw.get("agentID", ""),
        "hood_cd": ALL_HOOD,
        "hood_name": "All parcels",
        "owner_name": raw.get("name", ""),
        "owner_id": "",
        "addr_line1": raw.get("addrLine1", ""),
        "addr_line2": raw.get("addrLine2", ""),
        "addr_line3": raw.get("addrLine3", ""),
        "addr_city": raw.get("addrCity", ""),
        "addr_state": raw.get("addrState", ""),
        "addr_zip": raw.get("addrZip", ""),
        "addr_country": raw.get("country", ""),
        "pct_ownership": raw.get("ownerPct", ""),
        "exemptions": raw.get("exemptions", ""),
        "state_cd": raw.get("stateCd", ""),
        "legal_desc": raw.get("legalDescription", ""),
        "situs": situs,
        "jurisdictions": raw.get("taxingUnits", ""),
    }


def convert(xlsx: Path, csv_dir: Path, data_dir: Path) -> int:
    print("Loading shared strings…")
    shared = load_shared_strings(xlsx)
    print(f"  {len(shared):,} shared strings")

    csv_dir.mkdir(parents=True, exist_ok=True)
    out_csv = csv_dir / f"{ALL_HOOD}.csv"
    out_meta = csv_dir / f"{ALL_HOOD}.meta.json"
    index_path = data_dir / "neighborhoods.json"

    rows_iter = iter_sheet_rows(xlsx, shared)
    header = next(rows_iter)
    header = [blank(h) for h in header]
    required = {"pID", "geoID", "name", "marketValue"}
    missing = required - set(header)
    if missing:
        raise SystemExit(f"Unexpected export columns; missing {sorted(missing)}")

    print(f"Writing {out_csv}")
    count = 0
    with out_csv.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=PROPERTY_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for values in rows_iter:
            writer.writerow(map_row(header, values))
            count += 1
            if count % 25000 == 0:
                print(f"  … {count:,} rows")

    meta = {
        "hood_cd": ALL_HOOD,
        "hood_name": "All parcels",
        "total_available": count,
        "exported": count,
        "over_1000": count > 1000,
        "truncated": False,
        "source": "cameron_gcc_certified_xlsx",
        "export_url": EXPORT_URL,
    }
    out_meta.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    index_path.write_text(
        json.dumps([{"hood_cd": ALL_HOOD, "hood_name": "All parcels"}], indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {count:,} properties → {out_csv}")
    print(f"Meta → {out_meta}")
    print(f"Index → {index_path}")
    return count


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    data_root = Path(os.environ.get("DATA_DIR") or (root / "data"))
    data_dir = data_root / "tx" / "cameron"
    csv_dir = data_dir / "csv"

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--xlsx", type=Path, help="Existing .xlsx (skip download)")
    ap.add_argument(
        "--zip",
        type=Path,
        help="Existing export .zip (skip download)",
    )
    ap.add_argument(
        "--work-dir",
        type=Path,
        default=data_dir / "bulk_work",
        help="Cache dir for downloaded zip/xlsx",
    )
    args = ap.parse_args()

    if args.xlsx:
        xlsx = args.xlsx
    else:
        zip_path = args.zip or (args.work_dir / "cameron-gcc-certified.zip")
        if not args.zip:
            download(EXPORT_URL, zip_path)
        xlsx = extract_xlsx(zip_path, args.work_dir / "extracted")

    convert(xlsx, csv_dir, data_dir)
    print("\nNext: open /c/tx/cameron/ as admin → Import CSV → Postgres")
    return 0


if __name__ == "__main__":
    sys.exit(main())
