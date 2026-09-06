import { existsSync } from "fs";
import { mkdir, readdir, rename } from "fs/promises";
import { join } from "path";
import { resolveCounty } from "./county.js";

function isImportSidecar(name) {
  return (
    name.endsWith(".csv") ||
    name.endsWith(".meta.json") ||
    name.endsWith(".OVER_1000")
  );
}

/**
 * Move scraped CSV sidecars from processed/ back to csv/ (no DB changes).
 * @param {{ dataRoot: string, state?: string, county?: string, dryRun?: boolean }} opts
 */
export async function moveProcessedToCsv({
  dataRoot,
  state: stateFilter = "",
  county: countyFilter = "",
  dryRun = false,
} = {}) {
  if (!dataRoot) throw new Error("dataRoot is required");
  if (!existsSync(dataRoot)) {
    throw new Error(`dataRoot does not exist: ${dataRoot}`);
  }

  const stFilter = String(stateFilter || "")
    .trim()
    .toLowerCase();
  const coFilter = String(countyFilter || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");

  const states = (await readdir(dataRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((s) => /^[a-z]{2}$/.test(s))
    .filter((s) => !stFilter || s === stFilter);

  const summary = { dryRun, counties: 0, files: 0, byCounty: [] };

  for (const state of states) {
    const stateDir = join(dataRoot, state);
    const counties = (await readdir(stateDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((c) => !coFilter || c === coFilter)
      .sort();

    for (const county of counties) {
      const ctx = resolveCounty(state, county, dataRoot);
      if (!existsSync(ctx.processedDir)) continue;
      await mkdir(ctx.csvDir, { recursive: true });
      const names = (await readdir(ctx.processedDir)).filter(isImportSidecar);
      if (!names.length) continue;

      let moved = 0;
      for (const name of names) {
        const from = join(ctx.processedDir, name);
        const to = join(ctx.csvDir, name);
        if (!dryRun) {
          if (existsSync(to)) {
            await rename(to, `${to}.pre-move.bak`);
          }
          await rename(from, to);
        }
        moved += 1;
      }
      summary.counties += 1;
      summary.files += moved;
      summary.byCounty.push({ state, county, moved });
    }
  }

  return summary;
}
