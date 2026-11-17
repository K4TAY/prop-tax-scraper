import bcadPool from "./bcadDb.js";
import {
  DETAIL_JOINS,
  DETAIL_SELECT,
  ensureVaOpportunitiesSchema,
  withDetailStatus,
} from "./vaOpportunities.js";

// ---------------------------------------------------------------------------
// VA lead claiming — cross-DB (PostGIS / BCAD side).
// User identity fields (claimed_by_user_id, claimed_by_email, etc.) are
// denormalised from the auth DB at claim time — no FK across DBs.
// ---------------------------------------------------------------------------

export const VA_LEAD_STATUSES = [
  { id: "new", label: "New" },
  { id: "contacted", label: "Contacted" },
  { id: "qualified", label: "Qualified" },
  { id: "proposal", label: "Proposal" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
];

export const VA_LEAD_STATUS_IDS = VA_LEAD_STATUSES.map((s) => s.id);

export async function ensureVaLeadsSchema(client = bcadPool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS bcad_va_leads (
      bcad_property_id BIGINT PRIMARY KEY
        REFERENCES bcad_properties(id) ON DELETE CASCADE,
      claimed_by_user_id BIGINT NOT NULL,
      claimed_by_email TEXT,
      claimed_by_name TEXT,
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new','contacted','qualified','proposal','won','lost')),
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS bcad_va_leads_user_status_idx
      ON bcad_va_leads (claimed_by_user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS bcad_va_lead_notes (
      id BIGSERIAL PRIMARY KEY,
      bcad_property_id BIGINT NOT NULL
        REFERENCES bcad_properties(id) ON DELETE CASCADE,
      author_user_id BIGINT NOT NULL,
      author_name TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS bcad_va_lead_notes_prop_idx
      ON bcad_va_lead_notes (bcad_property_id, created_at DESC);
  `);
}

// ---------------------------------------------------------------------------
// Claim helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to claim a property for a user.
 * Returns { ok, lead } on success; throws with .status 409 if already claimed.
 */
export async function claimVaLead(propertyId, user, client = bcadPool) {
  const displayName = [user.firstName, user.lastName]
    .filter(Boolean)
    .join(" ")
    .trim() || user.email;

  try {
    const { rows } = await client.query(
      `
      INSERT INTO bcad_va_leads
        (bcad_property_id, claimed_by_user_id, claimed_by_email, claimed_by_name, status)
      VALUES ($1, $2, $3, $4, 'new')
      RETURNING *
      `,
      [propertyId, user.id, user.email, displayName]
    );
    return { ok: true, lead: rows[0] };
  } catch (err) {
    if (err.code === "23505") {
      const conflict = new Error("property already claimed");
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
}

/**
 * Update lead status.  Caller must verify ownership / admin before calling.
 */
export async function updateVaLeadStatus(propertyId, status, client = bcadPool) {
  const { rows } = await client.query(
    `
    UPDATE bcad_va_leads
    SET status = $1, updated_at = NOW()
    WHERE bcad_property_id = $2
    RETURNING *
    `,
    [status, propertyId]
  );
  return rows[0] || null;
}

/**
 * Release (delete) a lead.  Returns true if a row was deleted.
 */
export async function releaseVaLead(propertyId, client = bcadPool) {
  const { rowCount } = await client.query(
    `DELETE FROM bcad_va_leads WHERE bcad_property_id = $1`,
    [propertyId]
  );
  return rowCount > 0;
}

/**
 * Fetch a single lead row (or null).
 */
export async function getVaLead(propertyId, client = bcadPool) {
  const { rows } = await client.query(
    `SELECT * FROM bcad_va_leads WHERE bcad_property_id = $1`,
    [propertyId]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Pool listing (unclaimed VA opportunities)
// ---------------------------------------------------------------------------

/**
 * Unclaimed VA opportunities — bcad_va_opportunities LEFT JOIN bcad_va_leads
 * WHERE lead IS NULL.  Supports the same limit/offset/tier/q filters as the
 * VA opportunities list.
 */
export async function listVaLeadPool(opts = {}) {
  const client = opts.client || bcadPool;
  await ensureVaOpportunitiesSchema(client);
  await ensureVaLeadsSchema(client);
  const rawLimit = opts.limit;
  const wantAll =
    rawLimit == null ||
    rawLimit === "" ||
    String(rawLimit).toLowerCase() === "all";
  const limit = wantAll
    ? null
    : Math.min(Math.max(Number(rawLimit) || 100, 1), 100000);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const tier = opts.tier || null;
  const q = opts.q ? String(opts.q).trim() : null;

  const params = [];
  const wheres = ["l.bcad_property_id IS NULL"];

  if (tier) {
    params.push(tier);
    wheres.push(`v.tier = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const pn = params.length;
    wheres.push(
      `(v.owner_name ILIKE $${pn} OR v.situs ILIKE $${pn} OR v.geo_id ILIKE $${pn})`
    );
  }

  const whereClause = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";

  let limitSql = "";
  if (limit != null) {
    params.push(limit);
    limitSql += ` LIMIT $${params.length}`;
    params.push(offset);
    limitSql += ` OFFSET $${params.length}`;
  }

  const { rows } = await client.query(
    `
    SELECT ${DETAIL_SELECT}
    FROM bcad_va_opportunities v
    ${DETAIL_JOINS}
    LEFT JOIN bcad_va_leads l ON l.bcad_property_id = v.bcad_property_id
    ${whereClause}
    ORDER BY v.score DESC, v.bcad_property_id
    ${limitSql}
    `,
    params
  );

  // Tier totals for the unclaimed pool (same shape as listVaOpportunities).
  const { rows: countRows } = await client.query(
    `
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE v.tier = 'hot')::int AS hot,
           COUNT(*) FILTER (WHERE v.tier = 'warm')::int AS warm,
           COUNT(*) FILTER (WHERE v.tier = 'watch')::int AS watch
    FROM bcad_va_opportunities v
    LEFT JOIN bcad_va_leads l ON l.bcad_property_id = v.bcad_property_id
    WHERE l.bcad_property_id IS NULL
    `
  );

  return {
    total: countRows[0],
    rows: rows.map(withDetailStatus),
    limit: limit ?? "all",
    offset,
  };
}

// ---------------------------------------------------------------------------
// My leads / all leads listing
// ---------------------------------------------------------------------------

/**
 * List leads joined to va_opportunities.
 *
 * opts.userId   — filter to this user (or omit for all)
 * opts.status   — filter by status string
 * opts.limit / opts.offset — pagination
 */
export async function listVaLeads(opts = {}) {
  const client = opts.client || bcadPool;
  const rawLimit = opts.limit;
  const wantAll =
    rawLimit == null ||
    rawLimit === "" ||
    String(rawLimit).toLowerCase() === "all";
  const limit = wantAll
    ? null
    : Math.min(Math.max(Number(rawLimit) || 100, 1), 100000);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const params = [];
  const wheres = [];

  if (opts.userId != null) {
    params.push(Number(opts.userId));
    wheres.push(`l.claimed_by_user_id = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    wheres.push(`l.status = $${params.length}`);
  }

  const whereClause = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";

  let limitSql = "";
  if (limit != null) {
    params.push(limit);
    limitSql += ` LIMIT $${params.length}`;
    params.push(offset);
    limitSql += ` OFFSET $${params.length}`;
  }

  const { rows } = await client.query(
    `
    SELECT l.*,
           v.geo_id, v.owner_name, v.situs, v.exemptions,
           v.has_dvhs, v.dv_codes, v.veteran_signal, v.mortgage_signal,
           v.score, v.tier, v.offer_hints, v.reasons,
           v.latest_tax_payer, v.latest_tax_paid_date,
           v.latest_dot_grantee, v.latest_dot_date,
           v.clerk_search_url, v.scored_at, v.enriched_at,
           appraisals.recent_appraisals,
           tax.tax_year AS tax_account_year,
           tax.year_amount_due,
           tax.total_amount_due,
           tax.last_payment_amount,
           tax.last_payer,
           tax.last_payment_date
    FROM bcad_va_leads l
    JOIN bcad_va_opportunities v ON v.bcad_property_id = l.bcad_property_id
    ${DETAIL_JOINS}
    ${whereClause}
    ORDER BY l.updated_at DESC, l.claimed_at DESC
    ${limitSql}
    `,
    params
  );

  const countParams = [...params].slice(0, params.length - (limit != null ? 2 : 0));
  const { rows: countRows } = await client.query(
    `
    SELECT COUNT(*)::int AS total
    FROM bcad_va_leads l
    JOIN bcad_va_opportunities v ON v.bcad_property_id = l.bcad_property_id
    ${whereClause}
    `,
    countParams
  );

  return {
    total: countRows[0].total,
    rows,
    limit: limit ?? "all",
    offset,
  };
}

// ---------------------------------------------------------------------------
// Notes helpers
// ---------------------------------------------------------------------------

export async function listVaLeadNotes(propertyId, client = bcadPool) {
  const { rows } = await client.query(
    `
    SELECT id, bcad_property_id, author_user_id, author_name, body, created_at
    FROM bcad_va_lead_notes
    WHERE bcad_property_id = $1
    ORDER BY created_at DESC
    `,
    [propertyId]
  );
  return rows;
}

export async function addVaLeadNote(propertyId, user, body, client = bcadPool) {
  const authorName = [user.firstName, user.lastName]
    .filter(Boolean)
    .join(" ")
    .trim() || user.email;
  const { rows } = await client.query(
    `
    INSERT INTO bcad_va_lead_notes
      (bcad_property_id, author_user_id, author_name, body)
    VALUES ($1, $2, $3, $4)
    RETURNING *
    `,
    [propertyId, user.id, authorName, String(body).trim()]
  );
  return rows[0];
}
