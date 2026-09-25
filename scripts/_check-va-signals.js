#!/usr/bin/env bun
/** One-off: inspect VA-ish tax payers / DOT grantees in BCAD DB. */
import bcadPool from "../src/portal/bcadDb.js";

const q = async (sql, params = []) => (await bcadPool.query(sql, params)).rows;

try {
  console.log("=== row counts ===");
  console.log(
    await q(`
    SELECT
      (SELECT COUNT(*)::int FROM bcad_tax_payments) AS tax_payments,
      (SELECT COUNT(*)::int FROM bcad_tax_payments WHERE payer IS NOT NULL) AS with_payer,
      (SELECT COUNT(*)::int FROM bcad_clerk_instruments) AS clerk_instruments,
      (SELECT COUNT(*)::int FROM bcad_clerk_instruments WHERE is_financing_related) AS financing,
      (SELECT COUNT(*)::int FROM bcad_va_opportunities) AS va_opps
  `)
  );

  console.log("\n=== tax payments: VA-ish payers ===");
  console.log(
    JSON.stringify(
      await q(`
      SELECT payer, COUNT(*)::int AS n,
             COUNT(DISTINCT bcad_property_id)::int AS props,
             MIN(paid_date)::text AS earliest,
             MAX(paid_date)::text AS latest
      FROM bcad_tax_payments
      WHERE payer IS NOT NULL
        AND payer ~* '(DEPARTMENT OF VETERANS|VETERANS AFFAIRS|\\yVA\\y.*LOAN|VA\\s*MORTGAGE|GNMA.*VA)'
      GROUP BY payer
      ORDER BY n DESC
      LIMIT 25
    `),
      null,
      2
    )
  );

  console.log("\n=== tax payments: top lender-like payers ===");
  console.log(
    JSON.stringify(
      await q(`
      SELECT payer, COUNT(*)::int AS n, COUNT(DISTINCT bcad_property_id)::int AS props
      FROM bcad_tax_payments
      WHERE payer IS NOT NULL
        AND description ILIKE 'Payment'
        AND payer ~* '(MORTGAGE|BANK|LOAN|SERVIC|NATIONSTAR|ROUNDPOINT|ROCKET|PENNYMAC|WELLS|FREEDOM|QUICKEN|USAA|NAVY|COOPER|CHASE|CITI|PNC|TRUIST)'
      GROUP BY payer
      ORDER BY n DESC
      LIMIT 15
    `),
      null,
      2
    )
  );

  console.log("\n=== clerk: VA-ish financing grantees ===");
  console.log(
    JSON.stringify(
      await q(`
      SELECT grantee, doc_type, COUNT(*)::int AS n,
             COUNT(DISTINCT bcad_property_id)::int AS props,
             MIN(recorded_date)::text AS earliest,
             MAX(recorded_date)::text AS latest
      FROM bcad_clerk_instruments
      WHERE is_financing_related
        AND grantee IS NOT NULL
        AND grantee ~* '(DEPARTMENT OF VETERANS|VETERANS AFFAIRS|\\yVA\\y.*LOAN|VA\\s*MORTGAGE|GNMA.*VA|SECRETARY OF VETERANS)'
      GROUP BY grantee, doc_type
      ORDER BY n DESC
      LIMIT 25
    `),
      null,
      2
    )
  );

  console.log("\n=== clerk: top Deed of Trust grantees ===");
  console.log(
    JSON.stringify(
      await q(`
      SELECT grantee, COUNT(*)::int AS n, COUNT(DISTINCT bcad_property_id)::int AS props
      FROM bcad_clerk_instruments
      WHERE is_financing_related
        AND doc_type ILIKE '%DEED OF TRUST%'
        AND grantee IS NOT NULL
      GROUP BY grantee
      ORDER BY n DESC
      LIMIT 15
    `),
      null,
      2
    )
  );

  console.log("\n=== VA opportunities: class breakdown ===");
  console.log(
    JSON.stringify(
      await q(`
      SELECT COALESCE(tax_payer_class, '(null)') AS tax_payer_class,
             COALESCE(mortgage_signal, '(null)') AS mortgage_signal,
             COUNT(*)::int AS n
      FROM bcad_va_opportunities
      GROUP BY 1, 2
      ORDER BY n DESC
      LIMIT 40
    `),
      null,
      2
    )
  );

  console.log("\n=== VA opps with VA-ish payer or DOT ===");
  console.log(
    JSON.stringify(
      await q(`
      SELECT bcad_property_id, tier, score, tax_payer_class, latest_tax_payer,
             latest_tax_paid_date::text, latest_dot_grantee, latest_dot_date::text,
             mortgage_signal
      FROM bcad_va_opportunities
      WHERE tax_payer_class = 'va_related'
         OR latest_tax_payer ~* '(VETERANS|\\yVA\\y)'
         OR latest_dot_grantee ~* '(VETERANS|\\yVA\\y|SECRETARY OF VETERANS)'
      ORDER BY score DESC NULLS LAST
      LIMIT 25
    `),
      null,
      2
    )
  );
} finally {
  await bcadPool.end();
}
