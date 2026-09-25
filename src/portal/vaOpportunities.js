import bcadPool from "./bcadDb.js";
import { ensureClerkRecordsSchema } from "./clerkRecords.js";
import { ensureTaxPaymentsSchema } from "./taxPayments.js";

/**
 * VA loan marketing opportunity scoring from public records.
 *
 * Primary signal: BCAD exemption codes (DVHS / DV1–DV4) — public tax roll.
 * Enrichment: recent ACT Tax escrow payers + clerk Deeds of Trust.
 *
 * DVHS often zeroes the tax bill — a lender payment from years ago is not
 * evidence of an active mortgage. Hot requires fresh escrow and/or a
 * reasonably recent commercial Deed of Trust.
 */

const LENDER_PAYER_RE =
  /\b(MORTGAGE|MTGE|BANK|FEDERAL|CREDIT UNION|LOAN|FINANCIAL|SERVIC(?:E|ING|ES)|CORELOGIC|NATIONSTAR|ROUNDPOINT|ROCKET|PENNYMAC|WELLS\s*FARGO|FREEDOM|QUICKEN|LOANDEPOT|CARRINGTON|NEWREZ|FLAGSTAR|LEADERONE|USAA|NAVY\s*FEDERAL|MR\.?\s*COOPER|CHASE|CITI|PNC|TRUIST|US\s*BANK|REGIONS|CENTRAL\s*LOAN)\b/i;

const VA_LENDER_RE =
  /\b(DEPARTMENT OF VETERANS|VETERANS AFFAIRS|\bVA\b.*LOAN|VA\s*MORTGAGE|GNMA.*VA)\b/i;

/** Lender tax payment older than this does not count as active escrow. */
export const TAX_ESCROW_FRESH_YEARS = 2;
/** Commercial DOT older than this is historical only (not hot evidence). */
export const DOT_ACTIVE_YEARS = 10;

export async function ensureVaOpportunitiesSchema(client = bcadPool) {
  await ensureClerkRecordsSchema(client);
  await ensureTaxPaymentsSchema(client);

  await client.query(`
    CREATE TABLE IF NOT EXISTS bcad_va_opportunities (
      bcad_property_id BIGINT PRIMARY KEY
        REFERENCES bcad_properties(id) ON DELETE CASCADE,
      geo_id TEXT,
      owner_name TEXT,
      situs TEXT,
      exemptions TEXT,
      has_homestead BOOLEAN NOT NULL DEFAULT FALSE,
      has_dvhs BOOLEAN NOT NULL DEFAULT FALSE,
      dv_codes TEXT[],
      veteran_signal TEXT,
      latest_tax_payer TEXT,
      latest_tax_paid_date DATE,
      tax_payer_class TEXT,
      latest_dot_grantee TEXT,
      latest_dot_date DATE,
      latest_dot_doc_number TEXT,
      mortgage_signal TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'watch',
      offer_hints TEXT[],
      reasons TEXT[],
      clerk_search_url TEXT,
      scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE bcad_va_opportunities
      ADD COLUMN IF NOT EXISTS latest_tax_paid_date DATE;

    CREATE INDEX IF NOT EXISTS bcad_va_opportunities_score_idx
      ON bcad_va_opportunities (score DESC);
    CREATE INDEX IF NOT EXISTS bcad_va_opportunities_tier_idx
      ON bcad_va_opportunities (tier);
    CREATE INDEX IF NOT EXISTS bcad_va_opportunities_dvhs_idx
      ON bcad_va_opportunities (has_dvhs)
      WHERE has_dvhs;
  `);
}

export function parseExemptionFlags(exemptions) {
  const raw = String(exemptions || "").toUpperCase();
  const codes = raw
    .split(/[,;/|\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set(codes);
  const dv_codes = codes.filter((c) => /^DV(\d|HS)$/.test(c));
  return {
    codes,
    has_homestead: set.has("HS"),
    has_dvhs: set.has("DVHS"),
    has_dv1: set.has("DV1"),
    has_dv2: set.has("DV2"),
    has_dv3: set.has("DV3"),
    has_dv4: set.has("DV4"),
    dv_codes,
    has_any_dv: dv_codes.length > 0,
  };
}

function asIsoDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/** Calendar-year age from an ISO date (null → Infinity). */
export function yearsSince(isoDate, now = new Date()) {
  const iso = asIsoDate(isoDate);
  if (!iso) return Infinity;
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return Infinity;
  return (now.getTime() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
}

export function isWithinYears(isoDate, maxYears, now = new Date()) {
  return yearsSince(isoDate, now) <= maxYears;
}

export function classifyPayer(payer) {
  const p = String(payer || "").trim();
  if (!p) return "unknown";
  if (VA_LENDER_RE.test(p)) return "va_related";
  if (/TITLE/i.test(p)) return "title_company";
  if (LENDER_PAYER_RE.test(p)) return "commercial_lender_or_servicer";
  // heuristic: ALL CAPS person-like with few tokens
  const tokens = p.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/);
  if (tokens.length <= 4 && !/LLC|INC|CORP|LP|TRUST/i.test(p)) return "individual_or_owner";
  return "other_entity";
}

export function classifyDotGrantee(grantee) {
  const g = String(grantee || "").trim();
  if (!g) return "unknown";
  if (VA_LENDER_RE.test(g)) return "va_related";
  if (LENDER_PAYER_RE.test(g) || /MERS|ELECTRONIC REGISTRATION/i.test(g)) {
    return "commercial_lender_or_servicer";
  }
  if (/LLC|INC|CORP|LP|BANK|CREDIT|FINANCIAL|MORTGAGE/i.test(g)) return "commercial_lender_or_servicer";
  return "other_entity";
}

/**
 * Score one opportunity row (already assembled fields).
 * Pass latest_tax_paid_date + latest_dot_date so stale escrow/DOT do not inflate hot.
 */
export function scoreOpportunity(input) {
  let score = 0;
  const reasons = [];
  const offer_hints = [];
  const flags = input.flags || parseExemptionFlags(input.exemptions);
  const now = input.now instanceof Date ? input.now : new Date();
  const taxPaidIso = asIsoDate(input.latest_tax_paid_date);
  const dotDateIso = asIsoDate(input.latest_dot_date);
  const escrowFresh = isWithinYears(taxPaidIso, TAX_ESCROW_FRESH_YEARS, now);
  const dotActive = isWithinYears(dotDateIso, DOT_ACTIVE_YEARS, now);

  if (flags.has_dvhs) {
    score += 40;
    reasons.push("BCAD DVHS (100% disabled veteran homestead exemption)");
    offer_hints.push("funding_fee_exempt_candidate");
  } else if (flags.has_dv4) {
    score += 25;
    reasons.push("BCAD DV4 disabled-veteran exemption");
    offer_hints.push("funding_fee_exempt_candidate");
  } else if (flags.has_dv3) {
    score += 20;
    reasons.push("BCAD DV3 disabled-veteran exemption");
  } else if (flags.has_dv2) {
    score += 15;
    reasons.push("BCAD DV2 disabled-veteran exemption");
  } else if (flags.has_dv1) {
    score += 10;
    reasons.push("BCAD DV1 disabled-veteran exemption");
  }

  if (flags.has_homestead) {
    score += 10;
    reasons.push("Homestead exemption (likely primary residence)");
  }

  const payerClass = input.tax_payer_class || classifyPayer(input.latest_tax_payer);
  let freshEscrowEvidence = false;
  let freshVaEscrow = false;

  if (payerClass === "commercial_lender_or_servicer") {
    if (escrowFresh) {
      score += 18;
      freshEscrowEvidence = true;
      reasons.push(
        `Recent tax escrow by ${input.latest_tax_payer}` +
          (taxPaidIso ? ` (${taxPaidIso})` : "")
      );
      offer_hints.push("possible_active_mortgage");
    } else {
      score += 2;
      reasons.push(
        `Stale lender tax payer ${input.latest_tax_payer}` +
          (taxPaidIso ? ` last paid ${taxPaidIso}` : " (no paid date)") +
          ` — ignored for hot (need payment within ${TAX_ESCROW_FRESH_YEARS}y; DVHS often $0 thereafter)`
      );
      offer_hints.push("stale_escrow_ignored");
      if (flags.has_dvhs) offer_hints.push("zero_tax_expected_check_clerk_dot");
    }
  } else if (payerClass === "individual_or_owner" && flags.has_any_dv) {
    if (!taxPaidIso || escrowFresh) {
      score += 8;
      reasons.push(
        taxPaidIso
          ? `Owner/individual paid taxes recently (${taxPaidIso}) — no lender escrow`
          : "Owner/individual paying taxes (no lender escrow visible)"
      );
      offer_hints.push("cash_or_no_escrow_check");
    } else {
      score += 3;
      reasons.push(
        `Last owner tax payment ${taxPaidIso} is stale; DVHS parcels often show $0 thereafter`
      );
      offer_hints.push("cash_or_no_escrow_check");
    }
  } else if (payerClass === "va_related") {
    if (escrowFresh) {
      score += 5;
      freshVaEscrow = true;
      reasons.push(
        `Recent VA-related tax payer ${input.latest_tax_payer}` +
          (taxPaidIso ? ` (${taxPaidIso})` : "")
      );
      offer_hints.push("irrrl_check");
    } else {
      score += 1;
      reasons.push(
        `Stale VA-related tax payer ${input.latest_tax_payer}` +
          (taxPaidIso ? ` (${taxPaidIso})` : "")
      );
    }
  } else if (!input.latest_tax_payer && flags.has_any_dv) {
    reasons.push(
      "No tax payment rows on file — common for DVHS ($0 bill); use clerk DOT for mortgage evidence"
    );
    offer_hints.push("needs_tax_pull_or_clerk_dot");
  }

  const dotClass = input.dot_class || classifyDotGrantee(input.latest_dot_grantee);
  let freshCommercialDot = false;
  let freshVaDot = false;

  if (input.latest_dot_grantee) {
    if (dotClass === "commercial_lender_or_servicer") {
      if (dotActive) {
        score += 22;
        freshCommercialDot = true;
        reasons.push(
          `Recent Deed of Trust grantee: ${input.latest_dot_grantee}` +
            (dotDateIso ? ` (${dotDateIso})` : "")
        );
        offer_hints.push("conventional_or_nonva_lien_check");
        offer_hints.push("va_purchase_or_refi_benefit_review");
      } else {
        score += 6;
        reasons.push(
          `Historical Deed of Trust (${dotDateIso || "unknown date"}) to ${input.latest_dot_grantee}` +
            ` — older than ${DOT_ACTIVE_YEARS}y, not counted as active mortgage for hot`
        );
        offer_hints.push("stale_dot_verify_release");
      }
    } else if (dotClass === "va_related") {
      if (dotActive) {
        score += 12;
        freshVaDot = true;
        reasons.push(
          `Recent VA-related DOT: ${input.latest_dot_grantee}` +
            (dotDateIso ? ` (${dotDateIso})` : "")
        );
        offer_hints.push("irrrl_check");
      } else {
        score += 4;
        reasons.push(
          `Historical VA-related DOT (${dotDateIso || "unknown date"}) — verify status`
        );
        offer_hints.push("irrrl_check");
      }
    }
  } else if (flags.has_any_dv) {
    offer_hints.push("needs_clerk_dot_pull");
  }

  const hints = [...new Set(offer_hints)];

  let veteran_signal = "none";
  if (flags.has_dvhs) veteran_signal = "dvhs";
  else if (flags.has_any_dv) veteran_signal = "dv_partial";

  let mortgage_signal = "unknown";
  if (freshEscrowEvidence || freshCommercialDot) {
    mortgage_signal = "likely_nonva_or_serviced";
  } else if (freshVaEscrow || freshVaDot) {
    mortgage_signal = "likely_va";
  } else if (
    payerClass === "commercial_lender_or_servicer" ||
    (dotClass === "commercial_lender_or_servicer" && input.latest_dot_grantee)
  ) {
    mortgage_signal = "stale_financing_only";
  } else if (payerClass === "individual_or_owner") {
    mortgage_signal = "no_escrow_visible";
  } else if (!input.latest_tax_payer && !input.latest_dot_grantee) {
    mortgage_signal = "no_payment_history";
  }

  // Hot = DV* + fresh commercial mortgage evidence (recent escrow and/or recent DOT)
  let tier = "watch";
  const hasFreshMortgageEvidence = freshEscrowEvidence || freshCommercialDot;
  if (flags.has_any_dv && hasFreshMortgageEvidence && score >= 55) tier = "hot";
  else if (score >= 45 || (flags.has_dvhs && score >= 40)) tier = "warm";
  else if (score >= 20) tier = "watch";

  return {
    score,
    tier,
    reasons,
    offer_hints: hints,
    veteran_signal,
    mortgage_signal,
    tax_payer_class: payerClass,
    flags,
    escrow_fresh: escrowFresh && !!taxPaidIso,
    dot_active: dotActive && !!dotDateIso,
  };
}

/**
 * Rebuild opportunity rows for all DV* properties (or a limit).
 * Uses CAD exemptions + latest tax payer + latest matched clerk DOT.
 */
export async function rebuildVaOpportunities(opts = {}) {
  const client = opts.client || bcadPool;
  await ensureVaOpportunitiesSchema(client);

  const limit = opts.limit != null ? Number(opts.limit) : null;
  const onlyDv = opts.onlyDv !== false;

  const { rows: props } = await client.query(
    `
    SELECT
      p.id,
      p.geo_id,
      p.owner_name,
      p.situs,
      p.legal_desc,
      p.exemptions,
      pay.payer AS latest_tax_payer,
      pay.paid_date AS latest_tax_paid_date,
      dot.grantee AS latest_dot_grantee,
      dot.recorded_date AS latest_dot_date,
      dot.doc_number AS latest_dot_doc_number
    FROM bcad_properties p
    LEFT JOIN LATERAL (
      SELECT payer, paid_date
      FROM bcad_tax_payments t
      WHERE t.bcad_property_id = p.id
        AND t.description ILIKE 'Payment'
        AND t.payer IS NOT NULL
      ORDER BY t.paid_date DESC NULLS LAST, t.id DESC
      LIMIT 1
    ) pay ON TRUE
    LEFT JOIN LATERAL (
      SELECT grantee, recorded_date, doc_number
      FROM bcad_clerk_instruments c
      WHERE c.bcad_property_id = p.id
        AND c.is_financing_related
        AND c.doc_type ILIKE '%DEED OF TRUST%'
      ORDER BY c.recorded_date DESC NULLS LAST, c.id DESC
      LIMIT 1
    ) dot ON TRUE
    WHERE p.exemptions IS NOT NULL
      AND p.exemptions <> ''
      AND (
        $1::boolean = false
        OR p.exemptions ~* '(^|[,;\\s])DV(HS|[1-4])([,;\\s]|$)'
      )
    ORDER BY p.id
    ${limit ? `LIMIT ${Math.max(1, Math.min(limit, 500000))}` : ""}
    `,
    [onlyDv]
  );

  let upserted = 0;
  const tierCounts = { hot: 0, warm: 0, watch: 0 };
  const BATCH = 250;

  for (let i = 0; i < props.length; i += BATCH) {
    const chunk = props.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 1;

    for (const prop of chunk) {
      const flags = parseExemptionFlags(prop.exemptions);
      if (onlyDv && !flags.has_any_dv) continue;

  const scored = scoreOpportunity({
    exemptions: prop.exemptions,
    flags,
    latest_tax_payer: prop.latest_tax_payer,
    latest_tax_paid_date: asIsoDate(prop.latest_tax_paid_date),
    latest_dot_grantee: prop.latest_dot_grantee,
    latest_dot_date: asIsoDate(prop.latest_dot_date),
  });

      const party = String(prop.owner_name || "")
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .slice(0, 2)
        .join(" ");

      const clerkUrl = party
        ? `https://bexar.tx.publicsearch.us/results?department=RP&parties=${encodeURIComponent(
            JSON.stringify({
              parties: [{ term: party, types: ["grantor", "grantee"] }],
            })
          )}&recordedDateRange=18000101,20261231&searchType=advancedSearch`
        : null;

      values.push(
        `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},NOW())`
      );
      params.push(
        prop.id,
        prop.geo_id,
        prop.owner_name,
        prop.situs,
        prop.exemptions,
        flags.has_homestead,
        flags.has_dvhs,
        flags.dv_codes,
        scored.veteran_signal,
        prop.latest_tax_payer,
        asIsoDate(prop.latest_tax_paid_date),
        scored.tax_payer_class,
        prop.latest_dot_grantee,
        asIsoDate(prop.latest_dot_date),
        prop.latest_dot_doc_number,
        scored.mortgage_signal,
        scored.score,
        scored.tier,
        scored.offer_hints,
        scored.reasons,
        clerkUrl
      );
      upserted++;
      tierCounts[scored.tier] = (tierCounts[scored.tier] || 0) + 1;
    }

    if (!values.length) continue;

    await client.query(
      `
      INSERT INTO bcad_va_opportunities (
        bcad_property_id, geo_id, owner_name, situs, exemptions,
        has_homestead, has_dvhs, dv_codes, veteran_signal,
        latest_tax_payer, latest_tax_paid_date, tax_payer_class,
        latest_dot_grantee, latest_dot_date, latest_dot_doc_number,
        mortgage_signal, score, tier, offer_hints, reasons,
        clerk_search_url, scored_at
      ) VALUES ${values.join(",")}
      ON CONFLICT (bcad_property_id) DO UPDATE SET
        geo_id = EXCLUDED.geo_id,
        owner_name = EXCLUDED.owner_name,
        situs = EXCLUDED.situs,
        exemptions = EXCLUDED.exemptions,
        has_homestead = EXCLUDED.has_homestead,
        has_dvhs = EXCLUDED.has_dvhs,
        dv_codes = EXCLUDED.dv_codes,
        veteran_signal = EXCLUDED.veteran_signal,
        latest_tax_payer = EXCLUDED.latest_tax_payer,
        latest_tax_paid_date = EXCLUDED.latest_tax_paid_date,
        tax_payer_class = EXCLUDED.tax_payer_class,
        latest_dot_grantee = EXCLUDED.latest_dot_grantee,
        latest_dot_date = EXCLUDED.latest_dot_date,
        latest_dot_doc_number = EXCLUDED.latest_dot_doc_number,
        mortgage_signal = EXCLUDED.mortgage_signal,
        score = EXCLUDED.score,
        tier = EXCLUDED.tier,
        offer_hints = EXCLUDED.offer_hints,
        reasons = EXCLUDED.reasons,
        clerk_search_url = EXCLUDED.clerk_search_url,
        scored_at = NOW()
      `,
      params
    );

    if ((i / BATCH) % 20 === 0 && i > 0) {
      console.log(`[va] scored ${Math.min(i + BATCH, props.length)} / ${props.length}`);
    }
  }

  return {
    scanned: props.length,
    upserted,
    tierCounts,
  };
}

/**
 * Score + upsert a single property (any exemptions — useful for non-DV samples).
 */
export async function upsertVaOpportunityForProperty(propertyId, opts = {}) {
  const client = opts.client || bcadPool;
  await ensureVaOpportunitiesSchema(client);

  const { rows } = await client.query(
    `
    SELECT
      p.id,
      p.geo_id,
      p.owner_name,
      p.situs,
      p.legal_desc,
      p.exemptions,
      pay.payer AS latest_tax_payer,
      pay.paid_date AS latest_tax_paid_date,
      dot.grantee AS latest_dot_grantee,
      dot.recorded_date AS latest_dot_date,
      dot.doc_number AS latest_dot_doc_number
    FROM bcad_properties p
    LEFT JOIN LATERAL (
      SELECT payer, paid_date
      FROM bcad_tax_payments t
      WHERE t.bcad_property_id = p.id
        AND t.description ILIKE 'Payment'
        AND t.payer IS NOT NULL
      ORDER BY t.paid_date DESC NULLS LAST, t.id DESC
      LIMIT 1
    ) pay ON TRUE
    LEFT JOIN LATERAL (
      SELECT grantee, recorded_date, doc_number
      FROM bcad_clerk_instruments c
      WHERE c.bcad_property_id = p.id
        AND c.is_financing_related
        AND c.doc_type ILIKE '%DEED OF TRUST%'
      ORDER BY c.recorded_date DESC NULLS LAST, c.id DESC
      LIMIT 1
    ) dot ON TRUE
    WHERE p.id = $1
    `,
    [propertyId]
  );
  if (!rows.length) throw new Error(`property ${propertyId} not found`);
  const prop = rows[0];
  const flags = parseExemptionFlags(prop.exemptions);
  const scored = scoreOpportunity({
    exemptions: prop.exemptions,
    flags,
    latest_tax_payer: prop.latest_tax_payer,
    latest_tax_paid_date: asIsoDate(prop.latest_tax_paid_date),
    latest_dot_grantee: prop.latest_dot_grantee,
    latest_dot_date: asIsoDate(prop.latest_dot_date),
  });

  const party = String(prop.owner_name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");

  await client.query(
    `
    INSERT INTO bcad_va_opportunities (
      bcad_property_id, geo_id, owner_name, situs, exemptions,
      has_homestead, has_dvhs, dv_codes, veteran_signal,
      latest_tax_payer, latest_tax_paid_date, tax_payer_class,
      latest_dot_grantee, latest_dot_date, latest_dot_doc_number,
      mortgage_signal, score, tier, offer_hints, reasons,
      clerk_search_url, scored_at
    ) VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,$9,
      $10,$11,$12,
      $13,$14,$15,
      $16,$17,$18,$19,$20,
      $21, NOW()
    )
    ON CONFLICT (bcad_property_id) DO UPDATE SET
      geo_id = EXCLUDED.geo_id,
      owner_name = EXCLUDED.owner_name,
      situs = EXCLUDED.situs,
      exemptions = EXCLUDED.exemptions,
      has_homestead = EXCLUDED.has_homestead,
      has_dvhs = EXCLUDED.has_dvhs,
      dv_codes = EXCLUDED.dv_codes,
      veteran_signal = EXCLUDED.veteran_signal,
      latest_tax_payer = EXCLUDED.latest_tax_payer,
      latest_tax_paid_date = EXCLUDED.latest_tax_paid_date,
      tax_payer_class = EXCLUDED.tax_payer_class,
      latest_dot_grantee = EXCLUDED.latest_dot_grantee,
      latest_dot_date = EXCLUDED.latest_dot_date,
      latest_dot_doc_number = EXCLUDED.latest_dot_doc_number,
      mortgage_signal = EXCLUDED.mortgage_signal,
      score = EXCLUDED.score,
      tier = EXCLUDED.tier,
      offer_hints = EXCLUDED.offer_hints,
      reasons = EXCLUDED.reasons,
      clerk_search_url = EXCLUDED.clerk_search_url,
      scored_at = NOW()
    `,
    [
      prop.id,
      prop.geo_id,
      prop.owner_name,
      prop.situs,
      prop.exemptions,
      flags.has_homestead,
      flags.has_dvhs,
      flags.dv_codes,
      scored.veteran_signal,
      prop.latest_tax_payer,
      asIsoDate(prop.latest_tax_paid_date),
      scored.tax_payer_class,
      prop.latest_dot_grantee,
      asIsoDate(prop.latest_dot_date),
      prop.latest_dot_doc_number,
      scored.mortgage_signal,
      scored.score,
      scored.tier,
      scored.offer_hints,
      scored.reasons,
      party
        ? `https://bexar.tx.publicsearch.us/results?department=RP&parties=${encodeURIComponent(
            JSON.stringify({
              parties: [{ term: party, types: ["grantor", "grantee"] }],
            })
          )}&recordedDateRange=18000101,20261231&searchType=advancedSearch`
        : null,
    ]
  );

  return getVaOpportunity(propertyId, client);
}

export async function listVaOpportunities(opts = {}) {
  const client = opts.client || bcadPool;
  await ensureVaOpportunitiesSchema(client);
  const limit = Math.min(Number(opts.limit) || 100, 1000);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const tier = opts.tier || null;
  const minScore = opts.minScore != null ? Number(opts.minScore) : 0;

  const params = [minScore, limit, offset];
  let tierSql = "";
  if (tier) {
    params.push(tier);
    tierSql = ` AND tier = $${params.length}`;
  }

  const { rows } = await client.query(
    `
    SELECT *
    FROM bcad_va_opportunities
    WHERE score >= $1
      ${tierSql}
    ORDER BY score DESC, bcad_property_id
    LIMIT $2 OFFSET $3
    `,
    params
  );

  const { rows: countRows } = await client.query(
    `
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE tier = 'hot')::int AS hot,
           COUNT(*) FILTER (WHERE tier = 'warm')::int AS warm,
           COUNT(*) FILTER (WHERE tier = 'watch')::int AS watch
    FROM bcad_va_opportunities
    WHERE score >= $1
      ${tier ? "AND tier = $2" : ""}
    `,
    tier ? [minScore, tier] : [minScore]
  );

  return { total: countRows[0], rows };
}

export async function getVaOpportunity(propertyId, client = bcadPool) {
  const { rows } = await client.query(
    `SELECT * FROM bcad_va_opportunities WHERE bcad_property_id = $1`,
    [propertyId]
  );
  return rows[0] || null;
}
