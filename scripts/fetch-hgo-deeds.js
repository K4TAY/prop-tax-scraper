#!/usr/bin/env bun
/**
 * Fetch HGO (Harris Govern) deed history for one BCAD property.
 *
 * Uses pacs_prop_id as HGO propertyId:
 *   https://hgo.harrisgovern.com/bexar/property/{year}-{propertyId}
 *   https://hgo.harrisgovern.com/bexar/api/property/property-details/property-deed-history?propertyId=…
 *
 *   bun scripts/fetch-hgo-deeds.js --geo=04661-000-0350
 *   bun scripts/fetch-hgo-deeds.js --id=1001
 */
import dotenv from "dotenv";
import bcadPool from "../src/portal/bcadDb.js";
import {
  ensureDeedsSchema,
  importDeedsByGeoId,
  importDeedsForProperty,
  listDeedsForProperty,
} from "../src/portal/deeds.js";

dotenv.config();

function parseArgs(argv) {
  const out = { geo: null, id: null, year: null };
  for (const a of argv) {
    if (a.startsWith("--geo=")) out.geo = a.slice(6);
    else if (a.startsWith("--id=")) out.id = Number(a.slice(5));
    else if (a.startsWith("--year=")) out.year = Number(a.slice(7));
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
try {
  await ensureDeedsSchema(bcadPool);
  const yearOpts = opts.year ? { year: opts.year } : {};
  let result;
  if (opts.id) {
    result = await importDeedsForProperty(opts.id, yearOpts);
  } else if (opts.geo) {
    result = await importDeedsByGeoId(opts.geo, yearOpts);
  } else {
    throw new Error("Pass --geo=… or --id=…");
  }
  console.log({
    bcad_property_id: result.bcad_property_id,
    geo_id: result.geo_id,
    hgo_property_id: result.hgo_property_id,
    source_url: result.source_url,
    api_url: result.api_url,
    parsed: result.parsed,
    inserted: result.inserted,
    skipped: result.skipped,
  });
  const rows = await listDeedsForProperty(result.bcad_property_id);
  console.log("deeds_stored", rows.length);
  console.log(rows);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await bcadPool.end();
}
