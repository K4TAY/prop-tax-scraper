import { existsSync } from "fs";
import { readdir, unlink } from "fs/promises";
import { join } from "path";
import pool from "./db.js";
import { quoteTable } from "./county.js";

/** Scraped import artifacts (CSV + sidecars), not neighborhoods.json. */
function isDownloadArtifact(name) {
  return (
    name.endsWith(".csv") ||
    name.endsWith(".meta.json") ||
    name.endsWith(".OVER_1000") ||
    name.endsWith(".pre-move.bak")
  );
}

/**
 * Recursively delete download artifacts under dir.
 * @returns {Promise<{ deleted: number, paths: string[] }>}
 */
async function deleteArtifactsInDir(dir) {
  const deletedPaths = [];
  if (!existsSync(dir)) return { deleted: 0, paths: deletedPaths };

  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile() && isDownloadArtifact(ent.name)) {
        await unlink(full);
        deletedPaths.push(full);
      }
    }
  }

  await walk(dir);
  return { deleted: deletedPaths.length, paths: deletedPaths };
}

/**
 * TRUNCATE this county's neighborhoods + properties tables (RESTART IDENTITY).
 * @param {import('./county.js').CountyContext} ctx
 */
export async function truncateCountyTables(ctx) {
  const tables = [ctx.neighborhoodsTable, ctx.propertiesTable];
  const existing = [];
  for (const name of tables) {
    const { rows } = await pool.query(
      `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
      `,
      [name]
    );
    if (rows.length) existing.push(name);
  }
  if (!existing.length) {
    return { truncated: [], propertiesBefore: 0, neighborhoodsBefore: 0 };
  }

  let propertiesBefore = 0;
  let neighborhoodsBefore = 0;
  if (existing.includes(ctx.propertiesTable)) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${quoteTable(ctx.propertiesTable)}`
    );
    propertiesBefore = rows[0]?.n ?? 0;
  }
  if (existing.includes(ctx.neighborhoodsTable)) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${quoteTable(ctx.neighborhoodsTable)}`
    );
    neighborhoodsBefore = rows[0]?.n ?? 0;
  }

  const list = existing.map((t) => quoteTable(t)).join(", ");
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY`);

  return {
    truncated: existing,
    propertiesBefore,
    neighborhoodsBefore,
  };
}

/**
 * Delete downloaded CSV + sidecar files from csv/ and processed/ for a county.
 * Leaves neighborhoods.json and other non-artifact files alone.
 * @param {import('./county.js').CountyContext} ctx
 */
export async function deleteCountyCsvFiles(ctx) {
  const csv = await deleteArtifactsInDir(ctx.csvDir);
  const processed = await deleteArtifactsInDir(ctx.processedDir);
  return {
    csvDir: ctx.csvDir,
    processedDir: ctx.processedDir,
    deleted: csv.deleted + processed.deleted,
    csvDeleted: csv.deleted,
    processedDeleted: processed.deleted,
  };
}
