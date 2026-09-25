#!/usr/bin/env bun
/**
 * Import Bexar CAD parcels from Railway bucket into PostGIS bcad_properties.
 *
 * Bucket layout (from sapd-cfs scrape):
 *   index.json
 *   neighborhoods/{hood_cd}/parcels.geojson.gz
 *
 * Usage:
 *   bun scripts/import-bcad-from-bucket.js
 *   bun scripts/import-bcad-from-bucket.js --force
 *   bun scripts/import-bcad-from-bucket.js --limit=5
 *   bun scripts/import-bcad-from-bucket.js --hood=12345
 *
 * Env: DATABASE_URL (or DB_*), ENDPOINT, BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION
 */
import { gunzipSync } from "node:zlib";
import dotenv from "dotenv";
import bcadPool from "../src/portal/bcadDb.js";
import { ensureBcadSchema } from "../src/portal/bcadSchema.js";
import { createBcadBucketStore } from "../src/portal/s3.js";

dotenv.config();

const BATCH = 500;

function parseArgs(argv) {
  const out = { force: false, limit: 0, hood: null };
  for (const a of argv) {
    if (a === "--force") out.force = true;
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice(8)) || 0;
    else if (a.startsWith("--hood=")) out.hood = String(a.slice(7)).trim();
  }
  return out;
}

function blankToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = toNum(v);
  return n == null ? null : Math.trunc(n);
}

function geomJson(geometry) {
  if (!geometry || !geometry.type) return null;
  let g = geometry;
  if (g.type === "Polygon") {
    g = { type: "MultiPolygon", coordinates: [g.coordinates] };
  }
  if (g.type !== "MultiPolygon" && g.type !== "Polygon") return null;
  return JSON.stringify(g);
}

function rowFromFeature(f, hoodFallback) {
  const p = f.properties || {};
  const geom = geomJson(f.geometry);
  if (!geom) return null;
  return {
    pacs_prop_id: blankToNull(p.pacs_prop_id),
    geo_id: blankToNull(p.geo_id),
    owner_id: blankToNull(p.owner_id),
    owner_name: blankToNull(p.owner_name),
    legal_desc: blankToNull(p.legal_desc),
    situs: blankToNull(p.situs),
    dba_name: blankToNull(p.dba_name),
    appraised_val: blankToNull(p.appraised_val),
    appraised_val_num: toNum(p.appraised_val),
    addr_line1: blankToNull(p.addr_line1),
    addr_line2: blankToNull(p.addr_line2),
    addr_line3: blankToNull(p.addr_line3),
    addr_city: blankToNull(p.addr_city),
    addr_state: blankToNull(p.addr_state),
    addr_zip: blankToNull(p.addr_zip),
    addr_country: blankToNull(p.addr_country),
    prop_type_cd: blankToNull(p.prop_type_cd),
    prop_type_desc: blankToNull(p.prop_type_desc),
    state_cd: blankToNull(p.state_cd),
    exemptions: blankToNull(p.exemptions),
    pct_ownership: toNum(p.pct_ownership),
    jurisdictions: blankToNull(p.jurisdictions),
    abs_subdv_cd: blankToNull(p.abs_subdv_cd),
    hood_cd: blankToNull(p.hood_cd) || blankToNull(hoodFallback?.hood_cd),
    hood_name: blankToNull(p.hood_name) || blankToNull(hoodFallback?.hood_name),
    mapsco: blankToNull(p.mapsco),
    map_id: blankToNull(p.map_id),
    agent_cd: blankToNull(p.agent_cd),
    prop_val_yr: toInt(p.prop_val_yr),
    prop_id: blankToNull(p.PROP_ID ?? p.prop_id),
    account_id: blankToNull(p.AccountID ?? p.account_id),
    objectid: toInt(p.OBJECTID ?? p.objectid),
    geom,
  };
}

async function insertBatch(client, rows) {
  if (!rows.length) return 0;
  const cols = [
    "pacs_prop_id",
    "geo_id",
    "owner_id",
    "owner_name",
    "legal_desc",
    "situs",
    "dba_name",
    "appraised_val",
    "appraised_val_num",
    "addr_line1",
    "addr_line2",
    "addr_line3",
    "addr_city",
    "addr_state",
    "addr_zip",
    "addr_country",
    "prop_type_cd",
    "prop_type_desc",
    "state_cd",
    "exemptions",
    "pct_ownership",
    "jurisdictions",
    "abs_subdv_cd",
    "hood_cd",
    "hood_name",
    "mapsco",
    "map_id",
    "agent_cd",
    "prop_val_yr",
    "prop_id",
    "account_id",
    "objectid",
    "geom",
  ];
  const values = [];
  const placeholders = [];
  let i = 1;
  for (const r of rows) {
    const ph = [];
    for (const c of cols) {
      if (c === "geom") {
        ph.push(
          `ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($${i}), 4326)), 3))`
        );
        values.push(r.geom);
        i++;
      } else {
        ph.push(`$${i}`);
        values.push(r[c]);
        i++;
      }
    }
    placeholders.push(`(${ph.join(",")})`);
  }
  const sql = `
    INSERT INTO bcad_properties (${cols.join(",")})
    VALUES ${placeholders.join(",")}
  `;
  await client.query(sql, values);
  return rows.length;
}

async function importHood(client, store, entry, { replaceHood }) {
  const key =
    entry.keys?.parcels_geojson_gz ||
    `neighborhoods/${entry.hood_cd}/parcels.geojson.gz`;
  const gz = await store.readBytes(key);
  const json = gunzipSync(gz).toString("utf8");
  const collection = JSON.parse(json);
  const features = collection.features || [];
  const hoodMeta = {
    hood_cd: entry.hood_cd,
    hood_name: entry.hood_name,
  };

  if (replaceHood && entry.hood_cd) {
    await client.query(`DELETE FROM bcad_properties WHERE hood_cd = $1`, [
      String(entry.hood_cd),
    ]);
  }

  let inserted = 0;
  let skipped = 0;
  let batch = [];
  for (const f of features) {
    const row = rowFromFeature(f, hoodMeta);
    if (!row) {
      skipped++;
      continue;
    }
    batch.push(row);
    if (batch.length >= BATCH) {
      inserted += await insertBatch(client, batch);
      batch = [];
    }
  }
  if (batch.length) inserted += await insertBatch(client, batch);
  return { inserted, skipped, total: features.length };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log("Ensuring PostGIS schema…");
  await ensureBcadSchema(bcadPool);

  const store = createBcadBucketStore();
  console.log(`Reading index.json from s3://${store.bucket}…`);
  const index = JSON.parse(await store.readText("index.json"));
  let neighborhoods = index.neighborhoods || index.hoods || [];
  if (!Array.isArray(neighborhoods) || !neighborhoods.length) {
    // Some indexes are a flat array
    if (Array.isArray(index)) neighborhoods = index;
  }
  if (!neighborhoods.length) {
    throw new Error("index.json has no neighborhoods");
  }

  if (opts.hood) {
    neighborhoods = neighborhoods.filter(
      (n) => String(n.hood_cd).trim() === opts.hood
    );
    if (!neighborhoods.length) {
      throw new Error(`hood_cd=${opts.hood} not found in index`);
    }
  }
  if (opts.limit > 0) {
    neighborhoods = neighborhoods.slice(0, opts.limit);
  }

  if (opts.force && !opts.hood) {
    console.log("TRUNCATE bcad_properties (--force)…");
    await bcadPool.query(`TRUNCATE bcad_properties RESTART IDENTITY`);
  }

  // Default: delete+reload each hood (idempotent re-runs). Full --force already truncated.
  const doReplace = !(opts.force && !opts.hood);

  let ok = 0;
  let failed = 0;
  let parcels = 0;
  const client = await bcadPool.connect();
  try {
    for (let i = 0; i < neighborhoods.length; i++) {
      const entry = neighborhoods[i];
      const label = `${entry.hood_name || ""} (${entry.hood_cd})`.trim();
      process.stdout.write(
        `[${i + 1}/${neighborhoods.length}] ${label} … `
      );
      try {
        const result = await importHood(client, store, entry, {
          replaceHood: doReplace,
        });
        parcels += result.inserted;
        ok++;
        console.log(
          `ok inserted=${result.inserted} skipped=${result.skipped}/${result.total}`
        );
      } catch (e) {
        failed++;
        console.log(`FAIL ${e.message}`);
      }
    }
  } finally {
    client.release();
  }

  const { rows } = await bcadPool.query(
    `SELECT COUNT(*)::bigint AS n FROM bcad_properties`
  );
  console.log(
    `Done. ok=${ok} failed=${failed} inserted_this_run=${parcels} table_total=${rows[0].n}`
  );
  await bcadPool.end();
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  try {
    await bcadPool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
