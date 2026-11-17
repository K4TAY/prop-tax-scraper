#!/usr/bin/env bun
/**
 * Railway cron: pull public records for VA opportunities that still need
 * DOT mortgage amounts and/or verified appraisals (so LTV can show), then exit.
 *
 * Priority queue (default --mode=gaps):
 *   1. Has Deed of Trust evidence but latest_dot_note_amount is null
 *   2. Missing verified HGO appraisal (roll history / appraisal table)
 *
 * Anti-thrash:
 *   - Skip rows enriched within --cooldown-hours (default 12)
 *   - Always stamp enriched_at after an attempt so the same id is not
 *     immediately re-selected on the next cron tick
 *   - Order by oldest enriched_at so retries rotate through the backlog
 *
 *   bun scripts/cron-enrich-va-opportunity.js
 *   bun scripts/cron-enrich-va-opportunity.js --mode=gaps --min-score=0 --limit=10 --gap-seconds=5 --cooldown-hours=12
 *   bun scripts/cron-enrich-va-opportunity.js --mode=legacy --min-score=50 --limit=5
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
  const out = {
    mode: "gaps",
    minScore: 0,
    limit: 10,
    gapSeconds: 5,
    cooldownHours: 12,
  };
  for (const a of argv) {
    if (a.startsWith("--mode=")) out.mode = String(a.slice(7) || "gaps").toLowerCase();
    else if (a.startsWith("--min-score=")) out.minScore = Number(a.slice(12));
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice(8));
    else if (a.startsWith("--gap-seconds=")) out.gapSeconds = Number(a.slice(14));
    else if (a.startsWith("--cooldown-hours=")) out.cooldownHours = Number(a.slice(17));
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

const HAS_DOT_SQL = `(
  NULLIF(TRIM(v.latest_dot_doc_number), '') IS NOT NULL
  OR NULLIF(TRIM(v.latest_dot_grantee), '') IS NOT NULL
)`;

const MISSING_DOT_AMOUNT_SQL = `(
  ${HAS_DOT_SQL}
  AND v.latest_dot_note_amount IS NULL
)`;

const HAS_APPRAISAL_SQL = `(
  EXISTS (
    SELECT 1 FROM bcad_hgo_roll_history rh
    WHERE rh.bcad_property_id = v.bcad_property_id
      AND rh.appraised_value IS NOT NULL
  )
  OR EXISTS (
    SELECT 1 FROM bcad_hgo_appraisals h
    WHERE h.bcad_property_id = v.bcad_property_id
      AND h.appraised_value IS NOT NULL
  )
)`;

const MISSING_APPRAISAL_SQL = `NOT ${HAS_APPRAISAL_SQL}`;

/** Needs pull: DOT with no filed amount, and/or no appraisal for LTV. */
const NEEDS_GAP_FILL_SQL = `(
  ${MISSING_DOT_AMOUNT_SQL}
  OR (${HAS_DOT_SQL} AND ${MISSING_APPRAISAL_SQL})
  OR (${MISSING_APPRAISAL_SQL} AND v.latest_dot_note_amount IS NOT NULL)
)`;

async function queueStats(minScore, cooldownHours) {
  const { rows } = await bcadPool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE ${MISSING_DOT_AMOUNT_SQL})::int AS missing_dot_amount,
      COUNT(*) FILTER (WHERE ${HAS_DOT_SQL} AND ${MISSING_APPRAISAL_SQL})::int AS has_dot_missing_appraisal,
      COUNT(*) FILTER (WHERE ${NEEDS_GAP_FILL_SQL})::int AS gap_total,
      COUNT(*) FILTER (
        WHERE ${NEEDS_GAP_FILL_SQL}
          AND (v.enriched_at IS NULL OR v.enriched_at < NOW() - ($2::text || ' hours')::interval)
      )::int AS gap_due_now
    FROM bcad_va_opportunities v
    WHERE v.score >= $1
    `,
    [minScore, String(cooldownHours)]
  );
  return rows[0] || {};
}

async function pickGapBatch(minScore, limit, cooldownHours) {
  const { rows } = await bcadPool.query(
    `
    SELECT
      v.bcad_property_id,
      v.score,
      v.tier,
      v.owner_name,
      v.situs,
      v.geo_id,
      v.enriched_at,
      v.mortgage_signal,
      v.latest_tax_payer,
      v.latest_dot_grantee,
      v.latest_dot_doc_number,
      v.latest_dot_note_amount,
      (${MISSING_DOT_AMOUNT_SQL}) AS needs_dot_amount,
      (${MISSING_APPRAISAL_SQL}) AS needs_appraisal
    FROM bcad_va_opportunities v
    WHERE v.score >= $1
      AND ${NEEDS_GAP_FILL_SQL}
      AND (
        v.enriched_at IS NULL
        OR v.enriched_at < NOW() - ($3::text || ' hours')::interval
      )
    ORDER BY
      CASE WHEN ${MISSING_DOT_AMOUNT_SQL} THEN 0 ELSE 1 END,
      CASE WHEN ${MISSING_APPRAISAL_SQL} THEN 0 ELSE 1 END,
      v.enriched_at ASC NULLS FIRST,
      v.score DESC,
      v.bcad_property_id
    LIMIT $2
    `,
    [minScore, limit, String(cooldownHours)]
  );
  return rows;
}

async function pickLegacyBatch(minScore, limit, cooldownHours) {
  const { rows } = await bcadPool.query(
    `
    SELECT bcad_property_id, score, tier, owner_name, situs, geo_id,
           enriched_at, mortgage_signal, latest_tax_payer,
           latest_dot_grantee, latest_dot_doc_number, latest_dot_note_amount,
           false AS needs_dot_amount,
           false AS needs_appraisal
    FROM bcad_va_opportunities v
    WHERE score >= $1
      AND (
        enriched_at IS NULL
        OR enriched_at < NOW() - ($3::text || ' hours')::interval
      )
    ORDER BY enriched_at ASC NULLS FIRST, score DESC, bcad_property_id
    LIMIT $2
    `,
    [minScore, limit, String(cooldownHours)]
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
    needs_dot_amount: candidate.needs_dot_amount,
    needs_appraisal: candidate.needs_appraisal,
    latest_dot_doc_number: candidate.latest_dot_doc_number,
    latest_dot_note_amount: candidate.latest_dot_note_amount,
    mortgage_signal: candidate.mortgage_signal,
  });

  const started = Date.now();
  let out = { ok: false, errors: [] };
  try {
    out = await refreshPropertySources(id, {
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
  } catch (e) {
    out = { ok: false, errors: [{ source: "refresh", error: e.message }] };
    log("  → refresh_fatal:", e.message);
  }

  log("Rescoring…");
  let scored = null;
  try {
    scored = await upsertVaOpportunityForProperty(id);
  } catch (e) {
    log("  → rescore_error:", e.message);
    out.errors = [...(out.errors || []), { source: "va_rescore", error: e.message }];
  }

  // Always stamp so this id rotates out of the "due now" set until cooldown elapses.
  await stampEnriched(id);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log("Done", {
    id,
    ok: out.ok,
    errors: (out.errors || []).map((e) => `${e.source}:${e.error}`),
    score_before: candidate.score,
    score_after: scored?.score,
    tier_after: scored?.tier,
    note_amount_after: scored?.latest_dot_note_amount ?? null,
    mortgage_signal: scored?.mortgage_signal,
    seconds: secs,
  });
  return out.ok;
}

const opts = parseArgs(process.argv.slice(2));
const mode = opts.mode === "legacy" ? "legacy" : "gaps";
const minScore = Number.isFinite(opts.minScore)
  ? opts.minScore
  : mode === "gaps"
    ? 0
    : 50;
const limit = Math.max(1, Math.min(50, Number.isFinite(opts.limit) ? opts.limit : 10));
const gapSeconds = Math.max(
  0,
  Number.isFinite(opts.gapSeconds) ? opts.gapSeconds : 5
);
const cooldownHours = Math.max(
  1,
  Number.isFinite(opts.cooldownHours) ? opts.cooldownHours : 12
);
const gapMs = Math.round(gapSeconds * 1000);

try {
  log("VA enrich cron start", { mode, minScore, limit, gapSeconds, cooldownHours });
  await ensureVaOpportunitiesSchema(bcadPool);

  if (mode === "gaps") {
    const stats = await queueStats(minScore, cooldownHours);
    log("Gap queue", stats);
  }

  const batch =
    mode === "gaps"
      ? await pickGapBatch(minScore, limit, cooldownHours)
      : await pickLegacyBatch(minScore, limit, cooldownHours);

  if (!batch.length) {
    log(
      mode === "gaps"
        ? "No due VA opportunities with DOT/appraisal gaps (or all still in cooldown)."
        : `No VA opportunities with score >= ${minScore} due for enrich.`
    );
    process.exitCode = 0;
  } else {
    log(
      `Enriching ${batch.length} opportunit${batch.length === 1 ? "y" : "ies"} sequentially (${mode})`
    );
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
      mode,
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
