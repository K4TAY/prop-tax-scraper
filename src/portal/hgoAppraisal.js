import bcadPool from "./bcadDb.js";
import {
  hgoPropertyUrl,
  hgoPropertyDetailUrl,
  resolveHgoPropertyIdFromRow,
} from "./deeds.js";

export async function ensureHgoAppraisalSchema(client = bcadPool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS bcad_hgo_appraisals (
      bcad_property_id BIGINT PRIMARY KEY
        REFERENCES bcad_properties(id) ON DELETE CASCADE,
      geo_id TEXT,
      hgo_property_id TEXT NOT NULL,
      tax_year INTEGER NOT NULL,
      owner_name TEXT,
      owner_id TEXT,
      percent_ownership NUMERIC(12, 6),
      situs_address TEXT,
      legal_description TEXT,
      market_value NUMERIC(14, 2),
      appraised_value NUMERIC(14, 2),
      assessed_value NUMERIC(14, 2),
      land_hstd_value NUMERIC(14, 2),
      land_non_hstd_value NUMERIC(14, 2),
      imprv_hstd_value NUMERIC(14, 2),
      imprv_non_hstd_value NUMERIC(14, 2),
      ag_use_value NUMERIC(14, 2),
      ag_market NUMERIC(14, 2),
      ag_loss NUMERIC(14, 2),
      hs_cap_loss NUMERIC(14, 2),
      circuit_breaker_value NUMERIC(14, 2),
      estimated_taxes NUMERIC(14, 2),
      estimated_taxes_without_exemptions NUMERIC(14, 2),
      exemptions_summary TEXT,
      source_url TEXT,
      api_url TEXT,
      raw JSONB,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS bcad_hgo_appraisals_geo_idx
      ON bcad_hgo_appraisals (geo_id);
    CREATE INDEX IF NOT EXISTS bcad_hgo_appraisals_hgo_idx
      ON bcad_hgo_appraisals (hgo_property_id);

    CREATE TABLE IF NOT EXISTS bcad_hgo_exemptions (
      id BIGSERIAL PRIMARY KEY,
      bcad_property_id BIGINT NOT NULL
        REFERENCES bcad_properties(id) ON DELETE CASCADE,
      hgo_property_id TEXT NOT NULL,
      tax_year INTEGER NOT NULL,
      owner_id TEXT,
      exemption_type_code TEXT NOT NULL,
      qualify_year INTEGER,
      raw JSONB,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT bcad_hgo_exemptions_dedupe UNIQUE (
        bcad_property_id, tax_year, owner_id, exemption_type_code
      )
    );

    CREATE INDEX IF NOT EXISTS bcad_hgo_exemptions_property_idx
      ON bcad_hgo_exemptions (bcad_property_id);

    CREATE TABLE IF NOT EXISTS bcad_hgo_roll_history (
      id BIGSERIAL PRIMARY KEY,
      bcad_property_id BIGINT NOT NULL
        REFERENCES bcad_properties(id) ON DELETE CASCADE,
      hgo_property_id TEXT NOT NULL,
      tax_year INTEGER NOT NULL,
      improvement_value NUMERIC(14, 2),
      land_value NUMERIC(14, 2),
      market_value NUMERIC(14, 2),
      ag_use_value NUMERIC(14, 2),
      appraised_value NUMERIC(14, 2),
      assessed_value NUMERIC(14, 2),
      taxable_value NUMERIC(14, 2),
      homestead_cap NUMERIC(14, 2),
      circuit_breaker_cap NUMERIC(14, 2),
      raw JSONB,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT bcad_hgo_roll_history_dedupe UNIQUE (
        bcad_property_id, tax_year
      )
    );

    CREATE INDEX IF NOT EXISTS bcad_hgo_roll_history_property_idx
      ON bcad_hgo_roll_history (bcad_property_id);
  `);
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function blankToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export function summarizeExemptions(exemptions) {
  if (!Array.isArray(exemptions) || !exemptions.length) return null;
  return exemptions
    .map((e) => blankToNull(e.ExemptionTypeCode))
    .filter(Boolean)
    .join(", ");
}

export async function fetchHgoPropertyDetail(propertyId, year) {
  const api_url = hgoPropertyDetailUrl(propertyId, year);
  const res = await fetch(api_url, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (compatible; prop-tax-scraper/bcad-portal; +local)",
    },
  });
  if (!res.ok) {
    throw new Error(`HGO detail HTTP ${res.status} for propertyId=${propertyId}`);
  }
  return { api_url, detail: await res.json() };
}

export async function importHgoAppraisalForProperty(propertyId, opts = {}) {
  const client = opts.client || bcadPool;
  await ensureHgoAppraisalSchema(client);

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
  const { api_url, detail } = await fetchHgoPropertyDetail(hgoId, year);
  const values = detail.Values || {};
  const owner = detail.Owner || {};
  const tj = detail.TaxingJurisdictions || {};
  const exemptions = Array.isArray(detail.Exemptions) ? detail.Exemptions : [];
  const rollHistory = Array.isArray(detail.RollHistory) ? detail.RollHistory : [];
  const situs =
    blankToNull(detail.Location?.FullAddress)?.replace(/\r\n/g, "\n") || null;

  await client.query(
    `
    INSERT INTO bcad_hgo_appraisals (
      bcad_property_id, geo_id, hgo_property_id, tax_year,
      owner_name, owner_id, percent_ownership,
      situs_address, legal_description,
      market_value, appraised_value, assessed_value,
      land_hstd_value, land_non_hstd_value,
      imprv_hstd_value, imprv_non_hstd_value,
      ag_use_value, ag_market, ag_loss,
      hs_cap_loss, circuit_breaker_value,
      estimated_taxes, estimated_taxes_without_exemptions,
      exemptions_summary, source_url, api_url, raw, fetched_at
    ) VALUES (
      $1,$2,$3,$4,
      $5,$6,$7,
      $8,$9,
      $10,$11,$12,
      $13,$14,
      $15,$16,
      $17,$18,$19,
      $20,$21,
      $22,$23,
      $24,$25,$26,$27, NOW()
    )
    ON CONFLICT (bcad_property_id) DO UPDATE SET
      geo_id = EXCLUDED.geo_id,
      hgo_property_id = EXCLUDED.hgo_property_id,
      tax_year = EXCLUDED.tax_year,
      owner_name = EXCLUDED.owner_name,
      owner_id = EXCLUDED.owner_id,
      percent_ownership = EXCLUDED.percent_ownership,
      situs_address = EXCLUDED.situs_address,
      legal_description = EXCLUDED.legal_description,
      market_value = EXCLUDED.market_value,
      appraised_value = EXCLUDED.appraised_value,
      assessed_value = EXCLUDED.assessed_value,
      land_hstd_value = EXCLUDED.land_hstd_value,
      land_non_hstd_value = EXCLUDED.land_non_hstd_value,
      imprv_hstd_value = EXCLUDED.imprv_hstd_value,
      imprv_non_hstd_value = EXCLUDED.imprv_non_hstd_value,
      ag_use_value = EXCLUDED.ag_use_value,
      ag_market = EXCLUDED.ag_market,
      ag_loss = EXCLUDED.ag_loss,
      hs_cap_loss = EXCLUDED.hs_cap_loss,
      circuit_breaker_value = EXCLUDED.circuit_breaker_value,
      estimated_taxes = EXCLUDED.estimated_taxes,
      estimated_taxes_without_exemptions = EXCLUDED.estimated_taxes_without_exemptions,
      exemptions_summary = EXCLUDED.exemptions_summary,
      source_url = EXCLUDED.source_url,
      api_url = EXCLUDED.api_url,
      raw = EXCLUDED.raw,
      fetched_at = NOW()
    `,
    [
      prop.id,
      prop.geo_id || detail.GeoId || null,
      hgoId,
      year,
      blankToNull(owner.FullName),
      owner.OwnerId != null ? String(owner.OwnerId) : null,
      num(owner.PercentOwnership),
      situs,
      blankToNull(values.LegalDescription),
      num(values.Market),
      num(values.AppraisedValue),
      num(values.AssessedValue),
      num(values.LandHstdValue),
      num(values.LandNonHstdValue),
      num(values.ImprvHstdValue),
      num(values.ImprvNonHstdValue),
      num(values.AgUseValue),
      num(values.AgMarket),
      num(values.AgLoss),
      num(values.HsCapLoss),
      num(values.CircuitBreakerValue),
      num(tj.EstimatedTaxes),
      num(tj.EstimatedTaxesWithoutExemptions),
      summarizeExemptions(exemptions),
      source_url,
      api_url,
      JSON.stringify(detail),
    ]
  );

  // Replace exemptions for this year
  await client.query(
    `DELETE FROM bcad_hgo_exemptions WHERE bcad_property_id = $1 AND tax_year = $2`,
    [prop.id, year]
  );
  let exemptionsInserted = 0;
  for (const e of exemptions) {
    const code = blankToNull(e.ExemptionTypeCode);
    if (!code) continue;
    await client.query(
      `
      INSERT INTO bcad_hgo_exemptions (
        bcad_property_id, hgo_property_id, tax_year, owner_id,
        exemption_type_code, qualify_year, raw, fetched_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
      ON CONFLICT ON CONSTRAINT bcad_hgo_exemptions_dedupe DO UPDATE SET
        qualify_year = EXCLUDED.qualify_year,
        raw = EXCLUDED.raw,
        fetched_at = NOW()
      `,
      [
        prop.id,
        hgoId,
        year,
        e.OwnerId != null ? String(e.OwnerId) : null,
        code,
        e.QualifyYear != null ? Number(e.QualifyYear) : null,
        JSON.stringify(e),
      ]
    );
    exemptionsInserted++;
  }

  let rollUpserted = 0;
  for (const r of rollHistory) {
    const ry = r.Year != null ? Number(r.Year) : null;
    if (!ry) continue;
    await client.query(
      `
      INSERT INTO bcad_hgo_roll_history (
        bcad_property_id, hgo_property_id, tax_year,
        improvement_value, land_value, market_value, ag_use_value,
        appraised_value, assessed_value, taxable_value,
        homestead_cap, circuit_breaker_cap, raw, fetched_at
      ) VALUES (
        $1,$2,$3,
        $4,$5,$6,$7,
        $8,$9,$10,
        $11,$12,$13, NOW()
      )
      ON CONFLICT ON CONSTRAINT bcad_hgo_roll_history_dedupe DO UPDATE SET
        improvement_value = EXCLUDED.improvement_value,
        land_value = EXCLUDED.land_value,
        market_value = EXCLUDED.market_value,
        ag_use_value = EXCLUDED.ag_use_value,
        appraised_value = EXCLUDED.appraised_value,
        assessed_value = EXCLUDED.assessed_value,
        taxable_value = EXCLUDED.taxable_value,
        homestead_cap = EXCLUDED.homestead_cap,
        circuit_breaker_cap = EXCLUDED.circuit_breaker_cap,
        raw = EXCLUDED.raw,
        fetched_at = NOW()
      `,
      [
        prop.id,
        hgoId,
        ry,
        num(r.ImprovementValue),
        num(r.LandValue),
        num(r.MarketValue),
        num(r.AgUseValue),
        num(r.AppraisedValue),
        num(r.AssessedValue),
        num(r.TaxableValue),
        num(r.HomesteadCap),
        num(r.CircuitBreakerCap),
        JSON.stringify(r),
      ]
    );
    rollUpserted++;
  }

  return {
    bcad_property_id: Number(prop.id),
    geo_id: prop.geo_id,
    hgo_property_id: hgoId,
    tax_year: year,
    source_url,
    api_url,
    exemptions: exemptionsInserted,
    roll_years: rollUpserted,
    appraisal: await getHgoAppraisalForProperty(prop.id, client),
  };
}

export async function getHgoAppraisalForProperty(propertyId, client = bcadPool) {
  const { rows } = await client.query(
    `
    SELECT bcad_property_id, geo_id, hgo_property_id, tax_year,
           owner_name, owner_id, percent_ownership,
           situs_address, legal_description,
           market_value, appraised_value, assessed_value,
           land_hstd_value, land_non_hstd_value,
           imprv_hstd_value, imprv_non_hstd_value,
           ag_use_value, ag_market, ag_loss,
           hs_cap_loss, circuit_breaker_value,
           estimated_taxes, estimated_taxes_without_exemptions,
           exemptions_summary, source_url, api_url, fetched_at
    FROM bcad_hgo_appraisals
    WHERE bcad_property_id = $1
    `,
    [propertyId]
  );
  return rows[0] || null;
}

export async function listHgoExemptionsForProperty(propertyId, client = bcadPool) {
  const { rows } = await client.query(
    `
    SELECT id, tax_year, owner_id, exemption_type_code, qualify_year, fetched_at
    FROM bcad_hgo_exemptions
    WHERE bcad_property_id = $1
    ORDER BY tax_year DESC, exemption_type_code
    `,
    [propertyId]
  );
  return rows;
}

export async function listHgoRollHistoryForProperty(propertyId, client = bcadPool) {
  const { rows } = await client.query(
    `
    SELECT tax_year, improvement_value, land_value, market_value, ag_use_value,
           appraised_value, assessed_value, taxable_value,
           homestead_cap, circuit_breaker_cap, fetched_at
    FROM bcad_hgo_roll_history
    WHERE bcad_property_id = $1
    ORDER BY tax_year DESC
    `,
    [propertyId]
  );
  return rows;
}
