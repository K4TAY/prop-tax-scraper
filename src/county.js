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
  CREATE INDEX IF NOT EXISTS ${quoteTable(`${t}_hood_cd_idx`)} ON ${quoteTable(t)} (hood_cd);
  CREATE INDEX IF NOT EXISTS ${quoteTable(`${t}_owner_name_idx`)} ON ${quoteTable(t)} (owner_name);
  CREATE INDEX IF NOT EXISTS ${quoteTable(`${t}_situs_idx`)} ON ${quoteTable(t)} (situs);
  CREATE INDEX IF NOT EXISTS ${quoteTable(`${t}_geo_id_idx`)} ON ${quoteTable(t)} (geo_id);
`;

export async function ensureCountyTables(ctx, client = pool) {
  await client.query(NEIGHBORHOODS_DDL(ctx.neighborhoodsTable));
  await client.query(PROPERTIES_DDL(ctx.propertiesTable));
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
      INSERT INTO ${quoteTable(bexar.propertiesTable)}
      SELECT * FROM properties
      ON CONFLICT (pacs_prop_id) DO NOTHING
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
    const [p, n] = await Promise.all([
      client.query(
        `SELECT COUNT(*)::int AS n FROM ${quoteTable(ctx.propertiesTable)}`
      ),
      client.query(
        `SELECT COUNT(*)::int AS n FROM ${quoteTable(ctx.neighborhoodsTable)}`
      ),
    ]);
    return {
      connected: true,
      propertyCount: p.rows[0]?.n ?? 0,
      neighborhoodDbCount: n.rows[0]?.n ?? 0,
      propertiesTable: ctx.propertiesTable,
      neighborhoodsTable: ctx.neighborhoodsTable,
    };
  } catch (err) {
    return {
      connected: false,
      error: err.message,
      propertyCount: null,
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
