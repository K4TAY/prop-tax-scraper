import pool from "./db.js";

/** Whitelist of browsable property columns (matches Postgres `properties` table). */
export const PROPERTY_FIELDS = [
  { name: "id", label: "Row ID", type: "number", defaultVisible: false },
  { name: "pacs_prop_id", label: "Property ID", type: "text", defaultVisible: true },
  { name: "prop_val_yr", label: "Tax year", type: "number", defaultVisible: false },
  { name: "geo_id", label: "Geo ID", type: "text", defaultVisible: true },
  { name: "prop_type_cd", label: "Type code", type: "text", defaultVisible: false },
  { name: "prop_type_desc", label: "Type", type: "text", defaultVisible: true },
  { name: "dba_name", label: "DBA", type: "text", defaultVisible: false },
  { name: "appraised_val", label: "Appraised (text)", type: "text", defaultVisible: true },
  { name: "appraised_val_num", label: "Appraised ($)", type: "number", defaultVisible: false },
  { name: "abs_subdv_cd", label: "Subdivision", type: "text", defaultVisible: false },
  { name: "mapsco", label: "MAPSCO", type: "text", defaultVisible: false },
  { name: "map_id", label: "Map ID", type: "text", defaultVisible: false },
  { name: "agent_cd", label: "Agent", type: "text", defaultVisible: false },
  { name: "hood_cd", label: "Neighborhood ID", type: "text", defaultVisible: true },
  { name: "hood_name", label: "Neighborhood", type: "text", defaultVisible: true },
  { name: "owner_name", label: "Owner", type: "text", defaultVisible: true },
  { name: "owner_id", label: "Owner ID", type: "number", defaultVisible: false },
  { name: "addr_line1", label: "Mail addr 1", type: "text", defaultVisible: false },
  { name: "addr_line2", label: "Mail addr 2", type: "text", defaultVisible: false },
  { name: "addr_line3", label: "Mail addr 3", type: "text", defaultVisible: false },
  { name: "addr_city", label: "Mail city", type: "text", defaultVisible: false },
  { name: "addr_state", label: "Mail state", type: "text", defaultVisible: false },
  { name: "addr_zip", label: "Mail ZIP", type: "text", defaultVisible: false },
  { name: "addr_country", label: "Mail country", type: "text", defaultVisible: false },
  { name: "pct_ownership", label: "% ownership", type: "number", defaultVisible: false },
  { name: "exemptions", label: "Exemptions", type: "text", defaultVisible: false },
  { name: "state_cd", label: "State code", type: "text", defaultVisible: false },
  { name: "legal_desc", label: "Legal description", type: "text", defaultVisible: false },
  { name: "situs", label: "Situs", type: "text", defaultVisible: true },
  { name: "jurisdictions", label: "Jurisdictions", type: "text", defaultVisible: false },
  { name: "imported_at", label: "Imported at", type: "timestamp", defaultVisible: false },
];

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

function quoteIdent(name) {
  if (!FIELD_SET.has(name)) {
    throw new Error(`Invalid field: ${name}`);
  }
  return `"${name}"`;
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
  // Always include PK first if selected set is non-empty and missing it — optional
  return list;
}

/**
 * Browse properties with column selection + filters.
 * @param {{
 *   fields?: string[],
 *   filters?: { field: string, op: string, value?: unknown }[],
 *   limit?: number,
 *   offset?: number,
 *   sort?: string,
 *   order?: string,
 *   propertiesTable?: string,
 * }} opts
 */
export async function browseProperties(opts = {}) {
  const fields = normalizeFields(opts.fields);
  const filters = normalizeFilters(opts.filters);
  const limit = Math.min(Math.max(parseInt(String(opts.limit ?? 50), 10) || 50, 1), 1000);
  const offset = Math.max(parseInt(String(opts.offset ?? 0), 10) || 0, 0);
  const sort = FIELD_SET.has(opts.sort) ? opts.sort : "id";
  const order = String(opts.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const propertiesTable = opts.propertiesTable || "bexar_tx_properties";
  if (!/^[a-z0-9_]+$/.test(propertiesTable)) {
    throw new Error(`Invalid properties table: ${propertiesTable}`);
  }
  const fromTable = `"${propertiesTable}"`;

  const whereParts = [];
  const params = [];

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
        whereParts.push(
          `COALESCE(${col}::text, '') NOT ILIKE $${params.length}`
        );
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

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
  const selectList = fields.map((f) => quoteIdent(f)).join(", ");

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ${fromTable} ${whereSql}`,
    params
  );
  const total = countRes.rows[0]?.n ?? 0;

  const dataParams = [...params, limit, offset];
  const limIdx = params.length + 1;
  const offIdx = params.length + 2;
  const dataRes = await pool.query(
    `
    SELECT ${selectList}
    FROM ${fromTable}
    ${whereSql}
    ORDER BY ${quoteIdent(sort)} ${order} NULLS LAST, id ASC
    LIMIT $${limIdx}
    OFFSET $${offIdx}
    `,
    dataParams
  );

  return {
    fields,
    sort,
    order: order.toLowerCase(),
    limit,
    offset,
    total,
    propertiesTable,
    rows: dataRes.rows,
  };
}

export function listBrowseFields() {
  return PROPERTY_FIELDS;
}
