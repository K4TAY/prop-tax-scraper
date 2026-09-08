import pool from "./db.js";
import { PROPERTY_FIELDS } from "./browse.js";

const FIELD_SET = new Set(PROPERTY_FIELDS.map((f) => f.name));
const OPS = new Set([
  "eq",
  "neq",
  "ilike",
  "not_ilike",
  "like",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_null",
  "not_null",
  "in",
  "has_token",
]);

const META_FIELDS = [
  { name: "state_code", label: "State", type: "text", defaultVisible: true },
  { name: "county_slug", label: "County", type: "text", defaultVisible: true },
  { name: "county_name", label: "County name", type: "text", defaultVisible: true },
];

const META_SET = new Set(META_FIELDS.map((f) => f.name));
const TABLE_RE = /^([a-z0-9_]+)_([a-z]{2})_properties$/;

function quoteIdent(name) {
  if (!FIELD_SET.has(name) && !META_SET.has(name)) {
    throw new Error(`Invalid field: ${name}`);
  }
  return `"${name}"`;
}

function normalizeSlug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function quoteTable(name) {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Invalid table: ${name}`);
  }
  return `"${name}"`;
}

function titleCaseSlug(slug) {
  return String(slug || "")
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeFilters(filters) {
  if (!Array.isArray(filters)) return [];
  return filters
    .map((f) => ({
      field: String(f.field || "").trim(),
      op: String(f.op || "eq").trim().toLowerCase(),
      value: f.value,
    }))
    .filter((f) => FIELD_SET.has(f.field) && OPS.has(f.op));
}

function normalizeFields(fields) {
  let list = Array.isArray(fields)
    ? fields.map((f) => String(f).trim()).filter((f) => FIELD_SET.has(f))
    : [];
  if (!list.length) {
    list = PROPERTY_FIELDS.filter((f) => f.defaultVisible).map((f) => f.name);
  }
  return list;
}

/**
 * List county properties tables, optionally filtered by state / access grants.
 * @param {{
 *   state?: string | null,
 *   allowedCounties?: { state: string, slug: string }[] | null,
 *   counties?: string[] | null,
 *   client?: import("pg").Pool | import("pg").PoolClient,
 * }} opts
 * @returns {Promise<{ table: string, state: string, slug: string, countyName: string }[]>}
 */
export async function listCountyPropertyTables({
  state = null,
  allowedCounties = null,
  counties = null,
  client = pool,
} = {}) {
  const { rows } = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name LIKE '%\\_properties' ESCAPE '\\'
      AND table_name <> 'properties'
    ORDER BY table_name
  `);

  const out = [];
  const allow =
    allowedCounties == null
      ? null
      : new Set(
          allowedCounties.map(
            (c) => `${normalizeSlug(c.state)}:${normalizeSlug(c.slug)}`
          )
        );
  const countyWanted =
    Array.isArray(counties) && counties.length
      ? new Set(counties.map(normalizeSlug))
      : null;
  const stateFilter = state ? normalizeSlug(state).slice(0, 2) : null;

  for (const { table_name } of rows) {
    const m = TABLE_RE.exec(table_name);
    if (!m) continue;
    const slug = m[1];
    const st = m[2];
    if (stateFilter && st !== stateFilter) continue;
    if (allow && !allow.has(`${st}:${slug}`)) continue;
    if (countyWanted && !countyWanted.has(slug)) continue;
    out.push({
      table: table_name,
      state: st,
      slug,
      countyName: titleCaseSlug(slug),
    });
  }
  return out;
}

/** null = all counties (admin); empty array = none. */
export async function loadUserCountyAccess(userId) {
  const { rows } = await pool.query(
    `SELECT state_code, county_slug
     FROM user_county_access
     WHERE user_id = $1`,
    [userId]
  );
  return rows.map((r) => ({
    state: String(r.state_code || "").toLowerCase(),
    slug: normalizeSlug(r.county_slug),
  }));
}

function buildWhereClause(filters, q, params) {
  const whereParts = [];

  const quick = String(q || "").trim();
  if (quick) {
    params.push(`%${quick}%`);
    const p = `$${params.length}`;
    whereParts.push(`(
      pacs_prop_id::text ILIKE ${p}
      OR COALESCE(geo_id, '') ILIKE ${p}
      OR COALESCE(owner_name, '') ILIKE ${p}
      OR COALESCE(situs, '') ILIKE ${p}
      OR COALESCE(legal_desc, '') ILIKE ${p}
      OR COALESCE(addr_line1, '') ILIKE ${p}
    )`);
  }

  for (const f of filters) {
    const col = quoteIdent(f.field);
    if (f.op === "is_null") {
      whereParts.push(`${col} IS NULL`);
      continue;
    }
    if (f.op === "not_null") {
      whereParts.push(`${col} IS NOT NULL`);
      continue;
    }
    if (f.op === "in") {
      const values = Array.isArray(f.value)
        ? f.value
        : String(f.value ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
      if (!values.length) continue;
      params.push(values);
      whereParts.push(`${col} = ANY($${params.length})`);
      continue;
    }

    let value = f.value;
    if (value == null || String(value).trim() === "") continue;

    if (f.op === "has_token") {
      params.push(String(value).trim());
      whereParts.push(`EXISTS (
        SELECT 1
        FROM unnest(string_to_array(COALESCE(${col}::text, ''), ',')) AS t(tok)
        WHERE upper(trim(t.tok)) = upper($${params.length})
      )`);
      continue;
    }

    if (f.op === "ilike" || f.op === "not_ilike" || f.op === "like") {
      const raw = String(value);
      const pattern = raw.includes("%") ? raw : `%${raw}%`;
      params.push(pattern);
      if (f.op === "not_ilike") {
        whereParts.push(`COALESCE(${col}::text, '') NOT ILIKE $${params.length}`);
      } else {
        whereParts.push(
          f.op === "ilike"
            ? `${col}::text ILIKE $${params.length}`
            : `${col}::text LIKE $${params.length}`
        );
      }
      continue;
    }

    params.push(value);
    const p = `$${params.length}`;
    switch (f.op) {
      case "eq":
        whereParts.push(`${col} = ${p}`);
        break;
      case "neq":
        whereParts.push(`${col} <> ${p}`);
        break;
      case "gt":
        whereParts.push(`${col} > ${p}`);
        break;
      case "gte":
        whereParts.push(`${col} >= ${p}`);
        break;
      case "lt":
        whereParts.push(`${col} < ${p}`);
        break;
      case "lte":
        whereParts.push(`${col} <= ${p}`);
        break;
      default:
        break;
    }
  }

  return whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
}

/**
 * Cross-county property search via UNION ALL of live county tables.
 * Always reflects current imports (no separate master copy to sync).
 *
 * @param {{
 *   q?: string,
 *   fields?: string[],
 *   filters?: { field: string, op: string, value?: unknown }[],
 *   counties?: string[],
 *   state?: string,
 *   allowedCounties?: { state: string, slug: string }[] | null,
 *   limit?: number,
 *   offset?: number,
 *   sort?: string,
 *   order?: string,
 * }} opts
 */
export async function searchAllProperties(opts = {}) {
  const fields = normalizeFields(opts.fields);
  const filters = normalizeFilters(opts.filters);
  const q = String(opts.q || "").trim();
  const limit = Math.min(Math.max(parseInt(String(opts.limit ?? 50), 10) || 50, 1), 1000);
  const offset = Math.max(parseInt(String(opts.offset ?? 0), 10) || 0, 0);

  const sortCandidate = String(opts.sort || "owner_name");
  const sort =
    FIELD_SET.has(sortCandidate) || META_SET.has(sortCandidate)
      ? sortCandidate
      : "owner_name";
  const order = String(opts.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

  if (!q && !filters.length) {
    const err = new Error("Enter a search term or at least one filter.");
    err.status = 400;
    throw err;
  }

  const tables = await listCountyPropertyTables({
    state: opts.state || null,
    allowedCounties: opts.allowedCounties,
    counties: opts.counties || null,
  });

  const outFields = ["state_code", "county_slug", "county_name", ...fields];

  if (!tables.length) {
    return {
      fields: outFields,
      sort,
      order: order.toLowerCase(),
      limit,
      offset,
      total: 0,
      countyCount: 0,
      rows: [],
    };
  }

  // Shared param list so every UNION branch uses the same $N placeholders.
  const params = [];
  const whereSql = buildWhereClause(filters, q, params);
  // Always select id for stable ordering even if not displayed.
  const selectCols = new Set(fields);
  selectCols.add("id");
  const propSelect = [...selectCols].map((f) => quoteIdent(f)).join(", ");

  const unionParts = tables.map((t) => {
    const st = t.state.replace(/'/g, "''");
    const slug = t.slug.replace(/'/g, "''");
    const name = t.countyName.replace(/'/g, "''");
    return `
      SELECT
        '${st}'::text AS state_code,
        '${slug}'::text AS county_slug,
        '${name}'::text AS county_name,
        ${propSelect}
      FROM ${quoteTable(t.table)}
      ${whereSql}
    `;
  });

  const unionSql = unionParts.join("\nUNION ALL\n");

  const countRes = await pool.query(
    `SELECT COUNT(*)::bigint AS n FROM (${unionSql}) AS all_props`,
    params
  );
  const total = Number(countRes.rows[0]?.n ?? 0);

  const dataParams = [...params, limit, offset];
  const limIdx = params.length + 1;
  const offIdx = params.length + 2;
  const dataRes = await pool.query(
    `
    SELECT ${outFields.map((f) => quoteIdent(f)).join(", ")}
    FROM (${unionSql}) AS all_props
    ORDER BY ${quoteIdent(sort)} ${order} NULLS LAST, county_slug ASC, id ASC
    LIMIT $${limIdx}
    OFFSET $${offIdx}
    `,
    dataParams
  );

  return {
    fields: outFields,
    sort,
    order: order.toLowerCase(),
    limit,
    offset,
    total,
    countyCount: tables.length,
    rows: dataRes.rows,
  };
}

export function listSearchFields() {
  return [...META_FIELDS, ...PROPERTY_FIELDS];
}
