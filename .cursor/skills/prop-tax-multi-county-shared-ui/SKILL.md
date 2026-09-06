---
name: prop-tax-multi-county-shared-ui
description: >-
  Keeps prop-tax-scraper county portals, browse dataviewer, and ArcGIS scrapers
  shared across all active counties. Use when changing browse UI, page size,
  scrape controls, county portals, cad_sources scrape wiring, or anything that
  might look Bexar-specific — apply once in shared code so every scrape-ready
  county gets the same behavior.
---

# Prop tax multi-county shared UI & scraper

## Hard rule

**Never fork county-specific copies** of the browse dataviewer, county portal, or scrape/import pipeline for Bexar (or any one county).

If you change behavior for Bexar, implement the same change in the **shared** surfaces so every active scrape-ready county inherits it.

## Shared surfaces (edit these)

| Concern | Shared file(s) | How counties differ |
|--------|-----------------|---------------------|
| Browse / dataviewer UI | `public/browse.html` | Path `/c/{state}/{county}/browse` → API `/api/c/...` |
| Browse query API | `src/browse.js` | `propertiesTable` from county context |
| County portal (scrape/import UI) | `public/county.html` | Same path/API pattern |
| Scrape runner | `scrape_neighborhoods.py` + `src/server.js` scrape route | Config from `cad_sources` (map server, layers, fields) |
| Import | `src/importCsv.js` | County table names / dirs from `src/county.js` |
| County catalog | `src/cadSources.js` | Per-county rows; strategy `arcgis_rest` = scrape-ready |

## Do not

- Duplicate `browse.html` / `county.html` per county
- Hardcode Bexar-only limits, columns, or UI in the viewer
- Add scrape logic that only runs when `slug === "bexar"`
- Ship a UX fix on one county portal without the shared page/API update

## Browse page size (required behavior)

- Page-size control is a `<select id="pageSize">` on the shared browse page
- Allowed values: **25, 50, 100, 250, 500, 1000**
- **Maximum records per page: 1000** (enforce in UI clamp **and** `src/browse.js` limit cap)
- Changing page size re-runs search from offset 0

## Checklist for any viewer / scraper UX change

1. Edit the shared file(s) above — not a one-off under a county folder
2. Confirm county routing still uses `/c/:state/:county/...` and `/api/c/:state/:county/...`
3. If touching browse limits: keep server max **1000** and dropdown options in sync
4. If touching scrape: pass options via `cad_sources` / CLI args so all `arcgis_rest` counties work
5. Smoke-test with **two** counties (e.g. Bexar + Calhoun or another `arcgis_rest` county), not Bexar alone

## Active scrape-ready counties

Counties with `cad_sources.scrape_strategy = 'arcgis_rest'` are active for scraping/dataviewer (TX currently has 70+ including Bexar + BIS FeatureServer counties). They all use the same portal + browse pages; only data paths and ArcGIS endpoints differ.
