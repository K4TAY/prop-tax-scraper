import bcadPool from "./bcadDb.js";
import {
  hgoPropertyUrl,
  hgoPropertyDetailUrl,
  resolveHgoPropertyIdFromRow,
} from "./deeds.js";

/** How far back to walk when building the exemption year span. */
export const HGO_EXEMPTION_LOOKBACK_YEARS = 30;
const HGO_MIN_YEAR = 1990;

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function summarizeExemptions(exemptions) {
  if (!Array.isArray(exemptions) || !exemptions.length) return null;
  return exemptions
    .map((e) => blankToNull(e.ExemptionTypeCode))
    .filter(Boolean)
    .join(", ");
}

/**
 * Collapse per-year exemption rows into first/last-seen timeline per code (+ owner).
 * Helps spot codes that predate the current owner / deed.
 */
export function buildExemptionTimeline(rows) {
  const byKey = new Map();
  for (const r of rows || []) {
    const code = blankToNull(r.exemption_type_code);
    if (!code) continue;
    const taxYear = Number(r.tax_year);
    if (!Number.isFinite(taxYear)) continue;
    const ownerId = r.owner_id != null ? String(r.owner_id) : "";
    const key = `${code}::${ownerId}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        exemption_type_code: code,
        owner_id: ownerId || null,
        first_tax_year: taxYear,
        last_tax_year: taxYear,
        qualify_year: r.qualify_year != null ? Number(r.qualify_year) : null,
        years: [],
      };
      byKey.set(key, entry);
    }
    entry.first_tax_year = Math.min(entry.first_tax_year, taxYear);
    entry.last_tax_year = Math.max(entry.last_tax_year, taxYear);
    if (r.qualify_year != null) {
      const qy = Number(r.qualify_year);
      if (Number.isFinite(qy)) {
        entry.qualify_year =
          entry.qualify_year == null
            ? qy
            : Math.min(entry.qualify_year, qy);
      }
    }
    entry.years.push(taxYear);
  }

  return [...byKey.values()]
    .map((e) => {
      const years = [...new Set(e.years)].sort((a, b) => a - b);
      return {
        exemption_type_code: e.exemption_type_code,
        owner_id: e.owner_id,
        first_tax_year: e.first_tax_year,
        last_tax_year: e.last_tax_year,
        qualify_year: e.qualify_year,
        year_count: years.length,
        years,
      };
    })
    .sort(
      (a, b) =>
        a.first_tax_year - b.first_tax_year ||
        a.exemption_type_code.localeCompare(b.exemption_type_code)
    );
}

export async function fetchHgoPropertyDetail(propertyId, year, opts = {}) {
  const api_url = hgoPropertyDetailUrl(propertyId, year);
  const res = await fetch(api_url, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (compatible; prop-tax-scraper/bcad-portal; +local)",
    },
  });
  // HGO often returns 500 for tax years before the parcel existed — treat as empty.
  if (res.status === 404 || res.status === 500) {
    if (opts.allowMissing) {
      return { api_url, detail: null, missing: true, status: res.status };
    }
  }
  if (!res.ok) {
    throw new Error(
      `HGO detail HTTP ${res.status} for propertyId=${propertyId} year=${year}`
    );
  }
  return {
    api_url,
    detail: await res.json(),
    missing: false,
    status: res.status,
  };
}

function detailHasProperty(detail) {
  return detail && detail.PropertyId != null;
}

function yearsFromRollHistory(detail) {
  const years = [];
  for (const r of detail?.RollHistory || []) {
    const y = r?.Year != null ? Number(r.Year) : null;
    if (Number.isFinite(y)) years.push(y);
  }
  return years;
}

function qualifyYearsFromDetail(detail) {
  const years = [];
  for (const e of detail?.Exemptions || []) {
    const y = e?.QualifyYear != null ? Number(e.QualifyYear) : null;
    if (Number.isFinite(y)) years.push(y);
  }
  return years;
}

function floorYear(y, maxYear) {
  const lookbackFloor = maxYear - HGO_EXEMPTION_LOOKBACK_YEARS;
  return Math.max(HGO_MIN_YEAR, lookbackFloor, y);
}

/**
 * Choose which tax years to pull for exemption history.
 * Starts from seed response (roll history + qualify years), capped by lookback.
 */
export function resolveHgoYearsToFetch(opts = {}) {
  const now = new Date().getFullYear();
  const maxYear = Math.max(
    now + 1,
    ...(opts.seedYears || []),
    ...(opts.rollYears || []),
    opts.year != null ? Number(opts.year) : now
  );

  if (Array.isArray(opts.years) && opts.years.length) {
    return [...new Set(opts.years.map(Number).filter(Number.isFinite))]
      .filter((y) => y >= HGO_MIN_YEAR && y <= maxYear + 1)
      .sort((a, b) => b - a);
  }

  if (opts.year != null && opts.yearOnly) {
    return [Number(opts.year)];
  }

  const candidates = [
    ...(opts.seedYears || []),
    ...(opts.rollYears || []),
    ...(opts.qualifyYears || []),
  ]
    .map(Number)
    .filter(Number.isFinite);

  if (opts.year != null) candidates.push(Number(opts.year));
  if (!candidates.length) {
    candidates.push(now, now + 1);
  }

  let minYear = Math.min(...candidates);
  let resolvedMax = Math.max(...candidates, now);
  minYear = floorYear(minYear, resolvedMax);

  const out = [];
  for (let y = resolvedMax; y >= minYear; y--) out.push(y);
  return out;
}

async function upsertRollHistoryRows(client, prop, hgoId, rollHistory) {
  let rollUpserted = 0;
  for (const r of rollHistory || []) {
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
  return rollUpserted;
}

async function replaceExemptionsForYear(client, prop, hgoId, year, exemptions) {
  await client.query(
    `DELETE FROM bcad_hgo_exemptions WHERE bcad_property_id = $1 AND tax_year = $2`,
    [prop.id, year]
  );
  let inserted = 0;
  for (const e of exemptions || []) {
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
        e.OwnerId != null ? String(e.OwnerId) : "",
        code,
        e.QualifyYear != null ? Number(e.QualifyYear) : null,
        JSON.stringify(e),
      ]
    );
    inserted++;
  }
  return inserted;
}

async function upsertPrimaryAppraisal(client, prop, hgoId, year, detail, api_url) {
  const values = detail.Values || {};
  const owner = detail.Owner || {};
  const tj = detail.TaxingJurisdictions || {};
  const exemptions = Array.isArray(detail.Exemptions) ? detail.Exemptions : [];
  const situs =
    blankToNull(detail.Location?.FullAddress)?.replace(/\r\n/g, "\n") || null;
  const source_url = hgoPropertyUrl(hgoId, year);

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

  return source_url;
}

function scoreDetailForPrimary(year, detail) {
  const values = detail?.Values || {};
  const appraised = num(values.AppraisedValue);
  const market = num(values.Market);
  let score = year;
  if (appraised != null && appraised > 0) score += 1_000_000;
  else if (market != null && market > 0) score += 500_000;
  if ((detail?.Exemptions || []).length) score += 1_000;
  return score;
}

/**
 * Import HGO appraisal + year-by-year exemption classifications.
 *
 * opts.year — preferred primary display year (also forces inclusion)
 * opts.years — explicit year list
 * opts.yearOnly — if true with opts.year, skip multi-year walk
 * opts.lookbackYears — override default lookback cap
 * opts.throttleMs — pause between year fetches (default 40)
 */
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

  const now = new Date().getFullYear();
  const preferredYear =
    opts.year != null ? Number(opts.year) : now;
  const throttleMs = Math.max(0, Number(opts.throttleMs ?? 40) || 0);

  // Seed with preferred year, then current+1 (prelim) if different.
  const seedOrder = [...new Set([preferredYear, now + 1, now])].filter(
    (y) => Number.isFinite(y)
  );

  const cache = new Map();
  let seedDetail = null;
  let seedYear = preferredYear;
  let seedApiUrl = null;

  for (const y of seedOrder) {
    const packed = await fetchHgoPropertyDetail(hgoId, y, {
      allowMissing: true,
    });
    cache.set(y, packed);
    if (!packed.missing && detailHasProperty(packed.detail)) {
      seedDetail = packed.detail;
      seedYear = y;
      seedApiUrl = packed.api_url;
      break;
    }
  }

  if (!seedDetail) {
    throw new Error(
      `HGO returned no property detail for ${hgoId} (tried ${seedOrder.join(", ")})`
    );
  }

  const rollYears = yearsFromRollHistory(seedDetail);
  const qualifyYears = qualifyYearsFromDetail(seedDetail);
  let years = resolveHgoYearsToFetch({
    year: opts.year,
    years: opts.years,
    yearOnly: opts.yearOnly,
    seedYears: [seedYear, ...seedOrder],
    rollYears,
    qualifyYears,
  });

  // If a later year reveals an earlier QualifyYear, extend once.
  const lookback =
    opts.lookbackYears != null
      ? Number(opts.lookbackYears)
      : HGO_EXEMPTION_LOOKBACK_YEARS;

  let exemptionsInserted = 0;
  let rollUpserted = 0;
  let yearsFetched = 0;
  const yearErrors = [];
  const fetchedYears = [];

  async function ingestYear(year) {
    let packed = cache.get(year);
    if (!packed) {
      if (throttleMs && yearsFetched > 0) await sleep(throttleMs);
      try {
        packed = await fetchHgoPropertyDetail(hgoId, year, {
          allowMissing: true,
        });
      } catch (e) {
        yearErrors.push({ year, error: e.message });
        return { ok: false, missing: false };
      }
      cache.set(year, packed);
    }
    const { detail, missing } = packed;
    if (missing || !detailHasProperty(detail)) {
      return { ok: false, missing: true };
    }

    yearsFetched++;
    fetchedYears.push(year);
    exemptionsInserted += await replaceExemptionsForYear(
      client,
      prop,
      hgoId,
      year,
      detail.Exemptions
    );
    rollUpserted += await upsertRollHistoryRows(
      client,
      prop,
      hgoId,
      detail.RollHistory
    );

    for (const qy of qualifyYearsFromDetail(detail)) {
      if (!qualifyYears.includes(qy)) qualifyYears.push(qy);
    }
    return { ok: true, detail };
  }

  // Newest → oldest. After we have data, stop after several consecutive
  // missing years (parcel typically did not exist yet).
  let consecutiveMissing = 0;
  for (const year of years) {
    const result = await ingestYear(year);
    if (result?.ok) {
      consecutiveMissing = 0;
    } else if (result?.missing && yearsFetched > 0) {
      consecutiveMissing++;
      if (consecutiveMissing >= 3) break;
    }
  }

  // Extend backward if qualify years sit below the span we fetched
  const maxFetched = fetchedYears.length ? Math.max(...fetchedYears) : seedYear;
  const earliestQualify = qualifyYears.length
    ? Math.min(...qualifyYears)
    : null;
  if (earliestQualify != null) {
    const floor = Math.max(
      HGO_MIN_YEAR,
      maxFetched - lookback,
      earliestQualify
    );
    const minFetched = fetchedYears.length
      ? Math.min(...fetchedYears)
      : seedYear;
    if (floor < minFetched) {
      consecutiveMissing = 0;
      for (let y = minFetched - 1; y >= floor; y--) {
        const result = await ingestYear(y);
        if (result?.ok) {
          consecutiveMissing = 0;
        } else if (result?.missing) {
          consecutiveMissing++;
          if (consecutiveMissing >= 3) break;
        }
      }
    }
  }

  // Primary snapshot: preferred year if it has values, else best scored year
  let primaryYear = seedYear;
  let primary = cache.get(seedYear);
  let bestScore = -Infinity;
  for (const [y, packed] of cache.entries()) {
    if (!detailHasProperty(packed.detail)) continue;
    const score = scoreDetailForPrimary(y, packed.detail);
    const preferredBoost =
      opts.year != null && Number(opts.year) === y ? 5_000_000 : 0;
    const total = score + preferredBoost;
    if (total > bestScore) {
      bestScore = total;
      primaryYear = y;
      primary = packed;
    }
  }

  const source_url = await upsertPrimaryAppraisal(
    client,
    prop,
    hgoId,
    primaryYear,
    primary.detail,
    primary.api_url || seedApiUrl
  );

  const exemptionRows = await listHgoExemptionsForProperty(prop.id, client);
  const timeline = buildExemptionTimeline(exemptionRows);

  return {
    bcad_property_id: Number(prop.id),
    geo_id: prop.geo_id,
    hgo_property_id: hgoId,
    tax_year: primaryYear,
    source_url,
    api_url: primary.api_url,
    exemptions: exemptionsInserted,
    roll_years: rollUpserted,
    years_fetched: yearsFetched,
    years: fetchedYears.sort((a, b) => b - a),
    year_errors: yearErrors,
    exemption_timeline: timeline,
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
