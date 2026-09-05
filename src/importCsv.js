import { createReadStream } from "fs";
import { mkdir, readdir, readFile, rename, stat } from "fs/promises";
import { basename, join } from "path";
import { parse } from "csv-parse";
import pool from "./db.js";

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

export async function ensureSchema(client = pool) {
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

    -- pacs_prop_id is the remote PACS / TrueAutomation property unique id
    -- (same value as PROP_ID on the parcel layer; used in property detail URLs).
    CREATE TABLE IF NOT EXISTS properties (
      pacs_prop_id BIGINT PRIMARY KEY,
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

    CREATE INDEX IF NOT EXISTS properties_hood_cd_idx ON properties (hood_cd);
    CREATE INDEX IF NOT EXISTS properties_owner_name_idx ON properties (owner_name);
    CREATE INDEX IF NOT EXISTS properties_situs_idx ON properties (situs);
    CREATE INDEX IF NOT EXISTS properties_geo_id_idx ON properties (geo_id);
  `);

  // Migrate older installs that used a composite PK (pacs_prop_id, prop_val_yr)
  await migratePropertiesPrimaryKey(client);
}

async function migratePropertiesPrimaryKey(client) {
  const { rows } = await client.query(`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE t.relname = 'properties'
      AND n.nspname = 'public'
      AND c.contype = 'p'
  `);
  if (!rows.length) {
    await client.query(`
      ALTER TABLE properties ADD CONSTRAINT properties_pkey PRIMARY KEY (pacs_prop_id)
    `);
    return;
  }

  const pk = rows[0];
  const def = String(pk.def || "");
  // Already correct: PRIMARY KEY (pacs_prop_id)
  if (/PRIMARY KEY \(pacs_prop_id\)\s*$/i.test(def)) return;

  // Deduplicate if needed before switching to single-column PK
  await client.query(`
    DELETE FROM properties a
    USING properties b
    WHERE a.pacs_prop_id = b.pacs_prop_id
      AND a.ctid < b.ctid
  `);

  await client.query(`ALTER TABLE properties DROP CONSTRAINT ${quoteIdent(pk.conname)}`);
  await client.query(`
    ALTER TABLE properties ADD CONSTRAINT properties_pkey PRIMARY KEY (pacs_prop_id)
  `);
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
  const pacs = parseIntOrNull(raw.pacs_prop_id);
  if (pacs == null) return null;

  return {
    pacs_prop_id: pacs,
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

async function insertBatch(client, rows) {
  if (!rows.length) return 0;

  const cols = PROPERTY_COLUMNS;
  const values = [];
  const placeholders = rows.map((row, ri) => {
    const base = ri * cols.length;
    cols.forEach((col) => values.push(row[col]));
    const nums = cols.map((_, ci) => `$${base + ci + 1}`);
    return `(${nums.join(", ")})`;
  });

  const updates = cols
    .filter((c) => c !== "pacs_prop_id")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat(["imported_at = NOW()"]);

  await client.query(
    `
    INSERT INTO properties (${cols.join(", ")})
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (pacs_prop_id) DO UPDATE SET
      ${updates.join(", ")}
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
    const row = normalizeRow(record);
    if (row) rows.push(row);
  }
  return rows;
}

async function upsertNeighborhood(client, { hoodCd, meta, sourceCsv, rowCount }) {
  const hoodName =
    meta?.hood_name ||
    null;
  await client.query(
    `
    INSERT INTO neighborhoods (
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

async function moveHoodFiles(csvDir, processedDir, hoodCd) {
  await mkdir(processedDir, { recursive: true });
  const names = [
    `${hoodCd}.csv`,
    `${hoodCd}.meta.json`,
    `${hoodCd}.OVER_1000`,
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
 * Import all CSVs from csvDir into Postgres, then move csv/json/marker files to processedDir.
 */
export async function importCsvDirectory({
  csvDir,
  processedDir,
  log = console,
  batchSize = 250,
} = {}) {
  await ensureSchema();

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

  log.info?.(`Importing ${files.length} CSV file(s) into PostgreSQL…`, "import");

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const hoodCd = basename(file, ".csv");
    const csvPath = join(csvDir, file);
    const metaPath = join(csvDir, `${hoodCd}.meta.json`);

    log.info?.(`[${i + 1}/${files.length}] ${file}`, "import");

    const client = await pool.connect();
    try {
      let meta = null;
      try {
        meta = JSON.parse(await readFile(metaPath, "utf8"));
      } catch {
        /* optional */
      }

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
        });
        await client.query("COMMIT");
        const moved = await moveHoodFiles(csvDir, processedDir, hoodCd);
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
      });

      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const batch = rows.slice(offset, offset + batchSize);
        await insertBatch(client, batch);
      }
      await client.query("COMMIT");

      const moved = await moveHoodFiles(csvDir, processedDir, hoodCd);
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

export async function getDbCounts() {
  try {
    const [props, hoods] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS n FROM properties"),
      pool.query("SELECT COUNT(*)::int AS n FROM neighborhoods"),
    ]);
    return {
      connected: true,
      propertyCount: props.rows[0]?.n ?? 0,
      neighborhoodDbCount: hoods.rows[0]?.n ?? 0,
    };
  } catch (err) {
    return {
      connected: false,
      error: err.message,
      propertyCount: 0,
      neighborhoodDbCount: 0,
    };
  }
}
