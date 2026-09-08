import { createReadStream } from "fs";
import { mkdir, readdir, readFile, rename, stat } from "fs/promises";
import { basename, dirname, join, relative } from "path";
import { parse } from "csv-parse";
import pool from "./db.js";
import { ensureCadSourcesSchema, seedCadSources } from "./cadSources.js";
import {
  ensureCountyTables,
  migrateLegacyBexarTables,
  migrateAllPropertiesTables,
  quoteTable,
  resolveCounty,
  getCountyDbCounts,
} from "./county.js";

const HOOD_SLASH_TOKEN = "__SLASH__";

function hoodCdFromFileStem(stem) {
  return String(stem).replaceAll(HOOD_SLASH_TOKEN, "/");
}

function hoodFileStem(hoodCd) {
  return String(hoodCd).replaceAll("\\", HOOD_SLASH_TOKEN).replaceAll("/", HOOD_SLASH_TOKEN);
}

const PROPERTY_COLUMNS = [
  "pacs_prop_id",
  "prop_val_yr",
  "geo_id",
  "prop_type_cd",
  "prop_type_desc",
  "dba_name",
  "appraised_val",
  "appraised_val_num",
  "abs_subdv_cd",
  "mapsco",
  "map_id",
  "agent_cd",
  "hood_cd",
  "hood_name",
  "owner_name",
  "owner_id",
  "addr_line1",
  "addr_line2",
  "addr_line3",
  "addr_city",
  "addr_state",
  "addr_zip",
  "addr_country",
  "pct_ownership",
  "exemptions",
  "state_cd",
  "legal_desc",
  "situs",
  "jurisdictions",
];

export async function ensureSchema(client = pool, { migrateAll = true } = {}) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS neighborhoods (
      hood_cd TEXT PRIMARY KEY,
      hood_name TEXT,
      total_available INTEGER,
      exported INTEGER,
      over_1000 BOOLEAN DEFAULT FALSE,
      truncated BOOLEAN DEFAULT FALSE,
      marks JSONB DEFAULT '[]'::jsonb,
      source_csv TEXT,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- One row per scraped feature. pacs_prop_id may be null or duplicated.
    CREATE TABLE IF NOT EXISTS properties (
      id BIGSERIAL PRIMARY KEY,
      pacs_prop_id TEXT,
      prop_val_yr INTEGER NOT NULL DEFAULT 0,
      geo_id TEXT,
      prop_type_cd TEXT,
      prop_type_desc TEXT,
      dba_name TEXT,
      appraised_val TEXT,
      appraised_val_num NUMERIC(14, 2),
      abs_subdv_cd TEXT,
      mapsco TEXT,
      map_id TEXT,
      agent_cd TEXT,
      hood_cd TEXT,
      hood_name TEXT,
      owner_name TEXT,
      owner_id BIGINT,
      addr_line1 TEXT,
      addr_line2 TEXT,
      addr_line3 TEXT,
      addr_city TEXT,
      addr_state TEXT,
      addr_zip TEXT,
      addr_country TEXT,
      pct_ownership NUMERIC(8, 4),
      exemptions TEXT,
      state_cd TEXT,
      legal_desc TEXT,
      situs TEXT,
      jurisdictions TEXT,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS properties_pacs_prop_id_idx ON properties (pacs_prop_id);
    CREATE INDEX IF NOT EXISTS properties_hood_cd_idx ON properties (hood_cd);
    CREATE INDEX IF NOT EXISTS properties_owner_name_idx ON properties (owner_name);
    CREATE INDEX IF NOT EXISTS properties_situs_idx ON properties (situs);
    CREATE INDEX IF NOT EXISTS properties_geo_id_idx ON properties (geo_id);
  `);

  // Only on boot / one-shot scripts. Per-county import must NOT touch every
  // *_properties table — concurrent imports race on ALTER TABLE ADD COLUMN id.
  if (migrateAll) {
    await migrateAllPropertiesTables(client);
  }

  await ensureCadSourcesSchema(client);
  await seedCadSources(client);
  // Activate Bexar county tables and migrate legacy shared tables if present.
  const bexar = resolveCounty("tx", "bexar", "/tmp");
  await ensureCountyTables(bexar, client);
  await migrateLegacyBexarTables(client);
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function blankToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function parseMoney(v) {
  const s = blankToNull(v);
  if (s == null) return null;
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseIntOrNull(v) {
  const s = blankToNull(v);
  if (s == null) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatOrNull(v) {
  const s = blankToNull(v);
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeRow(raw) {
  // Keep every CSV feature row — pacs_prop_id may be null or duplicated.
  return {
    // Keep as text — Dallas/Pandai/etc. use alphanumeric account / parcel ids.
    pacs_prop_id: blankToNull(raw.pacs_prop_id),
    prop_val_yr: parseIntOrNull(raw.prop_val_yr) ?? 0,
    geo_id: blankToNull(raw.geo_id),
    prop_type_cd: blankToNull(raw.prop_type_cd),
    prop_type_desc: blankToNull(raw.prop_type_desc),
    dba_name: blankToNull(raw.dba_name),
    appraised_val: blankToNull(raw.appraised_val),
    appraised_val_num: parseMoney(raw.appraised_val),
    abs_subdv_cd: blankToNull(raw.abs_subdv_cd),
    mapsco: blankToNull(raw.mapsco),
    map_id: blankToNull(raw.map_id),
    agent_cd: blankToNull(raw.agent_cd),
    hood_cd: blankToNull(raw.hood_cd)?.replace(/\s+$/, "") ?? null,
    hood_name: blankToNull(raw.hood_name),
    owner_name: blankToNull(raw.owner_name),
    owner_id: parseIntOrNull(raw.owner_id),
    addr_line1: blankToNull(raw.addr_line1),
    addr_line2: blankToNull(raw.addr_line2),
    addr_line3: blankToNull(raw.addr_line3),
    addr_city: blankToNull(raw.addr_city),
    addr_state: blankToNull(raw.addr_state),
    addr_zip: blankToNull(raw.addr_zip),
    addr_country: blankToNull(raw.addr_country),
    pct_ownership: parseFloatOrNull(raw.pct_ownership),
    exemptions: blankToNull(raw.exemptions),
    state_cd: blankToNull(raw.state_cd),
    legal_desc: blankToNull(raw.legal_desc),
    situs: blankToNull(raw.situs),
    jurisdictions: blankToNull(raw.jurisdictions),
  };
}

async function insertBatch(client, rows, propertiesTable) {
  if (!rows.length) return 0;

  const cols = PROPERTY_COLUMNS;
  const values = [];
  const placeholders = rows.map((row, ri) => {
    const base = ri * cols.length;
    cols.forEach((col) => values.push(row[col]));
    const nums = cols.map((_, ci) => `$${base + ci + 1}`);
    return `(${nums.join(", ")})`;
  });

  await client.query(
    `
    INSERT INTO ${quoteTable(propertiesTable)} (${cols.join(", ")})
    VALUES ${placeholders.join(", ")}
    `,
    values
  );
  return rows.length;
}

async function readCsvRows(csvPath) {
  const rows = [];
  const parser = createReadStream(csvPath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
      trim: true,
    })
  );

  for await (const record of parser) {
    rows.push(normalizeRow(record));
  }
  return rows;
}

async function upsertNeighborhood(
  client,
  { hoodCd, meta, sourceCsv, rowCount, neighborhoodsTable }
) {
  const hoodName = meta?.hood_name || null;
  await client.query(
    `
    INSERT INTO ${quoteTable(neighborhoodsTable)} (
      hood_cd, hood_name, total_available, exported, over_1000, truncated, marks, source_csv, imported_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW())
    ON CONFLICT (hood_cd) DO UPDATE SET
      hood_name = EXCLUDED.hood_name,
      total_available = EXCLUDED.total_available,
      exported = EXCLUDED.exported,
      over_1000 = EXCLUDED.over_1000,
      truncated = EXCLUDED.truncated,
      marks = EXCLUDED.marks,
      source_csv = EXCLUDED.source_csv,
      imported_at = NOW()
    `,
    [
      hoodCd,
      hoodName,
      meta?.total_available ?? rowCount,
      meta?.exported ?? rowCount,
      Boolean(meta?.over_1000),
      Boolean(meta?.truncated),
      JSON.stringify(meta?.marks ?? []),
      sourceCsv,
    ]
  );
}

async function moveHoodFiles(csvDir, processedDir, fileStem) {
  await mkdir(processedDir, { recursive: true });
  const names = [
    `${fileStem}.csv`,
    `${fileStem}.meta.json`,
    `${fileStem}.OVER_1000`,
  ];
  const moved = [];
  for (const name of names) {
    const from = join(csvDir, name);
    try {
      await stat(from);
    } catch {
      continue;
    }
    const to = join(processedDir, name);
    await rename(from, to);
    moved.push(name);
  }
  return moved;
}

/**
 * Hood codes containing "/" were historically written as nested paths
 * (e.g. csv/DF/WW/KER.csv). Flatten them to DF__SLASH__WW__SLASH__KER.csv
 * so import + processed counts stay in sync with neighborhoods.json.
 */
async function flattenNestedHoodFiles(rootDir, log = console) {
  if (!rootDir) return 0;
  let flattened = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (
        !ent.name.endsWith(".csv") &&
        !ent.name.endsWith(".meta.json") &&
        !ent.name.endsWith(".OVER_1000")
      ) {
        continue;
      }
      const rel = relative(rootDir, full);
      if (!rel.includes("/") && !rel.includes("\\")) continue;

      let hoodCd;
      let suffix;
      if (ent.name.endsWith(".meta.json")) {
        hoodCd = rel.slice(0, -".meta.json".length);
        suffix = ".meta.json";
      } else if (ent.name.endsWith(".OVER_1000")) {
        hoodCd = rel.slice(0, -".OVER_1000".length);
        suffix = ".OVER_1000";
      } else {
        hoodCd = rel.slice(0, -".csv".length);
        suffix = ".csv";
      }
      hoodCd = hoodCd.replaceAll("\\", "/");
      const dest = join(rootDir, `${hoodFileStem(hoodCd)}${suffix}`);
      if (dest === full) continue;
      await mkdir(dirname(dest), { recursive: true });
      if (dest !== full) {
        try {
          await stat(dest);
          log.warn?.(`  flatten skip (exists): ${rel} → ${basename(dest)}`, "import");
          continue;
        } catch {
          /* dest free */
        }
        await rename(full, dest);
        flattened += 1;
        log.info?.(`  flattened ${rel} → ${basename(dest)}`, "import");
      }
    }
  }

  await walk(rootDir);
  return flattened;
}

/**
 * Import all CSVs from csvDir into a county's Postgres tables, then move files to processedDir.
 * @param {{
 *   csvDir: string,
 *   processedDir: string,
 *   neighborhoodsTable: string,
 *   propertiesTable: string,
 *   log?: object,
 *   batchSize?: number,
 * }} opts
 */
export async function importCsvDirectory({
  csvDir,
  processedDir,
  neighborhoodsTable,
  propertiesTable,
  log = console,
  batchSize = 250,
} = {}) {
  if (!neighborhoodsTable || !propertiesTable) {
    throw new Error("neighborhoodsTable and propertiesTable are required");
  }
  await ensureSchema(undefined, { migrateAll: false });
  await ensureCountyTables({
    neighborhoodsTable,
    propertiesTable,
  });

  const flatCsv = await flattenNestedHoodFiles(csvDir, log);
  const flatProcessed = await flattenNestedHoodFiles(processedDir, log);
  if (flatCsv || flatProcessed) {
    log.info?.(
      `Flattened nested hood files: csv=${flatCsv} processed=${flatProcessed}`,
      "import"
    );
  }

  let files;
  try {
    files = (await readdir(csvDir))
      .filter((f) => f.endsWith(".csv"))
      .sort();
  } catch (err) {
    throw new Error(`Cannot read CSV directory ${csvDir}: ${err.message}`);
  }

  const summary = {
    files: files.length,
    imported: 0,
    skippedEmpty: 0,
    failed: 0,
    rows: 0,
    moved: 0,
  };

  if (!files.length) {
    log.info?.("No CSV files to import.", "import");
    return summary;
  }

  log.info?.(
    `Importing ${files.length} CSV file(s) into ${propertiesTable}…`,
    "import"
  );

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileStem = basename(file, ".csv");
    const csvPath = join(csvDir, file);
    const metaPath = join(csvDir, `${fileStem}.meta.json`);

    log.info?.(`[${i + 1}/${files.length}] ${file}`, "import");

    const client = await pool.connect();
    try {
      let meta = null;
      try {
        meta = JSON.parse(await readFile(metaPath, "utf8"));
      } catch {
        /* optional */
      }
      const hoodCd =
        blankToNull(meta?.hood_cd) || hoodCdFromFileStem(fileStem);

      const st = await stat(csvPath);
      if (st.size === 0) {
        summary.skippedEmpty += 1;
        log.warn?.(`  empty CSV — recording neighborhood and moving`, "import");
        await client.query("BEGIN");
        await upsertNeighborhood(client, {
          hoodCd,
          meta: meta || { hood_cd: hoodCd, total_available: 0, exported: 0 },
          sourceCsv: file,
          rowCount: 0,
          neighborhoodsTable,
        });
        await client.query("COMMIT");
        const moved = await moveHoodFiles(csvDir, processedDir, fileStem);
        summary.moved += moved.length;
        summary.imported += 1;
        continue;
      }

      const rows = await readCsvRows(csvPath);
      await client.query("BEGIN");
      await upsertNeighborhood(client, {
        hoodCd,
        meta,
        sourceCsv: file,
        rowCount: rows.length,
        neighborhoodsTable,
      });

      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const batch = rows.slice(offset, offset + batchSize);
        await insertBatch(client, batch, propertiesTable);
      }
      await client.query("COMMIT");

      const moved = await moveHoodFiles(csvDir, processedDir, fileStem);
      summary.rows += rows.length;
      summary.moved += moved.length;
      summary.imported += 1;
      log.success?.(
        `  imported ${rows.length} rows → moved ${moved.join(", ") || "(none)"}`,
        "import"
      );
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      summary.failed += 1;
      log.error?.(`  FAILED ${file}: ${err.message}`, "import");
    } finally {
      client.release();
    }
  }

  log.success?.(
    `Import done. files=${summary.files} imported=${summary.imported} empty=${summary.skippedEmpty} failed=${summary.failed} rows=${summary.rows}`,
    "import"
  );
  return summary;
}

/** @deprecated Prefer getCountyDbCounts(ctx) */
export async function getDbCounts(ctx = null) {
  if (ctx?.propertiesTable) {
    return getCountyDbCounts(ctx);
  }
  const bexar = resolveCounty("tx", "bexar", "/tmp");
  return getCountyDbCounts(bexar);
}
