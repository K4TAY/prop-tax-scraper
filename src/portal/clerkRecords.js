import bcadPool from "./bcadDb.js";

/**
 * Bexar County Clerk (publicsearch.us) instrument storage + helpers.
 * Full search runs over their websocket UI; we store normalized rows and
 * build deep-links. HTML table import is supported when results are captured.
 */

export const CLERK_BASE = "https://bexar.tx.publicsearch.us";

/** Document types that matter for mortgage / VA opportunity research */
export const FINANCING_DOC_TYPES = new Set([
  "DEED OF TRUST",
  "DEED OF TRUST SECURED",
  "RELEASE",
  "RELEASE OF LIEN",
  "ASSIGNMENT",
  "ASSIGNMENT OF DEED OF TRUST",
  "MODIFICATION",
  "EXTENSION",
  "ASSUMPTION",
]);

export async function ensureClerkRecordsSchema(client = bcadPool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS bcad_clerk_instruments (
      id BIGSERIAL PRIMARY KEY,
      bcad_property_id BIGINT
        REFERENCES bcad_properties(id) ON DELETE SET NULL,
      geo_id TEXT,
      search_party TEXT,
      grantor TEXT,
      grantee TEXT,
      doc_type TEXT,
      recorded_date DATE,
      doc_number TEXT,
      book_volume_page TEXT,
      legal_description TEXT,
      lot TEXT,
      block TEXT,
      ncb TEXT,
      county_block TEXT,
      property_address TEXT,
      is_financing_related BOOLEAN NOT NULL DEFAULT FALSE,
      matched_property BOOLEAN NOT NULL DEFAULT FALSE,
      source_url TEXT,
      raw JSONB,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT bcad_clerk_instruments_dedupe UNIQUE (doc_number, doc_type, grantor, grantee)
    );

    CREATE INDEX IF NOT EXISTS bcad_clerk_instruments_property_idx
      ON bcad_clerk_instruments (bcad_property_id);
    CREATE INDEX IF NOT EXISTS bcad_clerk_instruments_party_idx
      ON bcad_clerk_instruments (search_party);
    CREATE INDEX IF NOT EXISTS bcad_clerk_instruments_doc_type_idx
      ON bcad_clerk_instruments (doc_type);
    CREATE INDEX IF NOT EXISTS bcad_clerk_instruments_ncb_idx
      ON bcad_clerk_instruments (ncb);
  `);
}

function blankToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /^n\/?a$/i.test(s) || s === "--/--/--") return null;
  return s;
}

function parseClerkDate(raw) {
  const s = blankToNull(raw);
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

export function clerkPartySearchUrl(partyName, opts = {}) {
  const term = String(partyName || "").trim();
  if (!term) throw new Error("party name required");
  const start = (opts.start || "18000101").replace(/\D/g, "");
  const end = (opts.end || new Date().toISOString().slice(0, 10).replace(/-/g, "")).replace(
    /\D/g,
    ""
  );
  const parties = JSON.stringify({
    parties: [{ term, types: ["grantor", "grantee"] }],
  });
  const params = new URLSearchParams({
    department: "RP",
    parties,
    recordedDateRange: `${start},${end}`,
    searchType: "advancedSearch",
  });
  if (opts.docTypes) params.set("docTypes", opts.docTypes);
  return `${CLERK_BASE}/results?${params.toString()}`;
}

/**
 * Normalize owner name for clerk party search: "FORTE KEVIN J" → "FORTE KEVIN"
 */
export function ownerToClerkParty(ownerName) {
  const parts = String(ownerName || "")
    .toUpperCase()
    .replace(/[^A-Z0-9& ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (parts.length >= 2) return `${parts[0]} ${parts[1]}`;
  return parts[0] || null;
}

/**
 * Parse NCB / block / lot hints from BCAD legal description.
 */
export function parseLegalHints(legalDesc) {
  const s = String(legalDesc || "").toUpperCase();
  const ncb = (s.match(/\bNCB\s+(\d+)/) || [])[1] || null;
  const block = (s.match(/\bBLOCK\s+(\d+[A-Z]?)/) || [])[1] || null;
  const lot = (s.match(/\bLOT\s+(\d+[A-Z]?)/) || [])[1] || null;
  return { ncb, block, lot };
}

export function isFinancingDocType(docType) {
  const t = String(docType || "").toUpperCase().trim();
  if (FINANCING_DOC_TYPES.has(t)) return true;
  return /DEED OF TRUST|RELEASE|ASSIGNMENT|MODIFICATION|ASSUMPTION|LIEN/.test(t);
}

/**
 * Parse results table text dumped from the publicsearch UI (tab/newline oriented).
 * Accepts array of row objects already shaped.
 */
export function normalizeClerkInstrument(row, meta = {}) {
  const doc_type = blankToNull(row.doc_type || row.docType);
  return {
    search_party: blankToNull(meta.search_party) || null,
    grantor: blankToNull(row.grantor),
    grantee: blankToNull(row.grantee),
    doc_type,
    recorded_date: parseClerkDate(row.recorded_date || row.recordedDate),
    doc_number: blankToNull(row.doc_number || row.docNumber),
    book_volume_page: blankToNull(row.book_volume_page || row.bookVolumePage),
    legal_description: blankToNull(row.legal_description || row.legalDescription),
    lot: blankToNull(row.lot),
    block: blankToNull(row.block),
    ncb: blankToNull(row.ncb),
    county_block: blankToNull(row.county_block || row.countyBlock),
    property_address: blankToNull(row.property_address || row.propertyAddress),
    is_financing_related: isFinancingDocType(doc_type),
    source_url: blankToNull(meta.source_url),
    raw: row,
  };
}

/**
 * Match an instrument to a property using NCB/lot/block or address tokens.
 */
export function instrumentMatchesProperty(inst, prop, legalHints) {
  const hints = legalHints || parseLegalHints(prop.legal_desc);
  if (inst.ncb && hints.ncb && String(inst.ncb) === String(hints.ncb)) {
    if (inst.lot && hints.lot && String(inst.lot) !== String(hints.lot)) return false;
    if (inst.block && hints.block && String(inst.block) !== String(hints.block)) {
      return false;
    }
    return true;
  }
  const situs = String(prop.situs || "").toUpperCase();
  const addr = String(inst.property_address || "").toUpperCase();
  if (situs && addr) {
    const streetNum = (situs.match(/^\s*(\d+)/) || [])[1];
    if (streetNum && addr.includes(streetNum)) {
      const street = situs.replace(/^\s*\d+\s+/, "").split(/SAN ANTONIO|BOERNE|,/)[0].trim();
      const token = street.split(/\s+/).slice(0, 2).join(" ");
      if (token && addr.includes(token)) return true;
    }
  }
  return false;
}

export async function upsertClerkInstruments(instruments, opts = {}) {
  const client = opts.client || bcadPool;
  await ensureClerkRecordsSchema(client);
  let inserted = 0;
  let skipped = 0;
  for (const inst of instruments) {
    const r = await client.query(
      `
      INSERT INTO bcad_clerk_instruments (
        bcad_property_id, geo_id, search_party,
        grantor, grantee, doc_type, recorded_date, doc_number,
        book_volume_page, legal_description, lot, block, ncb,
        county_block, property_address,
        is_financing_related, matched_property, source_url, raw, fetched_at
      ) VALUES (
        $1,$2,$3,
        $4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,
        $14,$15,
        $16,$17,$18,$19, NOW()
      )
      ON CONFLICT ON CONSTRAINT bcad_clerk_instruments_dedupe DO UPDATE SET
        bcad_property_id = COALESCE(EXCLUDED.bcad_property_id, bcad_clerk_instruments.bcad_property_id),
        geo_id = COALESCE(EXCLUDED.geo_id, bcad_clerk_instruments.geo_id),
        matched_property = EXCLUDED.matched_property OR bcad_clerk_instruments.matched_property,
        is_financing_related = EXCLUDED.is_financing_related,
        raw = EXCLUDED.raw,
        fetched_at = NOW()
      RETURNING (xmax = 0) AS is_insert
      `,
      [
        inst.bcad_property_id || null,
        inst.geo_id || null,
        inst.search_party,
        inst.grantor,
        inst.grantee,
        inst.doc_type,
        inst.recorded_date,
        inst.doc_number,
        inst.book_volume_page,
        inst.legal_description,
        inst.lot,
        inst.block,
        inst.ncb,
        inst.county_block,
        inst.property_address,
        !!inst.is_financing_related,
        !!inst.matched_property,
        inst.source_url,
        JSON.stringify(inst.raw || inst),
      ]
    );
    if (r.rows[0]?.is_insert) inserted++;
    else skipped++;
  }
  return { inserted, skipped, total: instruments.length };
}

export async function listClerkInstrumentsForProperty(propertyId, client = bcadPool) {
  const { rows } = await client.query(
    `
    SELECT *
    FROM bcad_clerk_instruments
    WHERE bcad_property_id = $1
    ORDER BY recorded_date DESC NULLS LAST, id DESC
    `,
    [propertyId]
  );
  return rows;
}

/**
 * Import a captured results payload (array of row objects) for one property.
 */
export async function importClerkResultsForProperty(propertyId, rows, opts = {}) {
  const client = opts.client || bcadPool;
  const { rows: props } = await client.query(
    `SELECT id, geo_id, owner_name, situs, legal_desc FROM bcad_properties WHERE id = $1`,
    [propertyId]
  );
  if (!props.length) throw new Error(`property ${propertyId} not found`);
  const prop = props[0];
  const party = opts.search_party || ownerToClerkParty(prop.owner_name);
  const source_url = opts.source_url || clerkPartySearchUrl(party);
  const hints = parseLegalHints(prop.legal_desc);
  const instruments = rows.map((row) => {
    const n = normalizeClerkInstrument(row, { search_party: party, source_url });
    const matched = instrumentMatchesProperty(n, prop, hints);
    return {
      ...n,
      bcad_property_id: matched || opts.forceMatch ? prop.id : null,
      geo_id: matched || opts.forceMatch ? prop.geo_id : null,
      matched_property: matched || !!opts.forceMatch,
    };
  });
  const result = await upsertClerkInstruments(instruments, { client });
  return { party, source_url, hints, ...result, instruments };
}
