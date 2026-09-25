import bcadPool from "./bcadDb.js";
import { getBcadParcelById } from "./bcadSchema.js";
import {
  importTaxPaymentsForProperty,
  listTaxPaymentsForProperty,
  getTaxAccountForProperty,
  ensureTaxPaymentsSchema,
} from "./taxPayments.js";
import {
  importDeedsForProperty,
  listDeedsForProperty,
  ensureDeedsSchema,
} from "./deeds.js";
import {
  importHgoAppraisalForProperty,
  getHgoAppraisalForProperty,
  listHgoExemptionsForProperty,
  listHgoRollHistoryForProperty,
  buildExemptionTimeline,
  ensureHgoAppraisalSchema,
} from "./hgoAppraisal.js";
import { listClerkInstrumentsForProperty } from "./clerkRecords.js";
import { getVaOpportunity } from "./vaOpportunities.js";

/**
 * Full property packet for the portal detail page.
 */
export async function getPropertyDetail(propertyId, client = bcadPool) {
  const parcel = await getBcadParcelById(propertyId, client);
  if (!parcel) return null;

  const [
    taxAccount,
    payments,
    deeds,
    appraisal,
    exemptions,
    rollHistory,
    clerkInstruments,
    vaOpportunity,
  ] = await Promise.all([
    getTaxAccountForProperty(propertyId, client),
    listTaxPaymentsForProperty(propertyId, client),
    listDeedsForProperty(propertyId, client),
    getHgoAppraisalForProperty(propertyId, client),
    listHgoExemptionsForProperty(propertyId, client),
    listHgoRollHistoryForProperty(propertyId, client),
    listClerkInstrumentsForProperty(propertyId, client),
    getVaOpportunity(propertyId, client),
  ]);

  // Don't ship huge raw_labels / raw blobs to the UI by default
  let taxAccountPublic = taxAccount;
  if (taxAccount && taxAccount.raw_labels) {
    const { raw_labels, ...rest } = taxAccount;
    taxAccountPublic = rest;
  }

  return {
    bcad_property_id: Number(propertyId),
    parcel,
    tax_account: taxAccountPublic,
    payments,
    deeds,
    hgo_appraisal: appraisal,
    hgo_exemptions: exemptions,
    hgo_exemption_timeline: buildExemptionTimeline(exemptions),
    hgo_roll_history: rollHistory,
    clerk_instruments: clerkInstruments,
    va_opportunity: vaOpportunity,
  };
}

/**
 * Refresh verified appraisal (HGO), tax office account + payments, and deeds.
 */
export async function refreshPropertySources(propertyId, opts = {}) {
  const client = opts.client || bcadPool;
  await ensureTaxPaymentsSchema(client);
  await ensureDeedsSchema(client);
  await ensureHgoAppraisalSchema(client);

  const year = opts.year || new Date().getFullYear();
  const errors = [];
  let tax = null;
  let deeds = null;
  let appraisal = null;

  try {
    tax = await importTaxPaymentsForProperty(propertyId, {
      client,
      ownerNo: opts.ownerNo ?? 0,
    });
  } catch (e) {
    errors.push({ source: "acttax", error: e.message });
  }

  try {
    deeds = await importDeedsForProperty(propertyId, { client, year });
  } catch (e) {
    errors.push({ source: "hgo_deeds", error: e.message });
  }

  try {
    appraisal = await importHgoAppraisalForProperty(propertyId, {
      client,
      year,
    });
  } catch (e) {
    errors.push({ source: "hgo_appraisal", error: e.message });
  }

  const detail = await getPropertyDetail(propertyId, client);
  return {
    ok: errors.length === 0,
    errors,
    tax: tax
      ? {
          parsed: tax.parsed,
          inserted: tax.inserted,
          skipped: tax.skipped,
          payment_url: tax.payment_url,
          detail_url: tax.detail_url,
        }
      : null,
    deeds: deeds
      ? {
          parsed: deeds.parsed,
          inserted: deeds.inserted,
          skipped: deeds.skipped,
          source_url: deeds.source_url,
        }
      : null,
    appraisal: appraisal
      ? {
          tax_year: appraisal.tax_year,
          exemptions: appraisal.exemptions,
          roll_years: appraisal.roll_years,
          years_fetched: appraisal.years_fetched,
          years: appraisal.years,
          year_errors: appraisal.year_errors,
          exemption_timeline: appraisal.exemption_timeline,
          source_url: appraisal.source_url,
        }
      : null,
    detail,
  };
}
