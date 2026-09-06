#!/usr/bin/env bun
/**
 * Prepare county tables for a clean re-import:
 *   1) migrate properties → surrogate id PK (null/duplicate pacs_prop_id OK)
 *   2) TRUNCATE all county properties + neighborhoods tables
 *   3) optionally move processed/ → csv/ when DATA_DIR is reachable
 *
 *   railway run -s prop-tax-scraper -- bun scripts/prepare-reimport.mjs
 *   railway run -s prop-tax-scraper -- bun scripts/prepare-reimport.mjs --no-move
 *   DATA_DIR=/data bun scripts/prepare-reimport.mjs   # on the Railway box
 */
import { join } from "path";
import pool from "../src/db.js";
import {
  migrateAllPropertiesTables,
  quoteTable,
} from "../src/county.js";
import { moveProcessedToCsv } from "../src/moveProcessedToCsv.js";

const args = process.argv.slice(2);
const doMove = !args.includes("--no-move");
const dryRun = args.includes("--dry-run");
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");

async function listCountyTables(client) {
  const { rows } = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND (
        table_name = 'properties'
        OR table_name = 'neighborhoods'
        OR table_name LIKE '%\\_properties' ESCAPE '\\'
        OR table_name LIKE '%\\_neighborhoods' ESCAPE '\\'
      )
    ORDER BY table_name
  `);
  return rows.map((r) => r.table_name);
}

async function main() {
  console.log(`[prepare-reimport] migrate + truncate` + (doMove ? " + move" : "") + (dryRun ? " (dry-run)" : ""));

  if (!dryRun) {
    const migrated = await migrateAllPropertiesTables();
    console.log(`[prepare-reimport] migrated ${migrated.length} properties table(s)`);
  }

  const tables = await listCountyTables(pool);
  console.log(`[prepare-reimport] truncating ${tables.length} table(s)`);
  if (!dryRun && tables.length) {
    const list = tables.map((t) => quoteTable(t)).join(", ");
    await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY`);
  }
  for (const t of tables) console.log(`  truncated ${t}`);

  if (doMove) {
    try {
      const summary = await moveProcessedToCsv({ dataRoot: DATA_DIR, dryRun });
      console.log(
        `[prepare-reimport] moved files=${summary.files} across ${summary.counties} counties` +
          (dryRun ? " (dry-run)" : "")
      );
    } catch (err) {
      console.warn(`[prepare-reimport] move skipped: ${err.message}`);
    }
  }

  await pool.end();
  console.log("[prepare-reimport] done");
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
