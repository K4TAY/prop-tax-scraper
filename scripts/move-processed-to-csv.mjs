#!/usr/bin/env bun
/**
 * Move scraped CSV (+ sidecars) from processed/ back to csv/. Does NOT touch the DB.
 *
 *   DATA_DIR=./data bun scripts/move-processed-to-csv.mjs
 *   DATA_DIR=/data bun scripts/move-processed-to-csv.mjs --state=tx --county=willacy
 *   DATA_DIR=/data bun scripts/move-processed-to-csv.mjs --dry-run
 */
import { join } from "path";
import { moveProcessedToCsv } from "../src/moveProcessedToCsv.js";

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const state = args.find((a) => a.startsWith("--state="))?.slice("--state=".length);
const county = args.find((a) => a.startsWith("--county="))?.slice("--county=".length);

const summary = await moveProcessedToCsv({ dataRoot: DATA_DIR, state, county, dryRun });
for (const row of summary.byCounty) {
  console.log(`  ${row.state}/${row.county}: moved ${row.moved} file(s)`);
}
console.log(
  `[move-processed-to-csv] done counties=${summary.counties} files=${summary.files}` +
    (dryRun ? " (dry-run)" : "")
);
