#!/usr/bin/env bun
/**
 * Regenerates docs/county-scrape-sources.md from CAD_SOURCES_SEED.
 * Usage: bun docs/generate-county-scrape-sources.js
 */
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { CAD_SOURCES_SEED } from "../src/cadSources.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "county-scrape-sources.md");
const version = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version;
const today = new Date().toISOString().slice(0, 10);

function classify(r) {
  const url = r.arcgis_mapserver_url || "";
  const strat = r.scrape_strategy;
  if (strat === "arcgis_rest") {
    if (url.includes("gisdata.pandai.com")) {
      return {
        type: "Pandai MapServer",
        family: "Pritchard & Abbott / Pandai",
        scrape_ready: true,
      };
    }
    if (url.includes("maps.bcad.org") || r.county_name === "Bexar") {
      return {
        type: "TrueAutomation MapServer (Bexar-style)",
        family: "Harris Govern PACS / TrueAutomation",
        scrape_ready: true,
      };
    }
    if (url.includes("maps.dcad.org")) {
      return {
        type: "DCAD ParcelQuery MapServer",
        family: "Dallas CAD (custom schema)",
        scrape_ready: true,
      };
    }
    if (url.includes("hctx.net")) {
      return {
        type: "HCAD Parcels MapServer",
        family: "Harris County Appraisal District",
        scrape_ready: true,
      };
    }
    if (url.includes("cama.io")) {
      return {
        type: "CAMA.io MapServer",
        family: "CAMA.io",
        scrape_ready: true,
      };
    }
    if (
      url.includes("lubbockcad.org") ||
      url.includes("wcad.org") ||
      url.includes("cityofconroe.org")
    ) {
      return {
        type: "County-hosted MapServer",
        family: "County CAD GIS (custom fields)",
        scrape_ready: true,
      };
    }
    if (url.includes("Hidalgo_County_ESD") || r.county_name === "Hidalgo") {
      return {
        type: "RGV911 ESD FeatureServer (mirror)",
        family: "Third-party parcel mirror (True Prodigy portal exists)",
        scrape_ready: true,
      };
    }
    if (url.includes("arcgis.com") && /BIS_Search|CADWebService|WebService|Parcel_/i.test(url)) {
      return {
        type: "BIS public FeatureServer (AGOL)",
        family: "BIS Consultants / TrueAutomation stack",
        scrape_ready: true,
      };
    }
    if (url.includes("arcgis.com")) {
      return {
        type: "Public ArcGIS Online FeatureServer",
        family: "AGOL-hosted CAD parcels",
        scrape_ready: true,
      };
    }
    if (/trueautomation|bisclient|mapSearch/i.test(url)) {
      return {
        type: "TrueAutomation / BIS ArcGIS",
        family: "Harris Govern / BIS",
        scrape_ready: true,
      };
    }
    if (url) {
      return {
        type: "ArcGIS REST (other host)",
        family: r.software_vendor || "Unknown",
        scrape_ready: true,
      };
    }
    return { type: "arcgis_rest (missing URL)", family: "?", scrape_ready: false };
  }
  if (strat === "propaccess") {
    return {
      type: "TrueAutomation PropAccess only",
      family: "Harris Govern PACS (portal; ArcGIS URL not wired)",
      scrape_ready: false,
    };
  }
  if (strat === "true_prodigy") {
    return {
      type: "True Prodigy portal",
      family: "True Prodigy",
      scrape_ready: false,
    };
  }
  if (strat === "investigate") {
    return {
      type: "Catalog / investigate",
      family: r.software_vendor || "Unknown",
      scrape_ready: false,
    };
  }
  return { type: strat, family: r.software_vendor || "?", scrape_ready: false };
}

function escCell(s) {
  return String(s ?? "").replace(/\|/g, "\\|");
}

function shortUrl(s, max = 90) {
  const t = String(s || "—");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const rows = CAD_SOURCES_SEED.filter((r) => r.state_code === "TX")
  .map((r) => {
    const c = classify(r);
    return {
      county: r.county_name,
      strategy: r.scrape_strategy,
      type: c.type,
      family: c.family,
      scrape_ready: c.scrape_ready,
      vendor: r.software_vendor,
      product: r.software_product,
      host: r.property_search_host || "",
      arcgis: r.arcgis_mapserver_url || "",
      prop_field: r.property_id_field || "",
      hood_field: r.hood_filter_field || "",
      layer: r.properties_layer_id ?? "",
      notes: (r.notes || "").replace(/\s+/g, " ").trim(),
    };
  })
  .sort((a, b) => a.county.localeCompare(b.county));

const byType = new Map();
for (const r of rows) {
  if (!byType.has(r.type)) byType.set(r.type, []);
  byType.get(r.type).push(r);
}

let md = `# Texas county scrape sources

Reference for which server / stack each TX county uses when scraping (or is cataloged for).

Generated from \`src/cadSources.js\` (\`CAD_SOURCES_SEED\`). **Scrape-ready** means \`scrape_strategy = arcgis_rest\` and an ArcGIS URL is configured. Other strategies are catalog-only until a scrape path is wired.

_Last updated: ${today} (v${version})._

## Summary by source type

| Source type | Count | Scrape-ready? |
|-------------|------:|:-------------:|
`;

for (const [type, list] of [...byType.entries()].sort(
  (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])
)) {
  const ready = list.every((x) => x.scrape_ready)
    ? "yes"
    : list.some((x) => x.scrape_ready)
      ? "mixed"
      : "no";
  md += `| ${escCell(type)} | ${list.length} | ${ready} |\n`;
}

md += `
**Total TX counties in catalog:** ${rows.length}  
**Scrape-ready (\`arcgis_rest\`):** ${rows.filter((r) => r.scrape_ready).length}  
**Portal / investigate only:** ${rows.filter((r) => !r.scrape_ready).length}

## What the types mean

| Type | What it is |
|------|------------|
| TrueAutomation MapServer (Bexar-style) | Classic PACS ArcGIS MapServer (reference: Bexar \`PAMapSearch\`). |
| BIS public FeatureServer (AGOL) | BIS Consultants GIS apps exposing \`*CADWebService\` / similar FeatureServers on ArcGIS Online. |
| Pandai MapServer | Pritchard & Abbott public \`*CADPublic\` MapServers on \`gisdata.pandai.com\` (joined TaxParcels + Accounts; often no pagination). |
| DCAD ParcelQuery MapServer | Dallas CAD custom ParcelPublishing layer (\`maps.dcad.org\`). |
| HCAD Parcels MapServer | Harris County official GIS parcels MapServer. |
| CAMA.io MapServer | CAMA.io-hosted basemap / parcel fabric. |
| County-hosted MapServer | CAD-operated ArcGIS (Lubbock, Williamson, Montgomery/Conroe, etc.). |
| Public ArcGIS Online FeatureServer | AGOL FeatureServer that is not the classic BIS WebService naming. |
| RGV911 ESD FeatureServer (mirror) | Hidalgo scrape uses a third-party ESD parcel mirror (official portal is True Prodigy). |
| ArcGIS REST (other host) | Other ArcGIS REST endpoints not in the buckets above. |
| TrueAutomation PropAccess only | Public ClientDB/mapSearch known; ArcGIS scrape URL not wired yet. |
| True Prodigy portal | Web portal only; no ArcGIS scrape path yet (Cameron has a bulk CSV import path). |
| Catalog / investigate | Placeholder / needs discovery. |

## Counties by source type
`;

for (const [type, list] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  md += `\n### ${escCell(type)} (${list.length})\n\n`;
  md += `| County | Host / ArcGIS | Prop ID field | Hood field | Layer |\n`;
  md += `|--------|---------------|---------------|------------|------:|\n`;
  for (const r of list.sort((a, b) => a.county.localeCompare(b.county))) {
    const endpoint = r.arcgis || r.host || "—";
    md += `| ${escCell(r.county)} | \`${escCell(shortUrl(endpoint))}\` | \`${escCell(r.prop_field || "—")}\` | \`${escCell(r.hood_field || "—")}\` | ${r.layer === "" || r.layer == null ? "—" : r.layer} |\n`;
  }
}

md += `
## Full alphabetical table

| County | Source type | Strategy | Vendor / product | Scrape-ready |
|--------|-------------|----------|------------------|--------------|
`;

for (const r of rows) {
  md += `| ${escCell(r.county)} | ${escCell(r.type)} | \`${escCell(r.strategy)}\` | ${escCell(r.vendor)} / ${escCell(r.product)} | ${r.scrape_ready ? "yes" : "no"} |\n`;
}

md += `
## How to refresh this doc

\`\`\`bash
bun docs/generate-county-scrape-sources.js
\`\`\`

Source of truth remains \`src/cadSources.js\`; this markdown is a readable dump for humans.
`;

mkdirSync(__dirname, { recursive: true });
writeFileSync(OUT, md);
console.log(`Wrote ${OUT} (${rows.length} counties, ${byType.size} source types)`);
