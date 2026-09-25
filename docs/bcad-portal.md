# BCAD Portal (second Railway service in this project)
#
# Shares auth + Postgres with the main prop-tax-scraper service.
# Custom DNS can be attached to the bcad-portal service after deploy.
#
# ## Local
#
# ```bash
# bun install
# bun run portal          # http://localhost:3850
# bun run portal:dev      # watch mode
# ```
#
# Login uses the same `/api/auth/login` users table and `JWT_SECRET`.
# Browser token key is `propTax.jwt` (shared with the scraper UI).
#
# ## Railway service
#
# 1. In project **property-tax-scraper**, add a service (e.g. `bcad-portal`).
# 2. Point it at this repo; set start command:
#    `bun src/portal/server.js`
#    (or use [`railway.portal.toml`](../railway.portal.toml) as the service config).
# 3. Variables (reference the scraper / DB services where possible):
#    - `DATABASE_URL` — main Postgres (users / JWT auth), same as prop-tax-scraper
#    - `BCAD_DATABASE_URL` — `${{PostGIS.DATABASE_URL}}` (PostGIS service; spatial table)
#    - `JWT_SECRET` — same secret as prop-tax-scraper
#    - `PORT` — Railway injects this automatically
#    - Bucket (from Police Calls → **bexar-cad-neighborhoods** Credentials):
#      - `ENDPOINT` (e.g. `https://t3.storageapi.dev`)
#      - `BUCKET` (e.g. `bexar-cad-neighborhoods-fntdll`)
#      - `ACCESS_KEY_ID`
#      - `SECRET_ACCESS_KEY`
#      - `REGION=auto`
# 4. Domain: https://bcad-portal-production.up.railway.app
#    (custom DNS can be attached later)
#
# Stock Railway Postgres does **not** include PostGIS. This project deploys a
# separate **PostGIS** service for `bcad_properties`; auth stays on the original Postgres.
#
# ## Import parcels into `bcad_properties`
#
# Requires PostGIS on the database (`CREATE EXTENSION postgis` — portal boot
# attempts this automatically).
#
# ```bash
# # with bucket + DB env loaded:
# bun scripts/import-bcad-from-bucket.js --limit=2   # smoke test
# bun scripts/import-bcad-from-bucket.js --force     # full reload
# ```
#
# Bucket objects (not classic .shp):
# - `index.json`
# - `neighborhoods/{hood_cd}/parcels.geojson.gz`
# - `neighborhoods/{hood_cd}/parcels.csv`
# - `neighborhoods/{hood_cd}/boundary.geojson`
#
# ## Map
#
# Dashboard left nav → **Bexar Property Map** loads MapLibre + MVT tiles from
# `/api/bcad/tiles/{z}/{x}/{y}.mvt` (auth via `?token=`).
