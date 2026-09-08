#!/usr/bin/env bun
/**
 * Phase 2: mass DELETE barren property shells across all public *_properties tables.
 *
 * A "barren shell" has no owner, situs, legal description, and no positive appraised value.
 * Does not touch neighborhood exported / total_available columns.
 *
 * Usage:
 *   bun scripts/purge-empty-property-shells.js --dry-run
 *   bun scripts/purge-empty-property-shells.js
 */
import pool from "../src/db.js";

const dryRun = process.argv.includes("--dry-run");

const BARREN_WHERE = `
  (owner_name IS NULL OR BTRIM(owner_name) = '')
  AND (situs IS NULL OR BTRIM(situs) = '')
  AND (legal_desc IS NULL OR BTRIM(legal_desc) = '')
  AND (appraised_val_num IS NULL OR appraised_val_num <= 0)
`;

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function listPropertyTables() {
  const { rows } = await pool.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename LIKE '%\\_properties' ESCAPE '\\'
    ORDER BY tablename
  `);
  return rows.map((r) => r.tablename);
}

async function countBarren(table) {
  const q = `SELECT COUNT(*)::bigint AS n FROM ${quoteIdent(table)} WHERE ${BARREN_WHERE}`;
  const { rows } = await pool.query(q);
  return Number(rows[0].n);
}

async function deleteBarren(table) {
  const q = `DELETE FROM ${quoteIdent(table)} WHERE ${BARREN_WHERE}`;
  const result = await pool.query(q);
  return result.rowCount ?? 0;
}

async function main() {
  const mode = dryRun ? "DRY-RUN (COUNT only)" : "LIVE DELETE";
  console.log(`purge-empty-property-shells: ${mode}`);
  console.log("");

  const tables = await listPropertyTables();
  if (tables.length === 0) {
    console.log("No public *_properties tables found.");
    return;
  }

  console.log(`Found ${tables.length} property table(s).`);
  console.log("");

  const results = [];
  let grandTotal = 0;
  const errors = [];

  for (const table of tables) {
    try {
      const n = dryRun ? await countBarren(table) : await deleteBarren(table);
      results.push({ table, count: n });
      grandTotal += n;
      const label = dryRun ? "would delete" : "deleted";
      console.log(`${table}: ${label} ${n}`);
    } catch (err) {
      const msg = err?.message || String(err);
      errors.push({ table, error: msg });
      console.error(`${table}: ERROR — ${msg}`);
    }
  }

  console.log("");
  console.log("--- summary ---");
  console.log(`tables processed: ${results.length}`);
  console.log(`tables with errors: ${errors.length}`);
  console.log(`grand total ${dryRun ? "would delete" : "deleted"}: ${grandTotal}`);

  const top = [...results].sort((a, b) => b.count - a.count).filter((r) => r.count > 0).slice(0, 20);
  if (top.length > 0) {
    console.log("");
    console.log("top by count:");
    for (const { table, count } of top) {
      console.log(`  ${count.toLocaleString().padStart(10)}  ${table}`);
    }
  }

  if (errors.length > 0) {
    console.log("");
    console.log("errors:");
    for (const { table, error } of errors) {
      console.log(`  ${table}: ${error}`);
    }
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await pool.end();
}
