import bcadPool from "./bcadDb.js";

const HGO_BASE = "https://hgo.harrisgovern.com/bexar";

export function hgoPropertyUrl(propertyId, year = new Date().getFullYear()) {
  const id = String(propertyId || "").replace(/\D/g, "");
  if (!id) throw new Error("HGO propertyId is required");
  return `${HGO_BASE}/property/${year}-${id}`;
}

export function hgoDeedHistoryUrl(propertyId) {
  const id = String(propertyId || "").replace(/\D/g, "");
  if (!id) throw new Error("HGO propertyId is required");
  return `${HGO_BASE}/api/property/property-details/property-deed-history?propertyId=${encodeURIComponent(id)}`;
}

export function hgoPropertyDetailUrl(propertyId, year = new Date().getFullYear()) {
  const id = String(propertyId || "").replace(/\D/g, "");
  if (!id) throw new Error("HGO propertyId is required");
  return `${HGO_BASE}/api/property/property-details/property-detail-data?PropertyId=${encodeURIComponent(id)}&Year=${encodeURIComponent(String(year))}`;
}

export async function ensureDeedsSchema(client = bcadPool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS bcad_deeds (
      id BIGSERIAL PRIMARY KEY,
      bcad_property_id BIGINT NOT NULL
        REFERENCES bcad_properties(id) ON DELETE CASCADE,
      geo_id TEXT,
      hgo_property_id TEXT NOT NULL,
      seq_num INTEGER,
      deed_date DATE,
      deed_date_raw TEXT,
      deed_type_code TEXT,
      deed_type_desc TEXT,
      grantor TEXT,
      grantee TEXT,
      volume TEXT,
      page TEXT,
      instrument_number TEXT,
      source_url TEXT,
      api_url TEXT,
      raw JSONB,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS bcad_deeds_property_idx
      ON bcad_deeds (bcad_property_id);
    CREATE INDEX IF NOT EXISTS bcad_deeds_geo_id_idx
      ON bcad_deeds (geo_id);
    CREATE INDEX IF NOT EXISTS bcad_deeds_hgo_idx
      ON bcad_deeds (hgo_property_id);
    CREATE INDEX IF NOT EXISTS bcad_deeds_instrument_idx
      ON bcad_deeds (instrument_number);
  `);

  // Old UNIQUE allowed duplicates when volume/page (etc.) were NULL —
  // Postgres treats NULLs as distinct in UNIQUE constraints.
  await client.query(`
    ALTER TABLE bcad_deeds DROP CONSTRAINT IF EXISTS bcad_deeds_dedupe
  `);

  // Collapse any rows already duplicated by refresh.
  await client.query(`
    DELETE FROM bcad_deeds a
    USING bcad_deeds b
    WHERE a.id > b.id
      AND a.bcad_property_id = b.bcad_property_id
      AND a.seq_num IS NOT DISTINCT FROM b.seq_num
      AND a.deed_date IS NOT DISTINCT FROM b.deed_date
      AND a.deed_type_code IS NOT DISTINCT FROM b.deed_type_code
      AND a.grantor IS NOT DISTINCT FROM b.grantor
      AND a.grantee IS NOT DISTINCT FROM b.grantee
      AND a.volume IS NOT DISTINCT FROM b.volume
      AND a.page IS NOT DISTINCT FROM b.page
      AND a.instrument_number IS NOT DISTINCT FROM b.instrument_number
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS bcad_deeds_dedupe_uidx ON bcad_deeds (
      bcad_property_id,
      COALESCE(seq_num, -1),
      COALESCE(deed_date, DATE '0001-01-01'),
      COALESCE(deed_type_code, ''),
      COALESCE(grantor, ''),
      COALESCE(grantee, ''),
      COALESCE(volume, ''),
      COALESCE(page, ''),
      COALESCE(instrument_number, '')
    )
  `);
}

function blankToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parseDeedDate(raw) {
  const s = blankToNull(raw);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

/**
 * Normalize one HGO property-deed-history row.
 */
export function normalizeHgoDeed(row) {
  return {
    hgo_property_id: row.prop_id != null ? String(row.prop_id) : null,
    seq_num: row.seq_num == null ? null : Number(row.seq_num),
    deed_date: parseDeedDate(row.deed_dt),
    deed_date_raw: blankToNull(row.deed_dt),
    deed_type_code: blankToNull(row.deed_type_cd),
    deed_type_desc: blankToNull(row.deed_type_desc),
    grantor: blankToNull(row.grantor),
    grantee: blankToNull(row.grantee),
    volume: blankToNull(row.deed_book_id),
    page: blankToNull(row.deed_book_page),
    instrument_number: blankToNull(row.deed_num),
    raw: row,
  };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (compatible; prop-tax-scraper/bcad-portal; +local)",
    },
  });
  if (!res.ok) {
    throw new Error(`HGO HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

export async function fetchHgoDeedHistory(propertyId) {
  const api_url = hgoDeedHistoryUrl(propertyId);
  const data = await fetchJson(api_url);
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected HGO deed history payload for propertyId=${propertyId}`);
  }
  return {
    api_url,
    deeds: data.map(normalizeHgoDeed),
  };
}

export function resolveHgoPropertyIdFromRow(prop) {
  const blankToNull = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s : null;
  };
  return (
    blankToNull(prop.pacs_prop_id) ||
    blankToNull(prop.prop_id) ||
    blankToNull(prop.hgo_property_id) ||
    null
  );
}

/**
 * Fetch + upsert HGO deed history for one bcad_properties row.
 */
export async function importDeedsForProperty(propertyId, opts = {}) {
  const client = opts.client || bcadPool;
  await ensureDeedsSchema(client);

  const { rows } = await client.query(
    `SELECT id, geo_id, pacs_prop_id, prop_id FROM bcad_properties WHERE id = $1`,
    [propertyId]
  );
  if (!rows.length) throw new Error(`bcad_properties id=${propertyId} not found`);
  const prop = rows[0];
  const hgoId = resolveHgoPropertyIdFromRow(prop);
  if (!hgoId) {
    throw new Error(`Property ${propertyId} has no pacs_prop_id/prop_id for HGO`);
  }

  const year = opts.year || new Date().getFullYear();
  const source_url = hgoPropertyUrl(hgoId, year);
  const { api_url, deeds } = await fetchHgoDeedHistory(hgoId);

  // Full replace: prior UNIQUE allowed duplicates when volume/page were NULL.
  await client.query(`DELETE FROM bcad_deeds WHERE bcad_property_id = $1`, [
    prop.id,
  ]);

  let inserted = 0;
  for (const d of deeds) {
    await client.query(
      `
      INSERT INTO bcad_deeds (
        bcad_property_id, geo_id, hgo_property_id,
        seq_num, deed_date, deed_date_raw,
        deed_type_code, deed_type_desc,
        grantor, grantee, volume, page, instrument_number,
        source_url, api_url, raw, fetched_at
      ) VALUES (
        $1,$2,$3,
        $4,$5,$6,
        $7,$8,
        $9,$10,$11,$12,$13,
        $14,$15,$16, NOW()
      )
      `,
      [
        prop.id,
        prop.geo_id,
        hgoId,
        d.seq_num,
        d.deed_date,
        d.deed_date_raw,
        d.deed_type_code,
        d.deed_type_desc,
        d.grantor,
        d.grantee,
        d.volume,
        d.page,
        d.instrument_number,
        source_url,
        api_url,
        JSON.stringify(d.raw),
      ]
    );
    inserted++;
  }

  return {
    bcad_property_id: Number(prop.id),
    geo_id: prop.geo_id,
    hgo_property_id: hgoId,
    source_url,
    api_url,
    parsed: deeds.length,
    inserted,
    skipped: 0,
    deeds,
  };
}

export async function importDeedsByGeoId(geoId, opts = {}) {
  const can = String(geoId || "").replace(/\D/g, "");
  if (!can) throw new Error("geo_id is required");
  const client = opts.client || bcadPool;
  const { rows } = await client.query(
    `
    SELECT id FROM bcad_properties
    WHERE replace(COALESCE(geo_id, ''), '-', '') = $1
    ORDER BY id
    LIMIT 1
    `,
    [can]
  );
  if (!rows.length) {
    throw new Error(`No bcad_properties row for geo_id=${geoId}`);
  }
  return importDeedsForProperty(Number(rows[0].id), opts);
}

export async function listDeedsForProperty(propertyId, client = bcadPool) {
  const { rows } = await client.query(
    `
    SELECT id, bcad_property_id, geo_id, hgo_property_id,
           seq_num, deed_date, deed_date_raw,
           deed_type_code, deed_type_desc,
           grantor, grantee, volume, page, instrument_number,
           source_url, api_url, fetched_at
    FROM bcad_deeds
    WHERE bcad_property_id = $1
    ORDER BY seq_num DESC NULLS LAST, deed_date DESC NULLS LAST, id DESC
    `,
    [propertyId]
  );
  return rows;
}
