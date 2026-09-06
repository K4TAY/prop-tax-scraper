#!/usr/bin/env bun
/**
 * Restore processed/*.csv (+ sidecar files) back into csv/, truncate county
 * property/neighborhood tables, then re-import every restored CSV.
 *
 * Usage:
 *   DATA_DIR=./data bun scripts/restore-and-reimport.mjs
 *   DATA_DIR=/data bun scripts/restore-and-reimport.mjs --state=tx
 *   DATA_DIR=/data bun scripts/restore-and-reimport.mjs --county=willacy
 *   DATA_DIR=/data bun scripts/restore-and-reimport.mjs --dry-run
 */
import { existsSync } from "fs";
import { mkdir, readdir, rename } from "fs/promises";
import { join } from "path";
import pool from "../src/db.js";
import { ensureSchema, importCsvDirectory } from "../src/importCsv.js";
import {
  ensureCountyTables,
  quoteTable,
  resolveCounty,
  getCountyImportStats,
} from "../src/county.js";

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const stateFilter = (
  args.find((a) => a.startsWith("--state="))?.slice("--state=".length) || ""
)
  .trim()
  .toLowerCase();
const countyFilter = (
  args.find((a) => a.startsWith("--county="))?.slice("--county=".length) || ""
)
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_");

async function listCountyDirs() {
  if (!existsSync(DATA_DIR)) {
    throw new Error(`DATA_DIR does not exist: ${DATA_DIR}`);
  }
  const states = (await readdir(DATA_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((s) => /^[a-z]{2}$/.test(s))
    .filter((s) => !stateFilter || s === stateFilter);

  const out = [];
  for (const state of states) {
    const stateDir = join(DATA_DIR, state);
    const counties = (await readdir(stateDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((c) => !countyFilter || c === countyFilter)
      .sort();
    for (const county of counties) {
      out.push(resolveCounty(state, county, DATA_DIR));
    }
  }
  return out;
}

async function restoreProcessedToCsv(ctx) {
  if (!existsSync(ctx.processedDir)) {
    return { restored: 0, files: [] };
  }
  await mkdir(ctx.csvDir, { recursive: true });
  const names = await readdir(ctx.processedDir);
  const restored = [];
  for (const name of names) {
    if (
      !name.endsWith(".csv") &&
      !name.endsWith(".meta.json") &&
      !name.endsWith(".OVER_1000")
    ) {
      continue;
    }
    const from = join(ctx.processedDir, name);
    const to = join(ctx.csvDir, name);
    if (dryRun) {
      restored.push(name);
      continue;
    }
    if (existsSync(to)) {
      // Prefer the processed copy when both exist (re-scrape left a stub).
      await rename(to, `${to}.pre-restore.bak`);
    }
    await rename(from, to);
    restored.push(name);
  }
  return { restored: restored.length, files: restored };
}

async function purgeCountyTables(ctx) {
  await ensureCountyTables(ctx);
  if (dryRun) return;
  await pool.query(`TRUNCATE TABLE ${quoteTable(ctx.propertiesTable)}`);
  await pool.query(`TRUNCATE TABLE ${quoteTable(ctx.neighborhoodsTable)}`);
}

async function main() {
  console.log(`[restore-reimport] DATA_DIR=${DATA_DIR} dryRun=${dryRun}`);
  if (!dryRun) await ensureSchema();

  const counties = await listCountyDirs();
  console.log(`[restore-reimport] ${counties.length} county dir(s)`);

  const totals = {
    counties: 0,
    restoredFiles: 0,
    importedRows: 0,
    failed: 0,
  };

  for (const ctx of counties) {
    const { restored, files } = await restoreProcessedToCsv(ctx);
    const csvPending = existsSync(ctx.csvDir)
      ? (await readdir(ctx.csvDir)).filter((n) => n.endsWith(".csv")).length
      : 0;

    if (!restored && csvPending === 0) {
      console.log(`  skip ${ctx.state}/${ctx.slug} (no csv)`);
      continue;
    }

    totals.counties += 1;
    totals.restoredFiles += restored;
    console.log(
      `  ${ctx.state}/${ctx.slug}: restore ${restored} file(s), ${csvPending} csv pending${dryRun ? " (dry-run)" : ""}`
    );
    if (dryRun) {
      if (files.length) console.log(`    e.g. ${files.slice(0, 3).join(", ")}`);
      continue;
    }

    await purgeCountyTables(ctx);
    const summary = await importCsvDirectory({
      csvDir: ctx.csvDir,
      processedDir: ctx.processedDir,
      neighborhoodsTable: ctx.neighborhoodsTable,
      propertiesTable: ctx.propertiesTable,
      log: {
        info: (m) => console.log(`    ${m}`),
        warn: (m) => console.warn(`    ${m}`),
        error: (m) => console.error(`    ${m}`),
        success: (m) => console.log(`    ${m}`),
      },
    });
    totals.importedRows += summary.rows || 0;
    totals.failed += summary.failed || 0;

    const stats = await getCountyImportStats(ctx);
    console.log(
      `    stats: ${stats.uniqueParcelCount} unique parcels · ${stats.propertyCount} records · ${stats.neighborhoodCount} neighborhoods`
    );
  }

  console.log(
    `[restore-reimport] done counties=${totals.counties} restoredFiles=${totals.restoredFiles} rows=${totals.importedRows} failed=${totals.failed}`
  );
  await pool.end();
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
