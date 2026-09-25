#!/usr/bin/env bun
/**
 * CLI wrapper around runBcadImport.
 *
 *   bun scripts/import-bcad-from-bucket.js
 *   bun scripts/import-bcad-from-bucket.js --force
 *   bun scripts/import-bcad-from-bucket.js --limit=5
 */
import dotenv from "dotenv";
import bcadPool from "../src/portal/bcadDb.js";
import { runBcadImport } from "../src/portal/bcadImport.js";

dotenv.config();

function parseArgs(argv) {
  const out = { force: false, limit: 0, hood: null };
  for (const a of argv) {
    if (a === "--force") out.force = true;
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice(8)) || 0;
    else if (a.startsWith("--hood=")) out.hood = String(a.slice(7)).trim();
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
try {
  const result = await runBcadImport({
    ...opts,
    onProgress: (p) => {
      if (p.phase === "hood_done" || p.phase === "hood_fail" || p.phase === "done") {
        console.log(p.message);
      } else if (p.phase === "index" || p.phase === "truncate") {
        console.log(p.message);
      } else if (p.phase === "hood") {
        process.stdout.write(`${p.message} `);
      }
    },
  });
  if (result.cancelled) {
    console.log("Cancelled.");
    process.exitCode = 130;
  } else if (result.failed > 0) {
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await bcadPool.end();
}
