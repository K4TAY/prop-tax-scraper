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

/** Computed enrichment flags (EXISTS against child tables). */
export const BCAD_ENRICHMENT_FIELDS = [
  {
    name: "has_tax_account",
    label: "Has tax account",
    type: "boolean",
    defaultVisible: false,
    group: "enrichment",
    existsSql:
      "EXISTS (SELECT 1 FROM bcad_tax_accounts t WHERE t.bcad_property_id = bcad_properties.id)",
  },
  {
    name: "has_tax_payments",
    label: "Has tax payments",
    type: "boolean",
    defaultVisible: false,
    group: "enrichment",
    existsSql:
      "EXISTS (SELECT 1 FROM bcad_tax_payments t WHERE t.bcad_property_id = bcad_properties.id)",
  },
  {
    name: "has_deeds",
    label: "Has deeds",
    type: "boolean",
    defaultVisible: false,
    group: "enrichment",
    existsSql:
      "EXISTS (SELECT 1 FROM bcad_deeds d WHERE d.bcad_property_id = bcad_properties.id)",
  },
  {
    name: "has_clerk",
    label: "Has clerk records",
    type: "boolean",
    defaultVisible: false,
    group: "enrichment",
    existsSql:
      "EXISTS (SELECT 1 FROM bcad_clerk_instruments c WHERE c.bcad_property_id = bcad_properties.id)",
  },
  {
    name: "has_hgo",
    label: "Has HGO appraisal",
    type: "boolean",
    defaultVisible: false,
    group: "enrichment",
    existsSql:
      "EXISTS (SELECT 1 FROM bcad_hgo_appraisals h WHERE h.bcad_property_id = bcad_properties.id)",
  },
  {
    name: "has_any_enrichment",
    label: "Has any enrichment",
    type: "boolean",
    defaultVisible: false,
    group: "enrichment",
    existsSql: `(
      EXISTS (SELECT 1 FROM bcad_tax_accounts t WHERE t.bcad_property_id = bcad_properties.id)
      OR EXISTS (SELECT 1 FROM bcad_deeds d WHERE d.bcad_property_id = bcad_properties.id)
      OR EXISTS (SELECT 1 FROM bcad_clerk_instruments c WHERE c.bcad_property_id = bcad_properties.id)
      OR EXISTS (SELECT 1 FROM bcad_hgo_appraisals h WHERE h.bcad_property_id = bcad_properties.id)
    )`,
  },
];

/** One-click missing-data filters for the browse sidebar. */
export const BCAD_MISSING_DATA_PRESETS = [
  {
    id: "missing_enrichment",
    label: "No enrichment",
    filters: [{ field: "has_any_enrichment", op: "eq", value: "false" }],
  },
  {
    id: "missing_tax",
    label: "Missing tax account",
    filters: [{ field: "has_tax_account", op: "eq", value: "false" }],
  },
  {
    id: "missing_tax_payments",
    label: "Missing tax payments",
    filters: [{ field: "has_tax_payments", op: "eq", value: "false" }],
  },
  {
    id: "missing_deeds",
    label: "Missing deeds",
    filters: [{ field: "has_deeds", op: "eq", value: "false" }],
  },
  {
    id: "missing_clerk",
    label: "Missing clerk records",
    filters: [{ field: "has_clerk", op: "eq", value: "false" }],
  },
  {
    id: "missing_hgo",
    label: "Missing HGO appraisal",
    filters: [{ field: "has_hgo", op: "eq", value: "false" }],
  },
  {
    id: "missing_owner",
    label: "Missing owner",
    filters: [{ field: "owner_name", op: "is_null" }],
  },
  {
    id: "missing_geo_id",
    label: "Missing geo ID",
    filters: [{ field: "geo_id", op: "is_null" }],
  },
  {
    id: "missing_exemptions",
    label: "Missing exemptions",
    filters: [{ field: "exemptions", op: "is_null" }],
  },
  {
    id: "missing_mail",
    label: "Missing mail address",
    filters: [{ field: "addr_line1", op: "is_null" }],
  },
  {
    id: "missing_appraised",
    label: "Missing appraised $",
    filters: [{ field: "appraised_val_num", op: "is_null" }],
  },
];

/** No default filter: the 2027 BCAD parcel layer publishes appraised_val as "N/A" for every parcel. */
export const DEFAULT_BCAD_FILTERS = [];

const ALL_BROWSE_FIELDS = [...BCAD_BROWSE_FIELDS, ...BCAD_ENRICHMENT_FIELDS];
const FIELD_SET = new Set(ALL_BROWSE_FIELDS.map((f) => f.name));
const COLUMN_FIELD_SET = new Set(BCAD_BROWSE_FIELDS.map((f) => f.name));
const ENRICHMENT_BY_NAME = Object.fromEntries(
  BCAD_ENRICHMENT_FIELDS.map((f) => [f.name, f])
);
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
  if (!COLUMN_FIELD_SET.has(name)) throw new Error(`Invalid field: ${name}`);
  return `"${name}"`;
}

function isTruthyFilterValue(value) {
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "t";
}

function isFalsyFilterValue(value) {
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  return s === "false" || s === "0" || s === "no" || s === "n" || s === "f";
}

/** NULL or blank string — matches UI label "is empty". */
function blankPredicate(colSql) {
  return `(${colSql} IS NULL OR btrim(${colSql}::text) = '')`;
}

function presentPredicate(colSql) {
  return `(${colSql} IS NOT NULL AND btrim(${colSql}::text) <> '')`;
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

function selectExpr(field) {
  const enrich = ENRICHMENT_BY_NAME[field];
  if (enrich) return `${enrich.existsSql} AS "${field}"`;
  return quoteIdent(field);
}

function sortExpr(field) {
  const enrich = ENRICHMENT_BY_NAME[field];
  if (enrich) return enrich.existsSql;
  return quoteIdent(field);
}

function appendEnrichmentFilter(f, whereParts) {
  const enrich = ENRICHMENT_BY_NAME[f.field];
  if (!enrich) return false;
  const exists = enrich.existsSql;
  if (f.op === "is_null" || (f.op === "eq" && isFalsyFilterValue(f.value))) {
    whereParts.push(`NOT (${exists})`);
    return true;
  }
  if (f.op === "not_null" || (f.op === "eq" && isTruthyFilterValue(f.value))) {
    whereParts.push(`(${exists})`);
    return true;
  }
  if (f.op === "neq") {
    if (isTruthyFilterValue(f.value)) {
      whereParts.push(`NOT (${exists})`);
      return true;
    }
    if (isFalsyFilterValue(f.value)) {
      whereParts.push(`(${exists})`);
      return true;
    }
  }
  return true; // known enrichment field but ignored op/value
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
    if (appendEnrichmentFilter(f, whereParts)) continue;

    const col = quoteIdent(f.field);
    if (f.op === "is_null") {
      whereParts.push(blankPredicate(col));
      continue;
    }
    if (f.op === "not_null") {
      whereParts.push(presentPredicate(col));
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
  const selectList = fields.map((f) => selectExpr(f)).join(", ");

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
    ORDER BY ${sortExpr(sort)} ${order} NULLS LAST, id ASC
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

export async function getBcadCompletenessStats() {
  const { rows } = await bcadPool.query(`
    SELECT
      COUNT(*)::bigint AS total_parcels,
      COUNT(*) FILTER (
        WHERE owner_name IS NULL OR btrim(owner_name) = ''
      )::bigint AS missing_owner,
      COUNT(*) FILTER (
        WHERE geo_id IS NULL OR btrim(geo_id) = ''
      )::bigint AS missing_geo_id,
      COUNT(*) FILTER (
        WHERE exemptions IS NULL OR btrim(exemptions) = ''
      )::bigint AS missing_exemptions,
      COUNT(*) FILTER (
        WHERE addr_line1 IS NULL OR btrim(addr_line1) = ''
      )::bigint AS missing_mail,
      COUNT(*) FILTER (
        WHERE appraised_val_num IS NULL
      )::bigint AS missing_appraised,
      COUNT(*) FILTER (
        WHERE situs IS NULL OR btrim(situs) = ''
      )::bigint AS missing_situs,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM bcad_tax_accounts t WHERE t.bcad_property_id = bcad_properties.id
        )
      )::bigint AS has_tax_account,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM bcad_tax_payments t WHERE t.bcad_property_id = bcad_properties.id
        )
      )::bigint AS has_tax_payments,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM bcad_deeds d WHERE d.bcad_property_id = bcad_properties.id
        )
      )::bigint AS has_deeds,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM bcad_clerk_instruments c WHERE c.bcad_property_id = bcad_properties.id
        )
      )::bigint AS has_clerk,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM bcad_hgo_appraisals h WHERE h.bcad_property_id = bcad_properties.id
        )
      )::bigint AS has_hgo,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM bcad_tax_accounts t WHERE t.bcad_property_id = bcad_properties.id
        )
        OR EXISTS (
          SELECT 1 FROM bcad_deeds d WHERE d.bcad_property_id = bcad_properties.id
        )
        OR EXISTS (
          SELECT 1 FROM bcad_clerk_instruments c WHERE c.bcad_property_id = bcad_properties.id
        )
        OR EXISTS (
          SELECT 1 FROM bcad_hgo_appraisals h WHERE h.bcad_property_id = bcad_properties.id
        )
      )::bigint AS has_any_enrichment
    FROM bcad_properties
  `);
  const r = rows[0] || {};
  const total = Number(r.total_parcels ?? 0);
  const hasAny = Number(r.has_any_enrichment ?? 0);
  return {
    total_parcels: total,
    cad: {
      missing_owner: Number(r.missing_owner ?? 0),
      missing_geo_id: Number(r.missing_geo_id ?? 0),
      missing_exemptions: Number(r.missing_exemptions ?? 0),
      missing_mail: Number(r.missing_mail ?? 0),
      missing_appraised: Number(r.missing_appraised ?? 0),
      missing_situs: Number(r.missing_situs ?? 0),
    },
    enrichment: {
      has_tax_account: Number(r.has_tax_account ?? 0),
      has_tax_payments: Number(r.has_tax_payments ?? 0),
      has_deeds: Number(r.has_deeds ?? 0),
      has_clerk: Number(r.has_clerk ?? 0),
      has_hgo: Number(r.has_hgo ?? 0),
      has_any_enrichment: hasAny,
      missing_any_enrichment: Math.max(0, total - hasAny),
    },
  };
}

export function listBcadBrowseFields() {
  return ALL_BROWSE_FIELDS.map(({ existsSql, ...rest }) => rest);
}

export function listDefaultBcadFilters() {
  return DEFAULT_BCAD_FILTERS;
}

export function listBcadMissingDataPresets() {
  return BCAD_MISSING_DATA_PRESETS;
}

export function listBcadPageSizes() {
  return [25, 50, 100, 250, 500, 1000];
}
