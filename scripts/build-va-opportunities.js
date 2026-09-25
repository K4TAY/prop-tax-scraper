#!/usr/bin/env bun
/**
 * Build / refresh VA loan marketing opportunities from public records.
 *
 * Local (uses .env / local DB):
 *   bun scripts/build-va-opportunities.js --rebuild
 *   bun scripts/build-va-opportunities.js --list --tier=hot --limit=20
 *   bun scripts/build-va-opportunities.js --enrich --tier=hot --limit=50
 *   bun scripts/build-va-opportunities.js --id=645443 --fetch-tax
 *
 * Production (run from your Mac — executes inside Railway bcad-portal):
 *   railway ssh -s bcad-portal -- bun scripts/build-va-opportunities.js --enrich --tier=hot --limit=50
 *   railway ssh -s bcad-portal -- bun scripts/build-va-opportunities.js --rebuild --list --tier=hot --limit=20
 *
 * --enrich pulls HGO + ACT Tax + deeds + clerk financing for each listed
 * candidate, then re-scores that property (same as property-page Refresh).
 */
import dotenv from "dotenv";
import bcadPool from "../src/portal/bcadDb.js";
import {
  ensureVaOpportunitiesSchema,
  rebuildVaOpportunities,
  upsertVaOpportunityForProperty,
  listVaOpportunities,
} from "../src/portal/vaOpportunities.js";
import {
  ensureClerkRecordsSchema,
  importClerkResultsForProperty,
} from "../src/portal/clerkRecords.js";
import { importTaxPaymentsForProperty } from "../src/portal/taxPayments.js";
import { refreshPropertySources } from "../src/portal/propertyDetail.js";

dotenv.config();

function parseArgs(argv) {
  const out = {
    limit: null,
    rebuildLimit: null,
    id: null,
    list: false,
    rebuild: false,
    enrich: false,
    tier: null,
    minScore: 0,
    seedForte: false,
    fetchTax: false,
    allExemptions: false,
  };
  for (const a of argv) {
    if (a.startsWith("--limit=")) out.limit = Number(a.slice(8));
    else if (a.startsWith("--rebuild-limit=")) out.rebuildLimit = Number(a.slice(16));
    else if (a.startsWith("--id=")) out.id = Number(a.slice(5));
    else if (a === "--list") out.list = true;
    else if (a === "--rebuild") out.rebuild = true;
    else if (a === "--enrich") out.enrich = true;
    else if (a.startsWith("--tier=")) out.tier = a.slice(7);
    else if (a.startsWith("--min-score=")) out.minScore = Number(a.slice(12));
    else if (a === "--seed-forte") out.seedForte = true;
    else if (a === "--fetch-tax") out.fetchTax = true;
    else if (a === "--all") out.allExemptions = true;
  }
  // Default: rebuild + list when no specific action given
  if (
    !out.rebuild &&
    !out.list &&
    !out.id &&
    !out.seedForte &&
    !out.enrich
  ) {
    out.rebuild = true;
    out.list = true;
  }
  return out;
}

async function enrichCandidates(opts) {
  const limit = opts.limit != null ? opts.limit : 50;
  const listed = await listVaOpportunities({
    limit,
    tier: opts.tier,
    minScore: opts.minScore,
  });
  const rows = listed.rows || [];
  console.log("enrich_start", {
    requested: limit,
    found: rows.length,
    tier: opts.tier || "any",
    totals: listed.total,
  });
  if (!rows.length) {
    console.warn(
      "No VA candidates to enrich. Run --rebuild first so bcad_va_opportunities is populated."
    );
    return { ok: 0, failed: 0, skipped: 0 };
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const id = Number(r.bcad_property_id);
    const label = `[${i + 1}/${rows.length}] #${id} ${r.tier || "?"} ${String(r.owner_name || "").slice(0, 28)}`;
    process.stdout.write(`${label} … `);
    try {
      const out = await refreshPropertySources(id);
      // Always re-score after enrichment (refresh only rescores on clerk success).
      const scored = await upsertVaOpportunityForProperty(id);
      const errs = (out.errors || [])
        .map((e) => `${e.source}:${e.error}`)
        .join("; ");
      console.log(
        [
          out.ok ? "ok" : "partial",
          `score=${scored?.score}`,
          `tier=${scored?.tier}`,
          errs ? `errs=${errs}` : "",
        ]
          .filter(Boolean)
          .join(" ")
      );
      if (out.ok) ok += 1;
      else failed += 1;
    } catch (e) {
      failed += 1;
      console.log(`fail ${e.message}`);
    }
  }
  console.log("enrich_done", { ok, failed, total: rows.length });
  return { ok, failed, total: rows.length };
}

/** Captured Bexar clerk land-records hits for FORTE KEVIN @ 17711 Via Del Oro */
const FORTE_CLERK_ROWS = [
  {
    recorded_date: "06/15/2016",
    doc_type: "DEED",
    grantor: "MCQUEEN",
    grantee: "FORTE KEVIN J",
    doc_number: "20160112469",
    ncb: "17701",
    block: "15",
    lot: "32",
    property_address: "17711 VIA DEL ORO",
  },
  {
    recorded_date: "07/26/2016",
    doc_type: "DEED OF TRUST",
    grantor: "FORTE KEVIN J",
    grantee: "DIGIXSTREAM LLC",
    doc_number: "20160143875",
    ncb: "17701",
    block: "15",
    lot: "32",
    property_address: "17711 VIA DEL ORO",
  },
  {
    recorded_date: "01/19/2018",
    doc_type: "RELEASE",
    grantor: "DIGIXSTREAM LLC",
    grantee: "FORTE KEVIN J",
    doc_number: "20180010181",
    ncb: "17701",
    block: "15",
    lot: "32",
    property_address: "17711 VIA DEL ORO",
  },
  {
    recorded_date: "03/31/2020",
    doc_type: "DEED OF TRUST",
    grantor: "FORTE KEVIN J",
    grantee: "LEADERONE FINANCIAL CORPORATION",
    doc_number: "20200068140",
    ncb: "17701",
    block: "15",
    lot: "32",
    property_address: "17711 VIA DEL ORO",
  },
];

const FORTE_PROPERTY_ID = 645443;

async function seedForteClerk() {
  await ensureClerkRecordsSchema(bcadPool);
  const result = await importClerkResultsForProperty(
    FORTE_PROPERTY_ID,
    FORTE_CLERK_ROWS,
    {
      search_party: "FORTE KEVIN",
      forceMatch: true,
      financingOnly: false,
      source_url:
        "https://bexar.tx.publicsearch.us/results?department=RP&parties=%7B%22parties%22%3A%5B%7B%22term%22%3A%22FORTE%20KEVIN%22%2C%22types%22%3A%5B%22grantor%22%2C%22grantee%22%5D%7D%5D%7D&recordedDateRange=18000101%2C20261231&searchType=advancedSearch",
    }
  );
  console.log("seed_forte_clerk", {
    party: result.party,
    inserted: result.inserted,
    skipped: result.skipped,
    matched: result.instruments.filter((i) => i.matched_property).length,
  });
  return result;
}

async function maybeFetchTax(propertyId) {
  try {
    const tax = await importTaxPaymentsForProperty(propertyId);
    console.log("fetch_tax", {
      id: propertyId,
      can: tax.can,
      inserted: tax.inserted,
      skipped: tax.skipped,
    });
  } catch (e) {
    console.warn("fetch_tax_failed", e.message);
  }
}

const opts = parseArgs(process.argv.slice(2));

try {
  await ensureVaOpportunitiesSchema(bcadPool);

  if (opts.seedForte) {
    await seedForteClerk();
    if (opts.fetchTax) await maybeFetchTax(FORTE_PROPERTY_ID);
    const row = await upsertVaOpportunityForProperty(FORTE_PROPERTY_ID);
    console.log("forte_opportunity", {
      score: row.score,
      tier: row.tier,
      veteran_signal: row.veteran_signal,
      mortgage_signal: row.mortgage_signal,
      latest_tax_payer: row.latest_tax_payer,
      latest_dot_grantee: row.latest_dot_grantee,
      latest_dot_date: row.latest_dot_date,
      reasons: row.reasons,
      offer_hints: row.offer_hints,
    });
  }

  if (opts.id) {
    if (opts.fetchTax) await maybeFetchTax(opts.id);
    const row = await upsertVaOpportunityForProperty(opts.id);
    console.log("opportunity", {
      id: row.bcad_property_id,
      score: row.score,
      tier: row.tier,
      veteran_signal: row.veteran_signal,
      mortgage_signal: row.mortgage_signal,
      latest_tax_payer: row.latest_tax_payer,
      latest_dot_grantee: row.latest_dot_grantee,
      reasons: row.reasons,
      offer_hints: row.offer_hints,
    });
  }

  if (opts.rebuild) {
    // --limit is for list/enrich; use --rebuild-limit (or omit for all DV*)
    const rebuildLimit =
      opts.rebuildLimit != null
        ? opts.rebuildLimit
        : opts.list || opts.enrich
          ? null
          : opts.limit;
    console.log("rebuilding…", {
      onlyDv: !opts.allExemptions,
      limit: rebuildLimit,
    });
    const result = await rebuildVaOpportunities({
      limit: rebuildLimit,
      onlyDv: !opts.allExemptions,
    });
    console.log("rebuild", result);
  }

  if (opts.enrich) {
    await enrichCandidates(opts);
  }

  if (opts.list) {
    const listed = await listVaOpportunities({
      limit: opts.limit || 25,
      tier: opts.tier,
      minScore: opts.minScore,
    });
    console.log("summary", listed.total);
    for (const r of listed.rows) {
      console.log(
        [
          String(r.tier || "").padEnd(5),
          String(r.score).padStart(3),
          String(r.veteran_signal || "").padEnd(10),
          String(r.mortgage_signal || "").padEnd(24),
          String(r.geo_id || "").padEnd(18),
          String(r.owner_name || "").slice(0, 28).padEnd(28),
          String(r.situs || "").slice(0, 40),
        ].join(" ")
      );
    }
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await bcadPool.end();
}
