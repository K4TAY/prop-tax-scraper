/**
 * Build public/geo/texas-counties.json from us-atlas counties TopoJSON.
 * Usage: bun scripts/build-texas-map.js [/path/to/counties-10m.json]
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { feature } from "topojson-client";
import { geoMercator, geoPath, geoCentroid } from "d3-geo";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "public", "geo", "texas-counties.json");
const WIDTH = 900;
const HEIGHT = 840;

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

const src =
  process.argv[2] ||
  process.env.COUNTIES_TOPOJSON ||
  "/tmp/counties-10m.json";

const topology = JSON.parse(await readFile(src, "utf8"));
const all = feature(topology, topology.objects.counties);
const tx = {
  type: "FeatureCollection",
  features: all.features.filter((f) => String(f.id).padStart(5, "0").startsWith("48")),
};

if (tx.features.length !== 254) {
  console.warn(`Expected 254 TX counties, got ${tx.features.length}`);
}

const projection = geoMercator().fitExtent(
  [
    [12, 12],
    [WIDTH - 12, HEIGHT - 12],
  ],
  tx
);
const path = geoPath(projection);

const counties = tx.features
  .map((f) => {
    const name = f.properties?.name || "Unknown";
    const [cx, cy] = geoCentroid(f);
    const [lx, ly] = projection([cx, cy]) || [0, 0];
    const d = path(f);
    if (!d) return null;
    return {
      name,
      slug: slugify(name),
      fips: String(f.id).padStart(5, "0"),
      path: d,
      x: Math.round(lx * 10) / 10,
      y: Math.round(ly * 10) / 10,
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.name.localeCompare(b.name));

await mkdir(dirname(OUT), { recursive: true });
const payload = {
  viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
  state: "TX",
  generatedAt: new Date().toISOString(),
  source: "us-atlas@3/counties-10m.json",
  counties,
};
await writeFile(OUT, JSON.stringify(payload));
console.log(`Wrote ${counties.length} counties → ${OUT}`);
console.log(`File size: ${(Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1)} KB`);
