---
name: prop-tax-railway-connections
description: >-
  Railway connection info for prop-tax-scraper / BCAD portal: project IDs,
  services, public URLs, Postgres vs PostGIS, TCP proxy access from a laptop,
  admin user creation, and VA enrich cron. Use when connecting to production
  DB, creating portal users, running railway ssh/run, or diagnosing
  revmortgagedemo / bcad-portal / PostGIS access.
---

# Prop-tax Railway connections

## Project

| | |
|--|--|
| **Project** | `property-tax-scraper` |
| **Project ID** | `7f7ac689-e19c-4874-9ea0-4f658bec1d8a` |
| **Environment** | `production` (`ee4e3afd-cafc-421c-ba26-9484fb17dbfa`) |
| **GitHub** | `K4TAY/prop-tax-scraper` `@main` |

## Public URLs

| App | URL |
|-----|-----|
| BCAD / VA portal (demo) | https://revmortgagedemo.forteapps.dev |
| Main scraper UI | https://property.forteapps.dev |
| Portal Railway default | https://bcad-portal-production.up.railway.app |

Login is shared JWT auth (`/api/auth/login`, cookie/token key `propTax.jwt`).

## Services

| Service | ID | Role |
|---------|-----|------|
| `bcad-portal` | `8f95661e-1d5f-486b-8f77-32ee3a0b60f5` | Portal web app (`bun src/portal/server.js`) |
| `prop-tax-scraper` | `38f79060-8593-4641-83c4-4f500c504b92` | Neighborhood scrape / CSV UI |
| `va-enrich-cron` | `d0cb3c26-cbbc-4399-b602-a15141b238be` | Cron: enrich 1 VA opp (score≥50) every 10m |
| `Postgres` | `7191a347-ef2e-407f-b085-89eaedd2cdd6` | **Auth** DB (`users`, JWT) |
| `PostGIS` | `607a157a-7a9f-415b-9e75-60378f905afa` | **BCAD** spatial DB (`bcad_*`, VA opps) |

## Two databases (do not mix)

| Env var | Service | Used for |
|---------|---------|----------|
| `DATABASE_URL` | Postgres | Auth users / login (`src/db.js`) |
| `BCAD_DATABASE_URL` | PostGIS | Parcels, tax, clerk, VA (`src/portal/bcadDb.js`) |

Portal needs **both**. Cron `va-enrich-cron` needs at least `BCAD_DATABASE_URL` (references `${{PostGIS.DATABASE_URL}}`).

Internal hostnames (`*.railway.internal`) only work **inside** Railway. From a laptop use the **TCP proxy**.

## Connect from a laptop (TCP proxy)

`railway run` injects internal URLs → `ENOTFOUND` on a Mac. Prefer:

```bash
# Auth Postgres (users)
railway variables -s Postgres --environment production --json
# Use: RAILWAY_TCP_PROXY_DOMAIN + RAILWAY_TCP_PROXY_PORT
#      + POSTGRES_USER + POSTGRES_PASSWORD + POSTGRES_DB
```

Build URL:

```text
postgresql://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{RAILWAY_TCP_PROXY_DOMAIN}:{RAILWAY_TCP_PROXY_PORT}/{POSTGRES_DB}
```

Connect with `ssl: { rejectUnauthorized: false }`.

**Critical:** local `.env` `DATABASE_URL` will override Railway if you `import` `src/db.js` (it calls `dotenv.config()`). For one-off scripts against production, use a **standalone `pg.Pool`** with the TCP-proxy URL — do not load project `.env`.

For PostGIS / BCAD data, same pattern against the **PostGIS** service variables (or `railway ssh -s bcad-portal` and use in-container `BCAD_DATABASE_URL`).

## Railway SSH (runs inside the service)

```bash
railway ssh -s bcad-portal -- echo ok
railway ssh -s bcad-portal -- bun scripts/cron-enrich-va-opportunity.js --min-score=50
railway ssh -s bcad-portal -- bun scripts/build-va-opportunities.js --enrich --tier=hot --limit=50
```

Keep SSH commands short; long `tee` / multi-line pipes often hang. Prefer a small script already deployed in the repo, or TCP proxy from local.

## Admin users (full portal access)

Role `ADMIN` bypasses county grants and can call `requireAdmin` routes (VA rebuild, BCAD import, etc.).

Password hashing: Bun `argon2id` via `src/auth/password.js` (`Bun.password.hash`).

Upsert pattern (production Postgres via TCP proxy, standalone pool):

1. Resolve TCP proxy URL from `Postgres` service vars (see above).
2. `INSERT` / `UPDATE` `users` with `role = 'ADMIN'`.
3. Verify with `Bun.password.verify` and/or:

```bash
curl -sS -X POST https://revmortgagedemo.forteapps.dev/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"EMAIL","password":"PASSWORD"}'
```

Never commit plaintext passwords into the repo or this skill.

## VA enrich cron

- Config: `railway.va-enrich-cron.toml`
- Schedule: `*/10 * * * *` (UTC)
- Command: `bun scripts/cron-enrich-va-opportunity.js --min-score=50`
- Picks one row `score >= 50` ordered by `enriched_at NULLS FIRST`, full refresh + rescore, stamps `enriched_at`, exits.

## Version after Railway deploys

Bump `package.json` `version` on commit/push and tell the user the version string (portal `/api/version`).
