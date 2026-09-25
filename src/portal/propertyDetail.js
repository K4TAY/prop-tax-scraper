import bcadPool from "./bcadDb.js";
import { getBcadParcelById, getBcadParcelGeoById } from "./bcadSchema.js";
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
import {
  listClerkInstrumentsForProperty,
  prepareClerkFinancingForProperty,
  importClerkFinancingFromPublicsearch,
  ensureClerkRecordsSchema,
} from "./clerkRecords.js";
import { getVaOpportunity, upsertVaOpportunityForProperty } from "./vaOpportunities.js";

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
    parcelGeo,
  ] = await Promise.all([
    getTaxAccountForProperty(propertyId, client),
    listTaxPaymentsForProperty(propertyId, client),
    listDeedsForProperty(propertyId, client),
    getHgoAppraisalForProperty(propertyId, client),
    listHgoExemptionsForProperty(propertyId, client),
    listHgoRollHistoryForProperty(propertyId, client),
    listClerkInstrumentsForProperty(propertyId, client),
    getVaOpportunity(propertyId, client),
    getBcadParcelGeoById(propertyId, client),
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
    parcel_geo: parcelGeo,
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
 * Refresh verified appraisal (HGO), tax office account + payments, deeds,
 * and automated Bexar clerk financing pull (publicsearch WebSocket).
 * Paste UI remains as fallback when auto-pull fails.
 */
export async function refreshPropertySources(propertyId, opts = {}) {
  const client = opts.client || bcadPool;
  await ensureTaxPaymentsSchema(client);
  await ensureDeedsSchema(client);
  await ensureHgoAppraisalSchema(client);
  await ensureClerkRecordsSchema(client);

  const year = opts.year || new Date().getFullYear();
  const errors = [];
  let tax = null;
  let deeds = null;
  let appraisal = null;
  let clerk = null;

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

  try {
    clerk = await importClerkFinancingFromPublicsearch(propertyId, { client });
    if (clerk?.automated && clerk.inserted >= 0) {
      try {
        await upsertVaOpportunityForProperty(propertyId, { client });
      } catch (e) {
        errors.push({ source: "va_rescore", error: e.message });
      }
    }
    if (clerk?.auto_error) {
      errors.push({ source: "clerk_auto", error: clerk.auto_error });
    }
  } catch (e) {
    errors.push({ source: "clerk", error: e.message });
    try {
      clerk = await prepareClerkFinancingForProperty(propertyId, { client });
    } catch {
      /* ignore */
    }
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
    clerk,
    detail,
  };
}
