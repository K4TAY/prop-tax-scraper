import bcadPool from "./bcadDb.js";

/** Columns exposed in the portal data grid (no geom). */
export const BCAD_BROWSE_FIELDS = [
  { name: "pacs_prop_id", label: "Property ID", type: "text", defaultVisible: true },
  { name: "geo_id", label: "Geo ID", type: "text", defaultVisible: true },
  { name: "owner_name", label: "Owner", type: "text", defaultVisible: true },
  { name: "situs", label: "Situs", type: "text", defaultVisible: true },
  { name: "appraised_val", label: "Appraised (text)", type: "text", defaultVisible: true },
  { name: "appraised_val_num", label: "Appraised ($)", type: "number", defaultVisible: true },
  { name: "hood_cd", label: "Neighborhood ID", type: "text", defaultVisible: true },
  { name: "hood_name", label: "Neighborhood", type: "text", defaultVisible: true },
  { name: "prop_val_yr", label: "Tax year", type: "number", defaultVisible: true },
  { name: "prop_type_desc", label: "Type", type: "text", defaultVisible: true },
  { name: "exemptions", label: "Exemptions", type: "text", defaultVisible: false },
  { name: "dba_name", label: "DBA", type: "text", defaultVisible: false },
  { name: "legal_desc", label: "Legal description", type: "text", defaultVisible: false },
  { name: "owner_id", label: "Owner ID", type: "text", defaultVisible: false },
  { name: "addr_line1", label: "Mail addr 1", type: "text", defaultVisible: false },
  { name: "addr_line2", label: "Mail addr 2", type: "text", defaultVisible: false },
  { name: "addr_line3", label: "Mail addr 3", type: "text", defaultVisible: false },
  { name: "addr_city", label: "Mail city", type: "text", defaultVisible: false },
  { name: "addr_state", label: "Mail state", type: "text", defaultVisible: false },
  { name: "addr_zip", label: "Mail ZIP", type: "text", defaultVisible: false },
  { name: "addr_country", label: "Mail country", type: "text", defaultVisible: false },
  { name: "prop_type_cd", label: "Type code", type: "text", defaultVisible: false },
  { name: "state_cd", label: "State code", type: "text", defaultVisible: false },
  { name: "pct_ownership", label: "% ownership", type: "number", defaultVisible: false },
  { name: "jurisdictions", label: "Jurisdictions", type: "text", defaultVisible: false },
  { name: "abs_subdv_cd", label: "Subdivision", type: "text", defaultVisible: false },
  { name: "mapsco", label: "MAPSCO", type: "text", defaultVisible: false },
  { name: "map_id", label: "Map ID", type: "text", defaultVisible: false },
  { name: "agent_cd", label: "Agent", type: "text", defaultVisible: false },
  { name: "prop_id", label: "PROP_ID", type: "text", defaultVisible: false },
  { name: "account_id", label: "Account ID", type: "text", defaultVisible: false },
  { name: "objectid", label: "OBJECTID", type: "number", defaultVisible: false },
  { name: "id", label: "Row ID", type: "number", defaultVisible: false },
  { name: "imported_at", label: "Imported at", type: "timestamp", defaultVisible: false },
];

export const DEFAULT_BCAD_FILTERS = [
  { field: "appraised_val_num", op: "gt", value: "0" },
];

const FIELD_SET = new Set(BCAD_BROWSE_FIELDS.map((f) => f.name));
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

const PAGE_SIZES = new Set([25, 50, 100, 250, 500, 1000]);

function quoteIdent(name) {
  if (!FIELD_SET.has(name)) throw new Error(`Invalid field: ${name}`);
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
  // Preserve order; de-dupe
  const seen = new Set();
  list = list.filter((f) => {
    if (seen.has(f)) return false;
    seen.add(f);
    return true;
  });
  if (!list.length) {
    list = BCAD_BROWSE_FIELDS.filter((f) => f.defaultVisible).map((f) => f.name);
  }
  return list;
}

function normalizeLimit(raw) {
  const n = parseInt(String(raw ?? 1000), 10) || 1000;
  if (PAGE_SIZES.has(n)) return n;
  return Math.min(Math.max(n, 1), 1000);
}

/**
 * @param {{
 *   fields?: string[],
 *   filters?: { field: string, op: string, value?: unknown }[],
 *   limit?: number,
 *   offset?: number,
 *   sort?: string,
 *   order?: string,
 * }} opts
 */
export async function browseBcadProperties(opts = {}) {
  const fields = normalizeFields(opts.fields);
  const filters = normalizeFilters(opts.filters);
  const limit = normalizeLimit(opts.limit);
  const offset = Math.max(parseInt(String(opts.offset ?? 0), 10) || 0, 0);
  const sort = FIELD_SET.has(opts.sort) ? opts.sort : "id";
  const order =
    String(opts.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

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

  const countRes = await bcadPool.query(
    `SELECT COUNT(*)::bigint AS n FROM bcad_properties ${whereSql}`,
    params
  );
  const total = Number(countRes.rows[0]?.n ?? 0);

  const dataParams = [...params, limit, offset];
  const limIdx = params.length + 1;
  const offIdx = params.length + 2;
  const dataRes = await bcadPool.query(
    `
    SELECT ${selectList}
    FROM bcad_properties
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
    rows: dataRes.rows,
  };
}

export function listBcadBrowseFields() {
  return BCAD_BROWSE_FIELDS;
}

export function listDefaultBcadFilters() {
  return DEFAULT_BCAD_FILTERS;
}

export function listBcadPageSizes() {
  return [25, 50, 100, 250, 500, 1000];
}
