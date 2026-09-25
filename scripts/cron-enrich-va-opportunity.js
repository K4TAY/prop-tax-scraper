#!/usr/bin/env bun
/**
 * Railway cron: enrich ONE VA opportunity (score >= min) then exit.
 *
 * Picks the highest-scoring row that is least recently enriched
 * (enriched_at NULL first), runs full source refresh + rescore,
 * stamps enriched_at, then exits 0.
 *
 *   bun scripts/cron-enrich-va-opportunity.js
 *   bun scripts/cron-enrich-va-opportunity.js --min-score=50
 *
 * Railway: service cronSchedule = every 10 minutes UTC (five-field cron).
 */
import dotenv from "dotenv";
import bcadPool from "../src/portal/bcadDb.js";
import {
  ensureVaOpportunitiesSchema,
  upsertVaOpportunityForProperty,
} from "../src/portal/vaOpportunities.js";
import { refreshPropertySources } from "../src/portal/propertyDetail.js";

dotenv.config();

function parseArgs(argv) {
  const out = { minScore: 50 };
  for (const a of argv) {
    if (a.startsWith("--min-score=")) out.minScore = Number(a.slice(12));
  }
  return out;
}

function ts() {
  return new Date().toISOString();
}

function log(...parts) {
  console.log(`[${ts()}]`, ...parts);
}

async function pickNext(minScore) {
  const { rows } = await bcadPool.query(
    `
    SELECT bcad_property_id, score, tier, owner_name, situs, geo_id,
           enriched_at, mortgage_signal, latest_tax_payer
    FROM bcad_va_opportunities
    WHERE score >= $1
    ORDER BY enriched_at NULLS FIRST, score DESC, bcad_property_id
    LIMIT 1
    `,
    [minScore]
  );
  return rows[0] || null;
}

async function stampEnriched(propertyId) {
  await bcadPool.query(
    `
    UPDATE bcad_va_opportunities
    SET enriched_at = NOW()
    WHERE bcad_property_id = $1
    `,
    [propertyId]
  );
}

const opts = parseArgs(process.argv.slice(2));
const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 50;

try {
  log("VA enrich cron start", { minScore });
  await ensureVaOpportunitiesSchema(bcadPool);

  const candidate = await pickNext(minScore);
  if (!candidate) {
    log("No VA opportunities with score >=", minScore, "— nothing to do.");
    process.exitCode = 0;
  } else {
    const id = Number(candidate.bcad_property_id);
    log("Selected", {
      id,
      score: candidate.score,
      tier: candidate.tier,
      owner: candidate.owner_name,
      situs: candidate.situs,
      geo_id: candidate.geo_id,
      enriched_at: candidate.enriched_at,
      mortgage_signal: candidate.mortgage_signal,
    });

    const started = Date.now();
    const out = await refreshPropertySources(id, {
      onProgress(step, detail) {
        const extra =
          detail == null || detail === ""
            ? ""
            : typeof detail === "string"
              ? detail
              : JSON.stringify(detail);
        log(`  → ${step}${extra ? `: ${extra}` : ""}`);
      },
    });

    log("Rescoring…");
    const scored = await upsertVaOpportunityForProperty(id);
    await stampEnriched(id);

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    log("Done", {
      id,
      ok: out.ok,
      errors: (out.errors || []).map((e) => `${e.source}:${e.error}`),
      score_before: candidate.score,
      score_after: scored?.score,
      tier_after: scored?.tier,
      mortgage_signal: scored?.mortgage_signal,
      seconds: secs,
    });
    process.exitCode = out.ok ? 0 : 0; // still exit 0 so cron doesn't thrash; errors are logged
  }
} catch (e) {
  console.error(`[${ts()}] FATAL`, e);
  process.exitCode = 1;
} finally {
  await bcadPool.end();
}
