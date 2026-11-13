---
name: prop-tax-railway-connections
description: >-
  Where prop-tax-scraper / BCAD portal data lives now that the Railway project
  is decommissioned (2026-11-12): local Postgres databases, local run commands,
  and the hold archive with restore steps. Use when connecting to the database,
  creating portal users, running the portal or VA enrich scripts, or asked
  about Railway / revmortgagedemo / property.forteapps.dev.
---

# Prop-tax data and runtime (post-Railway)

The Railway project `property-tax-scraper` (`7f7ac689-e19c-4874-9ea0-4f658bec1d8a`) was
**deleted on 2026-11-12**. DNS for `property.forteapps.dev` and
`revmortgagedemo.forteapps.dev` was removed. Nothing is hosted; everything runs locally.

## Hold archive

- Full backup (dumps, CSV volume, secrets): `~/Archives/property-tax-scraper-hold-20261112-230633/` (this Mac only)
- In-repo manifest + non-secret metadata: `archives/property-tax-scraper-hold-20261112-230633/`

`MANIFEST.txt` has the old service IDs and restore commands.

## Local databases (Homebrew Postgres 18 + PostGIS)

| Env var | Local DB | Contents |
|---------|----------|----------|
| `DB_*` (`DB_NAME=prop_tax`) | `prop_tax` | Auth `users`, county `*_tx_*` tables, `cad_sources` |
| `BCAD_DATABASE_URL` | `prop_tax_bcad` | PostGIS `bcad_*` tables, VA opportunities |

`DATABASE_SSL=false` locally. Do not set `DATABASE_URL` locally or it overrides `DB_*`.

`prop_tax_pre_railway_20261112` is the older local DB that existed before the restore; it is safe to drop once no longer needed.

## Run

```bash
bun start          # scraper UI  http://localhost:3847
bun run portal     # BCAD portal http://localhost:3850 (PORTAL_PORT=3850 in .env)
bun run va:enrich-one -- --min-score=50   # what the old Railway cron ran every 10m
```

CSV data lives in `data/` (`data/tx/<county>/csv|processed`, restored from the old `csv-data` volume).

## Admin users

Role `ADMIN` bypasses county grants. Boot upserts `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`.
Password hashing: Bun `argon2id` via `src/auth/password.js`. Never commit plaintext passwords.
