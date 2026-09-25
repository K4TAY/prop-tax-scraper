import bcadPool from "./bcadDb.js";

/**
 * Normalize BCAD geo_id to ACT Tax account number (digits only, no dashes).
 * e.g. "04661-000-0350" → "046610000350"
 */
export function geoIdToCan(geoId) {
  return String(geoId || "").replace(/\D/g, "");
}

export function actTaxPaymentUrl(can, ownerNo = 0) {
  const c = geoIdToCan(can);
  if (!c) throw new Error("geo_id / can is required");
  return `https://bexar.acttax.com/act_webdev/bexar/reports/paymentinfo.jsp?can=${encodeURIComponent(c)}&ownerno=${encodeURIComponent(String(ownerNo))}`;
}

export function actTaxDetailUrl(can) {
  const c = geoIdToCan(can);
  if (!c) throw new Error("geo_id / can is required");
  return `https://bexar.acttax.com/act_webdev/bexar/showdetail2.jsp?can=${encodeURIComponent(c)}`;
}

export async function ensureTaxPaymentsSchema(client = bcadPool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS bcad_tax_payments (
      id BIGSERIAL PRIMARY KEY,
      bcad_property_id BIGINT NOT NULL
        REFERENCES bcad_properties(id) ON DELETE CASCADE,
      geo_id TEXT,
      can TEXT NOT NULL,
      paid_date DATE,
      roll_year TEXT,
      amount NUMERIC(14, 2),
      amount_raw TEXT,
      description TEXT,
      payer TEXT,
      source_url TEXT,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT bcad_tax_payments_dedupe UNIQUE (
        bcad_property_id, paid_date, roll_year, amount, description, payer
      )
    );

    CREATE INDEX IF NOT EXISTS bcad_tax_payments_property_idx
      ON bcad_tax_payments (bcad_property_id);
    CREATE INDEX IF NOT EXISTS bcad_tax_payments_can_idx
      ON bcad_tax_payments (can);
    CREATE INDEX IF NOT EXISTS bcad_tax_payments_geo_id_idx
      ON bcad_tax_payments (geo_id);

    -- One current ACT Tax office snapshot per property (showdetail2.jsp).
    -- Values may differ from BCAD appraisal fields on bcad_properties.
    CREATE TABLE IF NOT EXISTS bcad_tax_accounts (
      bcad_property_id BIGINT PRIMARY KEY
        REFERENCES bcad_properties(id) ON DELETE CASCADE,
      geo_id TEXT,
      can TEXT NOT NULL,
      owner_no INTEGER NOT NULL DEFAULT 0,
      tax_year INTEGER,
      account_number TEXT,
      mailing_owner_name TEXT,
      mailing_address TEXT,
      property_site_address TEXT,
      legal_description TEXT,
      year_tax_levy NUMERIC(14, 2),
      year_amount_due NUMERIC(14, 2),
      delinquent_after DATE,
      half_payment_amount NUMERIC(14, 2),
      half_payment_deadline TEXT,
      prior_years_amount_due NUMERIC(14, 2),
      total_amount_due NUMERIC(14, 2),
      last_payment_amount NUMERIC(14, 2),
      last_payer TEXT,
      last_payment_date DATE,
      has_active_deferral BOOLEAN,
      active_lawsuits TEXT,
      active_judgments TEXT,
      pending_payment_status TEXT,
      total_market_value NUMERIC(14, 2),
      land_value NUMERIC(14, 2),
      improvement_value NUMERIC(14, 2),
      capped_value NUMERIC(14, 2),
      agricultural_value NUMERIC(14, 2),
      exemptions TEXT,
      jurisdictions TEXT,
      trueautomation_map_url TEXT,
      trueautomation_prop_id TEXT,
      detail_source_url TEXT,
      payment_source_url TEXT,
      raw_labels JSONB,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS bcad_tax_accounts_can_idx
      ON bcad_tax_accounts (can);
    CREATE INDEX IF NOT EXISTS bcad_tax_accounts_geo_id_idx
      ON bcad_tax_accounts (geo_id);
  `);
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function parseAmount(raw) {
  const s = decodeHtml(raw);
  if (!s) return null;
  // First currency-looking token only (avoid swallowing years like "…$326.51 … 2025")
  const m = s.match(/\(?-?\$?\s*[\d,]+(?:\.\d{1,2})?\)?/);
  if (!m) return null;
  const token = m[0];
  const neg = /^\(.*\)$/.test(token) || token.trim().startsWith("-");
  const num = Number(token.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(num)) return null;
  return neg ? -num : num;
}

function parsePaidDate(raw) {
  const s = decodeHtml(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

function stripTagsKeepBreaks(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

/**
 * Parse ACT Tax paymentinfo.jsp HTML into payment rows.
 */
export function parseActTaxPaymentHtml(html) {
  const rows = [];
  const accountMatch =
    html.match(/Account\s*No\.?\s*:?\s*(?:&nbsp;|\s)*<\/?(?:b|strong|label|span)[^>]*>\s*([0-9]+)/i) ||
    html.match(/Account\s*No\.?\s*:?\s*(?:&nbsp;|\s)*([0-9]{8,})/i);
  const account_number = accountMatch ? accountMatch[1] : null;

  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  let match;
  while ((match = trRe.exec(html))) {
    const cells = [...match[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
      (m) => decodeHtml(m[1].replace(/<[^>]+>/g, ""))
    );
    if (cells.length < 5) continue;
    if (/date\s*paid/i.test(cells[0])) continue;
    const paid_date = parsePaidDate(cells[0]);
    if (!paid_date && !/^\d{4}/.test(cells[0])) continue;
    rows.push({
      paid_date,
      roll_year: cells[1] || null,
      amount_raw: cells[2] || null,
      amount: parseAmount(cells[2]),
      description: cells[3] || null,
      payer: cells[4] || null,
    });
  }
  return { account_number, payments: rows };
}

/**
 * Extract <label>…</label> → following text pairs from showdetail2.jsp.
 */
export function parseActTaxDetailLabels(html) {
  const labels = {};
  const re = /<label[^>]*>([\s\S]*?)<\/label>([\s\S]*?)(?=<label|<a\s|<\/td|<\/div>\s*<div|<\/td>)/gi;
  let m;
  while ((m = re.exec(html))) {
    const key = decodeHtml(m[1].replace(/<[^>]+>/g, ""));
    if (!key) continue;
    let val = decodeHtml(stripTagsKeepBreaks(m[2]));
    // drop trailing chrome like "Show Map"
    val = val.replace(/\bShow Map\b.*$/i, "").trim();
    if (!key || key.length > 120) continue;
    // Prefer first non-empty; keep later if richer
    if (!labels[key] || (val && val.length > String(labels[key]).length)) {
      labels[key] = val || null;
    }
  }
  return labels;
}

function labelValue(labels, ...patterns) {
  const entries = Object.entries(labels);
  for (const pat of patterns) {
    const re = typeof pat === "string" ? new RegExp(pat, "i") : pat;
    for (const [k, v] of entries) {
      if (re.test(k)) return { key: k, value: v };
    }
  }
  return { key: null, value: null };
}

/**
 * Parse showdetail2.jsp into a normalized account snapshot.
 */
export function parseActTaxDetailHtml(html) {
  const labels = parseActTaxDetailLabels(html);

  const taxYearBanner = html.match(
    /TAX INFORMATION FOR\s+(\d{4})/i
  );
  const levyLabel = labelValue(labels, /^\d{4}\s+Year Tax Levy/);
  const tax_year =
    (taxYearBanner && Number(taxYearBanner[1])) ||
    (levyLabel.key && Number((levyLabel.key.match(/^(\d{4})/) || [])[1])) ||
    null;

  const mailingRaw = labelValue(labels, /^Address:?$/).value;
  const mailingLines = mailingRaw
    ? mailingRaw.split(/\n+/).map((s) => s.trim()).filter(Boolean)
    : [];
  const mailing_owner_name = mailingLines[0] || null;
  const mailing_address = mailingLines.length
    ? mailingLines.join("\n")
    : null;

  const half = labelValue(labels, /Half Payment Option Amount/i);
  let half_payment_amount = null;
  let half_payment_deadline = null;
  if (half.value) {
    half_payment_amount = parseAmount(half.value);
    const dl = half.value.match(/Deadline\s+(.+)$/i);
    if (dl) half_payment_deadline = dl[1].trim();
  }

  const mapHref =
    (html.match(
      /href=["'](https?:\/\/bexar\.trueautomation\.com\/mapSearch\/[^"']+)["']/i
    ) || [])[1] || null;
  const trueautomation_prop_id = mapHref
    ? ((mapHref.match(/[?&]p=(\d+)/i) || [])[1] || null)
    : null;

  const has_active_deferral =
    /active deferral/i.test(html) ||
    Object.keys(labels).some((k) => /active deferral/i.test(k));

  const noneIfEmpty = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || /^none$/i.test(s)) return s || null;
    return s;
  };

  return {
    tax_year,
    account_number: labelValue(labels, /^Account Number/).value || null,
    mailing_owner_name,
    mailing_address,
    property_site_address:
      labelValue(labels, /^Property Site Address/).value || null,
    legal_description:
      labelValue(labels, /^Legal Description/).value || null,
    year_tax_levy: parseAmount(levyLabel.value),
    year_amount_due: parseAmount(
      labelValue(labels, /\d{4}\s+Year Amount Due/).value
    ),
    delinquent_after: parsePaidDate(
      labelValue(labels, /^Delinquent After/).value
    ),
    half_payment_amount,
    half_payment_deadline,
    prior_years_amount_due: parseAmount(
      labelValue(labels, /Prior Year/).value
    ),
    total_amount_due: parseAmount(
      labelValue(labels, /Total Amount Due/).value
    ),
    last_payment_amount: parseAmount(
      labelValue(labels, /Last Payment Amount/).value
    ),
    last_payer: labelValue(labels, /^Last Payer/).value || null,
    last_payment_date: parsePaidDate(
      labelValue(labels, /^Last Payment Date/).value
    ),
    has_active_deferral,
    active_lawsuits: noneIfEmpty(
      labelValue(labels, /^Active Lawsuits/).value
    ),
    active_judgments: noneIfEmpty(
      labelValue(labels, /^Active Judgments/).value
    ),
    pending_payment_status:
      labelValue(labels, /Pending Credit Card|eCheck Payments/i).value ||
      null,
    total_market_value: parseAmount(
      labelValue(labels, /^Total Market Value/).value
    ),
    land_value: parseAmount(labelValue(labels, /^Land Value/).value),
    improvement_value: parseAmount(
      labelValue(labels, /^Improvement Value/).value
    ),
    capped_value: parseAmount(labelValue(labels, /^Capped Value/).value),
    agricultural_value: parseAmount(
      labelValue(labels, /^Agricultural Value/).value
    ),
    exemptions: noneIfEmpty(
      labelValue(labels, /^Exemptions/).value
    ),
    jurisdictions: noneIfEmpty(
      labelValue(labels, /^Jurisdictions/).value
    ),
    trueautomation_map_url: mapHref,
    trueautomation_prop_id,
    raw_labels: labels,
  };
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent":
        "Mozilla/5.0 (compatible; prop-tax-scraper/bcad-portal; +local)",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`ACT Tax HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

export async function fetchActTaxPaymentHtml(can, { ownerNo = 0 } = {}) {
  const url = actTaxPaymentUrl(can, ownerNo);
  const html = await fetchHtml(url);
  if (
    !/Payment Information/i.test(html) &&
    !/Date\s*&nbsp;\s*Paid|Date\s*Paid/i.test(html)
  ) {
    throw new Error(`Unexpected ACT Tax payment page for can=${geoIdToCan(can)}`);
  }
  return { url, html };
}

export async function fetchActTaxDetailHtml(can) {
  const url = actTaxDetailUrl(can);
  const html = await fetchHtml(url);
  if (!/Account Number|Property Tax Balance/i.test(html)) {
    throw new Error(`Unexpected ACT Tax detail page for can=${geoIdToCan(can)}`);
  }
  return { url, html };
}

/**
 * Fetch + upsert payment history and showdetail2 account snapshot.
 */
export async function importTaxPaymentsForProperty(propertyId, opts = {}) {
  const client = opts.client || bcadPool;
  await ensureTaxPaymentsSchema(client);

  const { rows } = await client.query(
    `SELECT id, geo_id, pacs_prop_id FROM bcad_properties WHERE id = $1`,
    [propertyId]
  );
  if (!rows.length) throw new Error(`bcad_properties id=${propertyId} not found`);
  const prop = rows[0];
  const can = geoIdToCan(prop.geo_id);
  if (!can) throw new Error(`Property ${propertyId} has no usable geo_id`);
  const ownerNo = opts.ownerNo ?? 0;

  const [paymentPage, detailPage] = await Promise.all([
    fetchActTaxPaymentHtml(can, { ownerNo }),
    fetchActTaxDetailHtml(can),
  ]);

  const { account_number: paymentAccountNo, payments } =
    parseActTaxPaymentHtml(paymentPage.html);
  const account = parseActTaxDetailHtml(detailPage.html);

  await client.query(
    `
    INSERT INTO bcad_tax_accounts (
      bcad_property_id, geo_id, can, owner_no, tax_year,
      account_number, mailing_owner_name, mailing_address,
      property_site_address, legal_description,
      year_tax_levy, year_amount_due, delinquent_after,
      half_payment_amount, half_payment_deadline,
      prior_years_amount_due, total_amount_due,
      last_payment_amount, last_payer, last_payment_date,
      has_active_deferral, active_lawsuits, active_judgments,
      pending_payment_status,
      total_market_value, land_value, improvement_value,
      capped_value, agricultural_value,
      exemptions, jurisdictions,
      trueautomation_map_url, trueautomation_prop_id,
      detail_source_url, payment_source_url, raw_labels, fetched_at
    ) VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,
      $9,$10,
      $11,$12,$13,
      $14,$15,
      $16,$17,
      $18,$19,$20,
      $21,$22,$23,
      $24,
      $25,$26,$27,
      $28,$29,
      $30,$31,
      $32,$33,
      $34,$35,$36, NOW()
    )
    ON CONFLICT (bcad_property_id) DO UPDATE SET
      geo_id = EXCLUDED.geo_id,
      can = EXCLUDED.can,
      owner_no = EXCLUDED.owner_no,
      tax_year = EXCLUDED.tax_year,
      account_number = EXCLUDED.account_number,
      mailing_owner_name = EXCLUDED.mailing_owner_name,
      mailing_address = EXCLUDED.mailing_address,
      property_site_address = EXCLUDED.property_site_address,
      legal_description = EXCLUDED.legal_description,
      year_tax_levy = EXCLUDED.year_tax_levy,
      year_amount_due = EXCLUDED.year_amount_due,
      delinquent_after = EXCLUDED.delinquent_after,
      half_payment_amount = EXCLUDED.half_payment_amount,
      half_payment_deadline = EXCLUDED.half_payment_deadline,
      prior_years_amount_due = EXCLUDED.prior_years_amount_due,
      total_amount_due = EXCLUDED.total_amount_due,
      last_payment_amount = EXCLUDED.last_payment_amount,
      last_payer = EXCLUDED.last_payer,
      last_payment_date = EXCLUDED.last_payment_date,
      has_active_deferral = EXCLUDED.has_active_deferral,
      active_lawsuits = EXCLUDED.active_lawsuits,
      active_judgments = EXCLUDED.active_judgments,
      pending_payment_status = EXCLUDED.pending_payment_status,
      total_market_value = EXCLUDED.total_market_value,
      land_value = EXCLUDED.land_value,
      improvement_value = EXCLUDED.improvement_value,
      capped_value = EXCLUDED.capped_value,
      agricultural_value = EXCLUDED.agricultural_value,
      exemptions = EXCLUDED.exemptions,
      jurisdictions = EXCLUDED.jurisdictions,
      trueautomation_map_url = EXCLUDED.trueautomation_map_url,
      trueautomation_prop_id = EXCLUDED.trueautomation_prop_id,
      detail_source_url = EXCLUDED.detail_source_url,
      payment_source_url = EXCLUDED.payment_source_url,
      raw_labels = EXCLUDED.raw_labels,
      fetched_at = NOW()
    `,
    [
      prop.id,
      prop.geo_id,
      can,
      ownerNo,
      account.tax_year,
      account.account_number || paymentAccountNo || can,
      account.mailing_owner_name,
      account.mailing_address,
      account.property_site_address,
      account.legal_description,
      account.year_tax_levy,
      account.year_amount_due,
      account.delinquent_after,
      account.half_payment_amount,
      account.half_payment_deadline,
      account.prior_years_amount_due,
      account.total_amount_due,
      account.last_payment_amount,
      account.last_payer,
      account.last_payment_date,
      account.has_active_deferral,
      account.active_lawsuits,
      account.active_judgments,
      account.pending_payment_status,
      account.total_market_value,
      account.land_value,
      account.improvement_value,
      account.capped_value,
      account.agricultural_value,
      account.exemptions,
      account.jurisdictions,
      account.trueautomation_map_url,
      account.trueautomation_prop_id,
      detailPage.url,
      paymentPage.url,
      JSON.stringify(account.raw_labels),
    ]
  );

  let inserted = 0;
  let skipped = 0;
  for (const p of payments) {
    const r = await client.query(
      `
      INSERT INTO bcad_tax_payments (
        bcad_property_id, geo_id, can,
        paid_date, roll_year, amount, amount_raw,
        description, payer, source_url, fetched_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
      ON CONFLICT ON CONSTRAINT bcad_tax_payments_dedupe DO NOTHING
      RETURNING id
      `,
      [
        prop.id,
        prop.geo_id,
        can,
        p.paid_date,
        p.roll_year,
        p.amount,
        p.amount_raw,
        p.description,
        p.payer,
        paymentPage.url,
      ]
    );
    if (r.rowCount) inserted++;
    else skipped++;
  }

  const accountRow = await getTaxAccountForProperty(prop.id, client);

  return {
    bcad_property_id: Number(prop.id),
    geo_id: prop.geo_id,
    can,
    payment_url: paymentPage.url,
    detail_url: detailPage.url,
    account: accountRow,
    parsed: payments.length,
    inserted,
    skipped,
    payments,
  };
}

/**
 * Resolve property by geo_id (with or without dashes) and import payments.
 */
export async function importTaxPaymentsByGeoId(geoId, opts = {}) {
  const can = geoIdToCan(geoId);
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
    throw new Error(`No bcad_properties row for geo_id/can=${can}`);
  }
  return importTaxPaymentsForProperty(Number(rows[0].id), opts);
}

export async function getTaxAccountForProperty(propertyId, client = bcadPool) {
  const { rows } = await client.query(
    `SELECT * FROM bcad_tax_accounts WHERE bcad_property_id = $1`,
    [propertyId]
  );
  return rows[0] || null;
}

export async function listTaxPaymentsForProperty(propertyId, client = bcadPool) {
  const { rows } = await client.query(
    `
    SELECT id, bcad_property_id, geo_id, can, paid_date, roll_year,
           amount, amount_raw, description, payer, source_url, fetched_at
    FROM bcad_tax_payments
    WHERE bcad_property_id = $1
    ORDER BY paid_date DESC NULLS LAST, id DESC
    `,
    [propertyId]
  );
  return rows;
}
