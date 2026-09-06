import { existsSync } from "fs";
import { readdir } from "fs/promises";
import pool from "./db.js";

/** @typedef {{ state: string, county: string, countyName: string, slug: string, prefix: string, neighborhoodsTable: string, propertiesTable: string, csvDir: string, processedDir: string, dataDir: string }} CountyContext */

const STATE_RE = /^[a-z]{2}$/;
const SLUG_RE = /^[a-z0-9_]+$/;

export function countySlug(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

export function normalizeState(state) {
  const s = String(state || "")
    .trim()
    .toLowerCase();
  if (!STATE_RE.test(s)) throw new Error(`Invalid state code: ${state}`);
  return s;
}

export function quoteTable(name) {
  if (!SLUG_RE.test(name) || name.length > 63) {
    throw new Error(`Invalid table name: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Resolve county portal paths + table names.
 * Tables: `{county_slug}_{state}_neighborhoods` / `_properties`
 * Files:  `{DATA_DIR}/{state}/{slug}/csv` and `.../processed`
 */
export function resolveCounty(stateRaw, countyRaw, dataRoot) {
  const state = normalizeState(stateRaw);
  const slug = countySlug(countyRaw);
  if (!slug || !SLUG_RE.test(slug)) {
    throw new Error(`Invalid county: ${countyRaw}`);
  }
  const countyName = String(countyRaw || "")
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const prefix = `${slug}_${state}`;
  const dataDir = joinPath(dataRoot, state, slug);
  return {
    state,
    county: slug,
    countyName,
    slug,
    prefix,
    neighborhoodsTable: `${prefix}_neighborhoods`,
    propertiesTable: `${prefix}_properties`,
    dataDir,
    csvDir: joinPath(dataDir, "csv"),
    processedDir: joinPath(dataDir, "processed"),
  };
}

function joinPath(...parts) {
  return parts.join("/").replace(/\/+/g, "/");
}

const NEIGHBORHOODS_DDL = (t) => `
  CREATE TABLE IF NOT EXISTS ${quoteTable(t)} (
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
`;

const PROPERTIES_DDL = (t) => `
  CREATE TABLE IF NOT EXISTS ${quoteTable(t)} (
    id BIGSERIAL PRIMARY KEY,
    pacs_prop_id BIGINT,
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
  CREATE INDEX IF NOT EXISTS ${quoteTable(`${t}_pacs_prop_id_idx`)} ON ${quoteTable(t)} (pacs_prop_id);
  CREATE INDEX IF NOT EXISTS ${quoteTable(`${t}_hood_cd_idx`)} ON ${quoteTable(t)} (hood_cd);
  CREATE INDEX IF NOT EXISTS ${quoteTable(`${t}_owner_name_idx`)} ON ${quoteTable(t)} (owner_name);
  CREATE INDEX IF NOT EXISTS ${quoteTable(`${t}_situs_idx`)} ON ${quoteTable(t)} (situs);
  CREATE INDEX IF NOT EXISTS ${quoteTable(`${t}_geo_id_idx`)} ON ${quoteTable(t)} (geo_id);
`;

/**
 * Migrate a properties table from pacs_prop_id PK → surrogate id PK so we can
 * store duplicate and null remote property ids (one row per scraped feature).
 * Safe under concurrent imports (check-then-add races are ignored).
 */
export async function migratePropertiesToRowId(client, tableName) {
  if (!(await tableExists(client, tableName))) {
    return { migrated: false, reason: "missing" };
  }
  const q = quoteTable(tableName);

  const { rows: idCol } = await client.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'
    `,
    [tableName]
  );
  if (!idCol.length) {
    try {
      await client.query(`ALTER TABLE ${q} ADD COLUMN id BIGSERIAL`);
    } catch (err) {
      // Concurrent import may have added it between the check and ALTER.
      if (!/already exists/i.test(err.message || "")) throw err;
    }
  }

  const { rows: pks } = await client.query(
    `
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE t.relname = $1 AND n.nspname = 'public' AND c.contype = 'p'
    `,
    [tableName]
  );

  const pkOnId = pks.some((p) => /\(id\)/i.test(String(p.def || "")));
  if (!pkOnId) {
    for (const pk of pks) {
      const con = String(pk.conname).replace(/"/g, '""');
      try {
        await client.query(`ALTER TABLE ${q} DROP CONSTRAINT "${con}"`);
      } catch (err) {
        if (!/does not exist/i.test(err.message || "")) throw err;
      }
    }
    try {
      await client.query(`ALTER TABLE ${q} ALTER COLUMN pacs_prop_id DROP NOT NULL`);
    } catch {
      /* already nullable */
    }
    try {
      await client.query(`ALTER TABLE ${q} ALTER COLUMN id SET NOT NULL`);
    } catch {
      /* already NOT NULL or concurrent */
    }
    try {
      await client.query(`ALTER TABLE ${q} ADD PRIMARY KEY (id)`);
    } catch (err) {
      if (!/already exists|multiple primary keys/i.test(err.message || "")) {
        throw err;
      }
    }
  } else {
    try {
      await client.query(`ALTER TABLE ${q} ALTER COLUMN pacs_prop_id DROP NOT NULL`);
    } catch {
      /* already nullable */
    }
  }

  await client.query(
    `CREATE INDEX IF NOT EXISTS ${quoteTable(`${tableName}_pacs_prop_id_idx`)} ON ${q} (pacs_prop_id)`
  );
  return { migrated: true, table: tableName };
}

export async function migrateAllPropertiesTables(client = pool) {
  const { rows } = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND (
        table_name = 'properties'
        OR table_name LIKE '%\\_properties' ESCAPE '\\'
      )
    ORDER BY table_name
  `);
  const results = [];
  for (const { table_name } of rows) {
    results.push(await migratePropertiesToRowId(client, table_name));
  }
  return results;
}

export async function ensureCountyTables(ctx, client = pool) {
  await client.query(NEIGHBORHOODS_DDL(ctx.neighborhoodsTable));
  await client.query(PROPERTIES_DDL(ctx.propertiesTable));
  await migratePropertiesToRowId(client, ctx.propertiesTable);
}

async function tableExists(client, name) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [name]
  );
  return rows.length > 0;
}

async function tableCount(client, name) {
  if (!(await tableExists(client, name))) return 0;
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM ${quoteTable(name)}`
  );
  return rows[0]?.n ?? 0;
}

/** Total rows + distinct non-null pacs_prop_id (partial ownership → more rows than parcels). */
async function propertyImportCounts(client, tableName) {
  if (!(await tableExists(client, tableName))) {
    return { propertyCount: 0, uniqueParcelCount: 0, nullParcelIdCount: 0 };
  }
  const { rows } = await client.query(
    `
    SELECT
      COUNT(*)::int AS property_count,
      COUNT(DISTINCT pacs_prop_id) FILTER (WHERE pacs_prop_id IS NOT NULL)::int AS unique_parcel_count,
      COUNT(*) FILTER (WHERE pacs_prop_id IS NULL)::int AS null_parcel_id_count
    FROM ${quoteTable(tableName)}
    `
  );
  const r = rows[0] || {};
  return {
    propertyCount: r.property_count ?? 0,
    uniqueParcelCount: r.unique_parcel_count ?? 0,
    nullParcelIdCount: r.null_parcel_id_count ?? 0,
  };
}

/**
 * One-time: copy legacy shared neighborhoods/properties into bexar_tx_* if needed.
 */
export async function migrateLegacyBexarTables(client = pool) {
  const bexar = resolveCounty("tx", "bexar", "/tmp"); // paths unused here
  await ensureCountyTables(bexar, client);

  const hasLegacyProps = await tableExists(client, "properties");
  const hasLegacyHoods = await tableExists(client, "neighborhoods");
  if (!hasLegacyProps && !hasLegacyHoods) return { migrated: false };

  const newProps = await tableCount(client, bexar.propertiesTable);
  const newHoods = await tableCount(client, bexar.neighborhoodsTable);
  const oldProps = hasLegacyProps ? await tableCount(client, "properties") : 0;
  const oldHoods = hasLegacyHoods ? await tableCount(client, "neighborhoods") : 0;

  let copiedProps = 0;
  let copiedHoods = 0;

  if (oldProps > 0 && newProps === 0) {
    await client.query(`
      INSERT INTO ${quoteTable(bexar.propertiesTable)} (
        pacs_prop_id, prop_val_yr, geo_id, prop_type_cd, prop_type_desc, dba_name,
        appraised_val, appraised_val_num, abs_subdv_cd, mapsco, map_id, agent_cd,
        hood_cd, hood_name, owner_name, owner_id, addr_line1, addr_line2, addr_line3,
        addr_city, addr_state, addr_zip, addr_country, pct_ownership, exemptions,
        state_cd, legal_desc, situs, jurisdictions, imported_at
      )
      SELECT
        pacs_prop_id, prop_val_yr, geo_id, prop_type_cd, prop_type_desc, dba_name,
        appraised_val, appraised_val_num, abs_subdv_cd, mapsco, map_id, agent_cd,
        hood_cd, hood_name, owner_name, owner_id, addr_line1, addr_line2, addr_line3,
        addr_city, addr_state, addr_zip, addr_country, pct_ownership, exemptions,
        state_cd, legal_desc, situs, jurisdictions, imported_at
      FROM properties
    `);
    copiedProps = await tableCount(client, bexar.propertiesTable);
  }
  if (oldHoods > 0 && newHoods === 0) {
    await client.query(`
      INSERT INTO ${quoteTable(bexar.neighborhoodsTable)}
      SELECT * FROM neighborhoods
      ON CONFLICT (hood_cd) DO NOTHING
    `);
    copiedHoods = await tableCount(client, bexar.neighborhoodsTable);
  }

  return {
    migrated: copiedProps > 0 || copiedHoods > 0,
    copiedProps,
    copiedHoods,
    legacyProps: oldProps,
    legacyHoods: oldHoods,
  };
}

export async function getCountyDbCounts(ctx, client = pool) {
  await ensureCountyTables(ctx, client);
  try {
    const [props, n] = await Promise.all([
      propertyImportCounts(client, ctx.propertiesTable),
      client.query(
        `SELECT COUNT(*)::int AS n FROM ${quoteTable(ctx.neighborhoodsTable)}`
      ),
    ]);
    return {
      connected: true,
      propertyCount: props.propertyCount,
      uniqueParcelCount: props.uniqueParcelCount,
      nullParcelIdCount: props.nullParcelIdCount,
      neighborhoodDbCount: n.rows[0]?.n ?? 0,
      propertiesTable: ctx.propertiesTable,
      neighborhoodsTable: ctx.neighborhoodsTable,
    };
  } catch (err) {
    return {
      connected: false,
      error: err.message,
      propertyCount: null,
      uniqueParcelCount: null,
      nullParcelIdCount: null,
      neighborhoodDbCount: null,
    };
  }
}

/** Look up cad_sources row for state+county slug/name. */
export async function findCadSource(state, countySlugOrName, client = pool) {
  const st = normalizeState(state).toUpperCase();
  const slug = countySlug(countySlugOrName);
  const { rows } = await client.query(
    `
    SELECT *
    FROM cad_sources
    WHERE state_code = $1
      AND (
        lower(regexp_replace(county_name, '[^a-zA-Z0-9]+', '_', 'g')) = $2
        OR lower(county_name) = lower($3)
      )
    LIMIT 1
    `,
    [st, slug, countySlugOrName]
  );
  return rows[0] || null;
}

/**
 * Import status + DB counts for a county (no table creation).
 * @returns {Promise<{
 *   importComplete: boolean,
 *   propertyCount: number,
 *   uniqueParcelCount: number,
 *   nullParcelIdCount: number,
 *   neighborhoodCount: number,
 *   pendingCsvCount: number,
 * }>}
 */
export async function getCountyImportStats(ctx, client = pool) {
  let pendingCsvCount = 0;
  if (existsSync(ctx.csvDir)) {
    try {
      const files = await readdir(ctx.csvDir);
      pendingCsvCount = files.filter((n) => n.endsWith(".csv")).length;
    } catch {
      /* ignore */
    }
  }

  const empty = {
    importComplete: false,
    propertyCount: 0,
    uniqueParcelCount: 0,
    nullParcelIdCount: 0,
    neighborhoodCount: 0,
    pendingCsvCount,
  };

  if (!(await tableExists(client, ctx.propertiesTable))) return empty;
  if (!(await tableExists(client, ctx.neighborhoodsTable))) return empty;

  const [propCounts, hoodRows] = await Promise.all([
    propertyImportCounts(client, ctx.propertiesTable),
    client.query(
      `
      SELECT
        COUNT(*)::int AS hoods,
        COUNT(*) FILTER (
          WHERE truncated IS TRUE
             OR (
               total_available IS NOT NULL
               AND exported IS NOT NULL
               AND exported < total_available
             )
        )::int AS incomplete
      FROM ${quoteTable(ctx.neighborhoodsTable)}
      `
    ),
  ]);

  const neighborhoodCount = hoodRows.rows[0]?.hoods ?? 0;
  const incomplete = hoodRows.rows[0]?.incomplete ?? 0;
  const propCount = propCounts.propertyCount;
  const importComplete =
    pendingCsvCount === 0 &&
    propCount > 0 &&
    neighborhoodCount > 0 &&
    incomplete === 0;

  return {
    importComplete,
    propertyCount: propCount,
    uniqueParcelCount: propCounts.uniqueParcelCount,
    nullParcelIdCount: propCounts.nullParcelIdCount,
    neighborhoodCount,
    pendingCsvCount,
  };
}

/** @deprecated Prefer getCountyImportStats */
export async function isCountyFullyImported(ctx, client = pool) {
  const stats = await getCountyImportStats(ctx, client);
  return stats.importComplete;
}

/**
 * Batch import stats keyed by county slug for a state catalog list.
 * @param {string} stateRaw
 * @param {{ slug: string }[]} counties
 * @param {string} dataRoot
 * @returns {Promise<Map<string, {
 *   importComplete: boolean,
 *   propertyCount: number,
 *   uniqueParcelCount: number,
 *   nullParcelIdCount: number,
 *   neighborhoodCount: number,
 *   pendingCsvCount: number,
 * }>>}
 */
export async function mapImportStatsBySlug(stateRaw, counties, dataRoot, client = pool) {
  const out = new Map();
  await Promise.all(
    (counties || []).map(async (c) => {
      const slug = c.slug || countySlug(c.county_name || c.name);
      try {
        const ctx = resolveCounty(stateRaw, slug, dataRoot);
        out.set(slug, await getCountyImportStats(ctx, client));
      } catch {
        out.set(slug, {
          importComplete: false,
          propertyCount: 0,
          uniqueParcelCount: 0,
          nullParcelIdCount: 0,
          neighborhoodCount: 0,
          pendingCsvCount: 0,
        });
      }
    })
  );
  return out;
}

/**
 * Batch import-complete flags keyed by county slug for a state catalog list.
 * @deprecated Prefer mapImportStatsBySlug
 */
export async function mapImportCompleteBySlug(stateRaw, counties, dataRoot, client = pool) {
  const stats = await mapImportStatsBySlug(stateRaw, counties, dataRoot, client);
  const out = new Map();
  for (const [slug, s] of stats) out.set(slug, s.importComplete === true);
  return out;
}
