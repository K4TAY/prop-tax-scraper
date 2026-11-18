#!/usr/bin/env bun
/**
 * Geocode VA opportunity property addresses via self-hosted Nominatim.
 *
 * Default Nominatim: https://geocode.forteapps.dev
 * Override with NOMINATIM_URL.
 *
 *   bun scripts/geocode-va-opportunities.js
 *   bun scripts/geocode-va-opportunities.js --limit=50 --min-score=40
 *   bun scripts/geocode-va-opportunities.js --force --limit=10
 *   bun scripts/geocode-va-opportunities.js --id=645443
 *   bun scripts/geocode-va-opportunities.js --fallback-centroid
 *   bun scripts/geocode-va-opportunities.js --gap-seconds=1.2 --cooldown-hours=24
 *
 * Nominatim etiquette: keep --gap-seconds >= 1 unless you own the server
 * and intentionally raise throughput.
 */
import dotenv from "dotenv";
import bcadPool from "../src/portal/bcadDb.js";
import { ensureBcadSchema } from "../src/portal/bcadSchema.js";
import { ensureVaOpportunitiesSchema } from "../src/portal/vaOpportunities.js";
import {
  geocodePropertyById,
  geocodeVaOpportunities,
} from "../src/portal/geocode.js";

dotenv.config();

function parseArgs(argv) {
  const out = {
    limit: 100,
    minScore: 0,
    force: false,
    fallbackCentroid: false,
    gapSeconds: 1.1,
    cooldownHours: 24,
    id: null,
    dryRun: false,
  };
  for (const a of argv) {
    if (a.startsWith("--limit=")) out.limit = Number(a.slice(8));
    else if (a.startsWith("--min-score=")) out.minScore = Number(a.slice(12));
    else if (a === "--force") out.force = true;
    else if (a === "--fallback-centroid") out.fallbackCentroid = true;
    else if (a.startsWith("--gap-seconds=")) out.gapSeconds = Number(a.slice(14));
    else if (a.startsWith("--cooldown-hours="))
      out.cooldownHours = Number(a.slice(17));
    else if (a.startsWith("--id=")) out.id = Number(a.slice(5));
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base =
    process.env.NOMINATIM_URL || "https://geocode.forteapps.dev";

  log("VA geocode start", {
    nominatim: base,
    limit: args.limit,
    minScore: args.minScore,
    force: args.force,
    fallbackCentroid: args.fallbackCentroid,
    gapSeconds: args.gapSeconds,
    cooldownHours: args.cooldownHours,
    id: args.id,
  });

  await ensureBcadSchema(bcadPool);
  await ensureVaOpportunitiesSchema(bcadPool);

  if (args.id) {
    if (args.dryRun) {
      log("dry-run: would geocode property", args.id);
      return;
    }
    const out = await geocodePropertyById(args.id, {
      force: args.force,
      fallbackCentroid: args.fallbackCentroid,
      baseUrl: base,
    });
    log("done", out);
    return;
  }

  if (args.dryRun) {
    const { listVaOpportunitiesNeedingGeocode } = await import(
      "../src/portal/geocode.js"
    );
    const rows = await listVaOpportunitiesNeedingGeocode({
      limit: args.limit,
      minScore: args.minScore,
      force: args.force,
      cooldownHours: args.cooldownHours,
    });
    log(`dry-run: ${rows.length} properties would be geocoded`);
    for (const r of rows.slice(0, 20)) {
      console.log(
        `  #${r.id} score=${r.score} tier=${r.tier} status=${r.geocode_status || "—"} situs=${r.situs || "—"}`
      );
    }
    if (rows.length > 20) console.log(`  … +${rows.length - 20} more`);
    return;
  }

  const result = await geocodeVaOpportunities({
    limit: args.limit,
    minScore: args.minScore,
    force: args.force,
    fallbackCentroid: args.fallbackCentroid,
    gapSeconds: args.gapSeconds,
    cooldownHours: args.cooldownHours,
    baseUrl: base,
  });

  log("VA geocode complete", {
    queued: result.queued,
    ok: result.ok,
    not_found: result.not_found,
    error: result.error,
    skipped: result.skipped,
    centroid_fallback: result.centroid_fallback,
  });

  for (const r of result.rows.slice(0, 30)) {
    const label = r.skipped
      ? "skip"
      : r.status === "ok"
        ? "ok"
        : r.status;
    console.log(
      `  [${label}] #${r.id} ${r.lat != null ? `${r.lat.toFixed(5)},${r.lng.toFixed(5)}` : "—"} ${r.situs || ""}`
    );
  }
  if (result.rows.length > 30) {
    console.log(`  … +${result.rows.length - 30} more`);
  }
}

main()
  .catch((err) => {
    console.error("[geocode-va] fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await bcadPool.end().catch(() => {});
  });
