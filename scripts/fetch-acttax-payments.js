#!/usr/bin/env bun
/**
 * Fetch Bexar ACT Tax account snapshot (showdetail2) + payment history for one property.
 *
 *   bun scripts/fetch-acttax-payments.js --geo=04661-000-0350
 *   bun scripts/fetch-acttax-payments.js --geo=046610000350
 *   bun scripts/fetch-acttax-payments.js --id=1001
 */
import dotenv from "dotenv";
import bcadPool from "../src/portal/bcadDb.js";
import {
  ensureTaxPaymentsSchema,
  importTaxPaymentsByGeoId,
  importTaxPaymentsForProperty,
  listTaxPaymentsForProperty,
  getTaxAccountForProperty,
} from "../src/portal/taxPayments.js";

dotenv.config();

function parseArgs(argv) {
  const out = { geo: null, id: null };
  for (const a of argv) {
    if (a.startsWith("--geo=")) out.geo = a.slice(6);
    else if (a.startsWith("--id=")) out.id = Number(a.slice(5));
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
try {
  await ensureTaxPaymentsSchema(bcadPool);
  let result;
  if (opts.id) {
    result = await importTaxPaymentsForProperty(opts.id);
  } else if (opts.geo) {
    result = await importTaxPaymentsByGeoId(opts.geo);
  } else {
    throw new Error("Pass --geo=… or --id=…");
  }
  const account = await getTaxAccountForProperty(result.bcad_property_id);
  const { raw_labels, ...accountPublic } = account || {};
  console.log({
    bcad_property_id: result.bcad_property_id,
    geo_id: result.geo_id,
    can: result.can,
    payment_url: result.payment_url,
    detail_url: result.detail_url,
    parsed: result.parsed,
    inserted: result.inserted,
    skipped: result.skipped,
    account: accountPublic,
    raw_label_keys: raw_labels ? Object.keys(raw_labels) : [],
  });
  const rows = await listTaxPaymentsForProperty(result.bcad_property_id);
  console.log("payments_stored", rows.length);
  console.log(rows.slice(0, 5));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await bcadPool.end();
}
