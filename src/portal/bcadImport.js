import { gunzipSync } from "node:zlib";
import bcadPool from "./bcadDb.js";
import { ensureBcadSchema } from "./bcadSchema.js";
import { createBcadBucketStore, resolveS3Config } from "./s3.js";

const BATCH = 500;

function blankToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = toNum(v);
  return n == null ? null : Math.trunc(n);
}

function geomJson(geometry) {
  if (!geometry || !geometry.type) return null;
  let g = geometry;
  if (g.type === "Polygon") {
    g = { type: "MultiPolygon", coordinates: [g.coordinates] };
  }
  if (g.type !== "MultiPolygon" && g.type !== "Polygon") return null;
  return JSON.stringify(g);
}

function rowFromFeature(f, hoodFallback) {
  const p = f.properties || {};
  const geom = geomJson(f.geometry);
  if (!geom) return null;
  return {
    pacs_prop_id: blankToNull(p.pacs_prop_id),
    geo_id: blankToNull(p.geo_id),
    owner_id: blankToNull(p.owner_id),
    owner_name: blankToNull(p.owner_name),
    legal_desc: blankToNull(p.legal_desc),
    situs: blankToNull(p.situs),
    dba_name: blankToNull(p.dba_name),
    appraised_val: blankToNull(p.appraised_val),
    appraised_val_num: toNum(p.appraised_val),
    addr_line1: blankToNull(p.addr_line1),
    addr_line2: blankToNull(p.addr_line2),
    addr_line3: blankToNull(p.addr_line3),
    addr_city: blankToNull(p.addr_city),
    addr_state: blankToNull(p.addr_state),
    addr_zip: blankToNull(p.addr_zip),
    addr_country: blankToNull(p.addr_country),
    prop_type_cd: blankToNull(p.prop_type_cd),
    prop_type_desc: blankToNull(p.prop_type_desc),
    state_cd: blankToNull(p.state_cd),
    exemptions: blankToNull(p.exemptions),
    pct_ownership: toNum(p.pct_ownership),
    jurisdictions: blankToNull(p.jurisdictions),
    abs_subdv_cd: blankToNull(p.abs_subdv_cd),
    hood_cd: blankToNull(p.hood_cd) || blankToNull(hoodFallback?.hood_cd),
    hood_name: blankToNull(p.hood_name) || blankToNull(hoodFallback?.hood_name),
    mapsco: blankToNull(p.mapsco),
    map_id: blankToNull(p.map_id),
    agent_cd: blankToNull(p.agent_cd),
    prop_val_yr: toInt(p.prop_val_yr),
    prop_id: blankToNull(p.PROP_ID ?? p.prop_id),
    account_id: blankToNull(p.AccountID ?? p.account_id),
    objectid: toInt(p.OBJECTID ?? p.objectid),
    geom,
  };
}

async function insertBatch(client, rows) {
  if (!rows.length) return 0;
  const cols = [
    "pacs_prop_id",
    "geo_id",
    "owner_id",
    "owner_name",
    "legal_desc",
    "situs",
    "dba_name",
    "appraised_val",
    "appraised_val_num",
    "addr_line1",
    "addr_line2",
    "addr_line3",
    "addr_city",
    "addr_state",
    "addr_zip",
    "addr_country",
    "prop_type_cd",
    "prop_type_desc",
    "state_cd",
    "exemptions",
    "pct_ownership",
    "jurisdictions",
    "abs_subdv_cd",
    "hood_cd",
    "hood_name",
    "mapsco",
    "map_id",
    "agent_cd",
    "prop_val_yr",
    "prop_id",
    "account_id",
    "objectid",
    "geom",
  ];
  const values = [];
  const placeholders = [];
  let i = 1;
  for (const r of rows) {
    const ph = [];
    for (const c of cols) {
      if (c === "geom") {
        ph.push(
          `ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($${i}), 4326)), 3))`
        );
        values.push(r.geom);
        i++;
      } else {
        ph.push(`$${i}`);
        values.push(r[c]);
        i++;
      }
    }
    placeholders.push(`(${ph.join(",")})`);
  }
  await client.query(
    `INSERT INTO bcad_properties (${cols.join(",")}) VALUES ${placeholders.join(",")}`,
    values
  );
  return rows.length;
}

async function importHood(client, store, entry, { replaceHood }) {
  const key =
    entry.keys?.parcels_geojson_gz ||
    `neighborhoods/${entry.hood_cd}/parcels.geojson.gz`;
  const gz = await store.readBytes(key);
  const json = gunzipSync(gz).toString("utf8");
  const collection = JSON.parse(json);
  const features = collection.features || [];
  const hoodMeta = {
    hood_cd: entry.hood_cd,
    hood_name: entry.hood_name,
  };

  if (replaceHood && entry.hood_cd) {
    await client.query(`DELETE FROM bcad_properties WHERE hood_cd = $1`, [
      String(entry.hood_cd),
    ]);
  }

  let inserted = 0;
  let skipped = 0;
  let batch = [];
  for (const f of features) {
    const row = rowFromFeature(f, hoodMeta);
    if (!row) {
      skipped++;
      continue;
    }
    batch.push(row);
    if (batch.length >= BATCH) {
      inserted += await insertBatch(client, batch);
      batch = [];
    }
  }
  if (batch.length) inserted += await insertBatch(client, batch);
  return { inserted, skipped, total: features.length };
}

/**
 * Import BCAD parcels from the Railway bucket into PostGIS.
 *
 * @param {{
 *   force?: boolean,
 *   limit?: number,
 *   hood?: string|null,
 *   onProgress?: (p: object) => void,
 *   shouldCancel?: () => boolean,
 * }} [options]
 */
export async function runBcadImport(options = {}) {
  const force = options.force === true;
  const limit = Number(options.limit) || 0;
  const hoodFilter = options.hood ? String(options.hood).trim() : null;
  const onProgress = options.onProgress || (() => {});
  const shouldCancel = options.shouldCancel || (() => false);

  const s3 = resolveS3Config();
  if (!s3) {
    throw new Error(
      "S3 bucket not configured. Set ENDPOINT, BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION"
    );
  }

  await ensureBcadSchema(bcadPool);
  const store = createBcadBucketStore();

  onProgress({
    phase: "index",
    message: `Reading index.json from s3://${store.bucket}…`,
  });

  const index = JSON.parse(await store.readText("index.json"));
  let neighborhoods = index.neighborhoods || index.hoods || [];
  if (!Array.isArray(neighborhoods) || !neighborhoods.length) {
    if (Array.isArray(index)) neighborhoods = index;
  }
  if (!neighborhoods.length) {
    throw new Error("index.json has no neighborhoods");
  }

  if (hoodFilter) {
    neighborhoods = neighborhoods.filter(
      (n) => String(n.hood_cd).trim() === hoodFilter
    );
    if (!neighborhoods.length) {
      throw new Error(`hood_cd=${hoodFilter} not found in index`);
    }
  }
  if (limit > 0) neighborhoods = neighborhoods.slice(0, limit);

  if (force && !hoodFilter) {
    onProgress({ phase: "truncate", message: "Truncating bcad_properties…" });
    await bcadPool.query(`TRUNCATE bcad_properties RESTART IDENTITY`);
  }

  const doReplace = !(force && !hoodFilter);
  const total = neighborhoods.length;
  let ok = 0;
  let failed = 0;
  let empty = 0;
  let parcels = 0;
  const startedAt = Date.now();
  const recent = [];

  const client = await bcadPool.connect();
  try {
    for (let i = 0; i < neighborhoods.length; i++) {
      if (shouldCancel()) {
        onProgress({
          phase: "cancelled",
          current: i,
          total,
          ok,
          failed,
          empty,
          parcels,
          message: "Import cancelled",
          done: true,
          cancelled: true,
        });
        return {
          ok,
          failed,
          empty,
          parcels,
          total,
          cancelled: true,
          tableTotal: null,
        };
      }

      const entry = neighborhoods[i];
      const label = `${entry.hood_name || ""} (${entry.hood_cd})`.trim();
      onProgress({
        phase: "hood",
        current: i + 1,
        total,
        ok,
        failed,
        empty,
        parcels,
        hood_cd: entry.hood_cd,
        hood_name: entry.hood_name,
        label,
        message: `Importing ${label}…`,
        pct: Math.round(((i) / total) * 1000) / 10,
        elapsedMs: Date.now() - startedAt,
      });

      try {
        const result = await importHood(client, store, entry, {
          replaceHood: doReplace,
        });
        parcels += result.inserted;
        if (result.total === 0) empty++;
        else ok++;
        const line = `ok inserted=${result.inserted} skipped=${result.skipped}/${result.total}`;
        recent.push({ label, status: "ok", detail: line });
        if (recent.length > 40) recent.shift();
        onProgress({
          phase: "hood_done",
          current: i + 1,
          total,
          ok,
          failed,
          empty,
          parcels,
          hood_cd: entry.hood_cd,
          hood_name: entry.hood_name,
          label,
          message: `[${i + 1}/${total}] ${label} — ${line}`,
          pct: Math.round(((i + 1) / total) * 1000) / 10,
          elapsedMs: Date.now() - startedAt,
          recent: [...recent],
        });
      } catch (e) {
        failed++;
        const msg = e.message || String(e);
        recent.push({ label, status: "fail", detail: msg });
        if (recent.length > 40) recent.shift();
        onProgress({
          phase: "hood_fail",
          current: i + 1,
          total,
          ok,
          failed,
          empty,
          parcels,
          hood_cd: entry.hood_cd,
          hood_name: entry.hood_name,
          label,
          message: `[${i + 1}/${total}] ${label} — FAIL ${msg}`,
          pct: Math.round(((i + 1) / total) * 1000) / 10,
          elapsedMs: Date.now() - startedAt,
          recent: [...recent],
        });
      }
    }
  } finally {
    client.release();
  }

  const { rows } = await bcadPool.query(
    `SELECT COUNT(*)::bigint AS n FROM bcad_properties`
  );
  const tableTotal = Number(rows[0].n) || 0;
  onProgress({
    phase: "done",
    current: total,
    total,
    ok,
    failed,
    empty,
    parcels,
    tableTotal,
    message: `Done. ok=${ok} failed=${failed} inserted=${parcels} table=${tableTotal}`,
    pct: 100,
    elapsedMs: Date.now() - startedAt,
    recent: [...recent],
    done: true,
  });

  return {
    ok,
    failed,
    empty,
    parcels,
    total,
    cancelled: false,
    tableTotal,
  };
}
