#!/usr/bin/env bun
/**
 * Railway cron: enrich the next N VA opportunities (score >= min) then exit.
 *
 * Picks the highest-scoring rows that are least recently enriched
 * (enriched_at NULL first), runs full source refresh + rescore for each
 * in sequence (never in parallel), waits between pulls, stamps enriched_at,
 * then exits 0.
 *
 *   bun scripts/cron-enrich-va-opportunity.js
 *   bun scripts/cron-enrich-va-opportunity.js --min-score=50 --limit=5 --gap-seconds=5
 *
 * Railway: service cronSchedule = every 5 minutes UTC (five-field cron).
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
  const out = { minScore: 50, limit: 5, gapSeconds: 5 };
  for (const a of argv) {
    if (a.startsWith("--min-score=")) out.minScore = Number(a.slice(12));
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice(8));
    else if (a.startsWith("--gap-seconds=")) out.gapSeconds = Number(a.slice(14));
  }
  return out;
}

function ts() {
  return new Date().toISOString();
}

function log(...parts) {
  console.log(`[${ts()}]`, ...parts);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pickNextBatch(minScore, limit) {
  const { rows } = await bcadPool.query(
    `
    SELECT bcad_property_id, score, tier, owner_name, situs, geo_id,
           enriched_at, mortgage_signal, latest_tax_payer
    FROM bcad_va_opportunities
    WHERE score >= $1
    ORDER BY enriched_at NULLS FIRST, score DESC, bcad_property_id
    LIMIT $2
    `,
    [minScore, limit]
  );
  return rows;
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

async function enrichOne(candidate, index, total) {
  const id = Number(candidate.bcad_property_id);
  log(`Selected ${index}/${total}`, {
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
  return out.ok;
}

const opts = parseArgs(process.argv.slice(2));
const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 50;
const limit = Math.max(1, Math.min(50, Number.isFinite(opts.limit) ? opts.limit : 5));
const gapSeconds = Math.max(
  0,
  Number.isFinite(opts.gapSeconds) ? opts.gapSeconds : 5
);
const gapMs = Math.round(gapSeconds * 1000);

try {
  log("VA enrich cron start", { minScore, limit, gapSeconds });
  await ensureVaOpportunitiesSchema(bcadPool);

  const batch = await pickNextBatch(minScore, limit);
  if (!batch.length) {
    log("No VA opportunities with score >=", minScore, "— nothing to do.");
    process.exitCode = 0;
  } else {
    log(`Enriching ${batch.length} opportunit${batch.length === 1 ? "y" : "ies"} sequentially`);
    let failures = 0;
    for (let i = 0; i < batch.length; i++) {
      const ok = await enrichOne(batch[i], i + 1, batch.length);
      if (!ok) failures += 1;
      if (i < batch.length - 1 && gapMs > 0) {
        log(`Waiting ${gapSeconds}s before next pull…`);
        await sleep(gapMs);
      }
    }
    log("Batch complete", {
      attempted: batch.length,
      failures,
    });
    // Exit 0 so cron doesn't thrash; per-row errors are logged above.
    process.exitCode = 0;
  }
} catch (e) {
  console.error(`[${ts()}] FATAL`, e);
  process.exitCode = 1;
} finally {
  await bcadPool.end();
}
