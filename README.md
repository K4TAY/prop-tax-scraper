# Bexar CAD Neighborhood Property Scraper

Scrapes neighborhoods from [Bexar CAD Map Search](https://bexar.trueautomation.com/mapSearch/?cid=110) and writes:

```text
data/csv/<hood_cd>.csv
data/csv/<hood_cd>.meta.json
data/csv/<hood_cd>.OVER_1000   # only when parcel count > 1000
```

Exports **all** parcels per neighborhood (paginated past the map UI’s 1000-row Export limit). Oversized neighborhoods are still marked with `.OVER_1000`.

## Web UI (Bexar-style console)

```bash
bun install
bun start
```

Opens `http://localhost:3847` with:

- Start / Stop scrape controls
- Live **Console Output** via SSE (same pattern as the bexar jail dashboard)
- Stats: neighborhood count, CSV files, over-1000 markers

## CLI

```bash
python3 scrape_neighborhoods.py --limit 10
python3 scrape_neighborhoods.py --hood 57080 --force
python3 scrape_neighborhoods.py
```

## Browse database

Open **http://localhost:3847/browse.html** (or **Browse database** on the dashboard) to:

- Choose which columns appear in the results
- Filter by field / operator / value (contains, =, ≠, ranges, empty, etc.)
- Sort by clicking column headers and page through matches


Copy `.env.example` → `.env` if needed (defaults to local DB `prop_tax`).

From the UI: **Import CSV → Postgres**, or:

```bash
# triggered via POST /api/import while the server is running
```

This loads each `data/csv/<id>.csv` into tables `neighborhoods` + `properties`, then moves the CSV, `.meta.json`, and `.OVER_1000` marker into `data/processed/`.

`properties.pacs_prop_id` is the primary key — the remote PACS / TrueAutomation property id (same as parcel `PROP_ID`).

Scrapes skip neighborhoods that already have a CSV in `data/csv` **or** `data/processed` (unless `--force` / Force re-download).
