#!/usr/bin/env bun
/**
 * Cross-county property quality audit.
 * Usage: bun scripts/audit-property-quality.js [--json]
 */
import pool from "../src/db.js";

const asJson = process.argv.includes("--json");

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function cat(r) {
  if (r.total < 1) return "empty";
  if (r.with_owner === 0 && r.total >= 500) return "A";
  if (r.with_appraised === 0 && r.with_owner > 0 && r.total >= 500) return "B";
  if (r.emptyish >= 500 || r.emptyish_pct >= 5) return "C";
  if (r.no_value_pct >= 50) return "D";
  return "OK";
}

const { rows: tables } = await pool.query(`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
    AND table_name LIKE '%\\_properties' ESCAPE '\\'
  ORDER BY table_name
`);

const results = [];
for (const { table_name } of tables) {
  const county = table_name
    .replace(/_tx_properties$/, "")
    .replace(/_properties$/, "");
  const q = quoteIdent(table_name);
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (
        WHERE (owner_name IS NULL OR BTRIM(owner_name) = '')
          AND (situs IS NULL OR BTRIM(situs) = '')
          AND (legal_desc IS NULL OR BTRIM(legal_desc) = '')
          AND (appraised_val_num IS NULL OR appraised_val_num <= 0)
      )::bigint AS emptyish,
      COUNT(*) FILTER (WHERE BTRIM(COALESCE(pacs_prop_id::text, '')) IN ('0'))::bigint AS pacs_zero,
      COUNT(*) FILTER (WHERE owner_name IS NOT NULL AND BTRIM(owner_name) <> '')::bigint AS with_owner,
      COUNT(*) FILTER (WHERE appraised_val_num IS NOT NULL AND appraised_val_num > 0)::bigint AS with_appraised,
      COUNT(*) FILTER (WHERE geo_id IS NOT NULL AND BTRIM(geo_id) <> '' AND BTRIM(geo_id) <> '0')::bigint AS with_geo
    FROM ${q}
  `);
  const r = rows[0];
  const total = Number(r.total);
  const emptyish = Number(r.emptyish);
  const with_owner = Number(r.with_owner);
  const with_appraised = Number(r.with_appraised);
  const row = {
    county,
    table: table_name,
    total,
    emptyish,
    emptyish_pct: total ? Math.round((10000 * emptyish) / total) / 100 : 0,
    pacs_zero: Number(r.pacs_zero),
    with_owner,
    with_appraised,
    with_geo: Number(r.with_geo),
    no_owner_pct: total ? Math.round((10000 * (total - with_owner)) / total) / 100 : 0,
    no_value_pct: total ? Math.round((10000 * (total - with_appraised)) / total) / 100 : 0,
  };
  row.cat = cat(row);
  results.push(row);
}

const summary = {
  audited: results.filter((r) => r.total > 0).length,
  empty_tables: results.filter((r) => r.total === 0).length,
  total_rows: results.reduce((s, r) => s + r.total, 0),
  emptyish_rows: results.reduce((s, r) => s + r.emptyish, 0),
  with_appraised: results.reduce((s, r) => s + r.with_appraised, 0),
  A: results.filter((r) => r.cat === "A").length,
  B: results.filter((r) => r.cat === "B").length,
  C: results.filter((r) => r.cat === "C").length,
  D: results.filter((r) => r.cat === "D").length,
  OK: results.filter((r) => r.cat === "OK").length,
};

const priority = [
  "harris",
  "fort_bend",
  "jefferson",
  "wichita",
  "lubbock",
  "montgomery",
  "galveston",
  "grayson",
  "williamson",
  "ector",
  "jackson",
  "limestone",
  "travis",
  "collin",
  "dallas",
  "clay",
  "bexar",
];

if (asJson) {
  console.log(JSON.stringify({ summary, results, priority: results.filter((r) => priority.includes(r.county)) }, null, 2));
} else {
  console.log("=== SUMMARY ===");
  console.table(summary);
  console.log("\n=== PRIORITY COUNTIES ===");
  console.table(
    results
      .filter((r) => priority.includes(r.county))
      .map((r) => ({
        county: r.county,
        cat: r.cat,
        total: r.total,
        owners: r.with_owner,
        appraised: r.with_appraised,
        emptyish: r.emptyish,
        no_owner_pct: r.no_owner_pct,
        no_value_pct: r.no_value_pct,
      }))
  );
  for (const c of ["A", "B", "C", "D"]) {
    const rows = results.filter((r) => r.cat === c).sort((a, b) => b.total - a.total);
    if (!rows.length) continue;
    console.log(`\n=== CLASS ${c} (${rows.length}) ===`);
    console.table(
      rows.slice(0, 25).map((r) => ({
        county: r.county,
        total: r.total,
        owners: r.with_owner,
        appraised: r.with_appraised,
        emptyish: r.emptyish,
        no_value_pct: r.no_value_pct,
      }))
    );
  }
}

await pool.end();
