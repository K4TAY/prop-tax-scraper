---
name: prop-tax-railway-connections
description: >-
  Railway connection info for prop-tax-scraper / BCAD portal after 2026-11-16
  redeploy: project IDs, services, public URLs, Postgres vs PostGIS, TCP proxy
  access from a laptop, admin users, and VA enrich cron. Use when connecting to
  production DB, creating portal users, running railway ssh/run, or diagnosing
  revmortgagedemo / bcad-portal / PostGIS access.
---

# Prop-tax Railway connections

Redeployed **2026-11-16** from local `prop_tax` + `prop_tax_bcad` (schema + data).
Prior hold archive (2026-11-12): `~/Archives/property-tax-scraper-hold-20261112-230633/`.

## Project

| | |
|--|--|
| **Project** | `property-tax-scraper` |
| **Project ID** | `bd32b9b9-ffe9-4828-9a19-f904aa1bea5e` |
| **Environment** | `production` (`fe0ed3b3-85cd-4c87-b695-414e0a90f8da`) |
| **GitHub** | `K4TAY/prop-tax-scraper` `@main` |

## Public URLs

| App | URL |
|-----|-----|
| BCAD / VA portal (demo) | https://revmortgagedemo.forteapps.dev |
| Main scraper UI | https://property.forteapps.dev |
| Portal Railway default | https://bcad-portal-production.up.railway.app |
| Scraper Railway default | https://prop-tax-scraper-production.up.railway.app |

Login is shared JWT auth (`/api/auth/login`, cookie/token key `propTax.jwt`).

## Services

| Service | ID | Role |
|---------|-----|------|
| `bcad-portal` | `0b5c6f8b-25e3-4f17-ab2c-ba2a1c5bb59f` | Portal web app (`bun src/portal/server.js`) |
| `prop-tax-scraper` | `7ead9e11-5bd1-415b-9398-5a20f1d20581` | Neighborhood scrape / CSV UI |
| `va-enrich-cron` | `f6b0139c-df84-495d-b3b1-fdc86090bf28` | Cron: fill DOT amount / appraisal gaps every 5m |
| `Postgres` | `0e2175bb-0d91-4498-a0e1-3338df07dd1d` | **Auth** DB (`users`, JWT) + county `*_tx_*` |
| `PostGIS` | `9f545667-3bb0-4365-8b9d-ed224672188f` | **BCAD** spatial DB (`bcad_*`, VA opps) |

## Two databases (do not mix)

| Env var | Service | Used for |
|---------|---------|----------|
| `DATABASE_URL` | Postgres | Auth users / login (`src/db.js`) + county tables |
| `BCAD_DATABASE_URL` | PostGIS (`DATABASE_PRIVATE_URL`) | Parcels, tax, clerk, VA (`src/portal/bcadDb.js`) |

Portal needs **both**. Cron `va-enrich-cron` needs at least `BCAD_DATABASE_URL`.

Internal hostnames (`*.railway.internal`) only work **inside** Railway. From a laptop use the **TCP proxy**.

## Connect from a laptop (TCP proxy)

```bash
railway variables -s Postgres --environment production --json
# Use: RAILWAY_TCP_PROXY_DOMAIN + RAILWAY_TCP_PROXY_PORT
#      + POSTGRES_USER + POSTGRES_PASSWORD + POSTGRES_DB
```

Build URL:

```text
postgresql://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{RAILWAY_TCP_PROXY_DOMAIN}:{RAILWAY_TCP_PROXY_PORT}/{POSTGRES_DB}
```

Connect with `ssl: { rejectUnauthorized: false }` / `PGSSLMODE=require`.

**Critical:** local `.env` `DATABASE_URL` / `DB_*` will override Railway if you `import` `src/db.js`. For one-off scripts against production, use a **standalone `pg.Pool`** with the TCP-proxy URL — do not load project `.env`.

Same pattern against the **PostGIS** service for BCAD data.

## Railway SSH

```bash
railway ssh -s prop-tax-scraper -- echo ok
railway ssh -s bcad-portal -- bun scripts/cron-enrich-va-opportunity.js --min-score=50
```

## Local (optional)

| Env | Local DB |
|-----|----------|
| `DB_*` (`DB_NAME=prop_tax`) | Homebrew `prop_tax` |
| `BCAD_DATABASE_URL` | Homebrew `prop_tax_bcad` |

`bun start` → :3847 · `bun run portal` → :3850 (`PORTAL_PORT`).

## Admin users

Role `ADMIN` bypasses county grants. Boot upserts `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
Password hashing: Bun `argon2id` via `src/auth/password.js`.

Portal admin UI: `/users.html` (`GET/POST/PATCH /api/auth/users`, set password).
Admins can also claim VA leads into their own pipeline like any user.

## VA lead CRM (portal)

- Pool: `/va.html` → `GET /api/bcad/va-leads/pool`, claim `POST /api/bcad/va-leads/:id/claim`
- My Leads: `/leads.html` → `GET /api/bcad/va-leads/mine` (admin `?all=1`)
- Statuses: new, contacted, qualified, proposal, won, lost
- Notes + status/release on claimed leads; schema `bcad_va_leads` / `bcad_va_lead_notes` on PostGIS


## VA enrich cron

- Schedule: `*/5 * * * *` (UTC)
- Command: `bun scripts/cron-enrich-va-opportunity.js --mode=gaps --min-score=0 --limit=10 --gap-seconds=5 --cooldown-hours=12`
- Prioritizes VA rows with a Deed of Trust but missing filed amount and/or missing appraisal (LTV inputs)
- Full Pull records (`refreshPropertySources`) per row; 12h cooldown so the same id is not re-tried every tick

## Version after Railway deploys

Bump `package.json` `version` on commit/push and tell the user the version string (portal `/api/version`).
