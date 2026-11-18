import bcadPool from "./bcadDb.js";
import { ensureBcadSchema } from "./bcadSchema.js";

/**
 * Nominatim (self-hosted) geocoding for BCAD property situs addresses.
 * Default host: https://geocode.forteapps.dev
 */

const DEFAULT_BASE =
  process.env.NOMINATIM_URL || "https://geocode.forteapps.dev";

const UA =
  process.env.NOMINATIM_USER_AGENT ||
  "prop-tax-scraper/bcad-portal (VA opportunity geocode; contact forteapps)";

/** Bexar County approximate viewbox: left,top,right,bottom (Nominatim order). */
export const BEXAR_VIEWBOX = "-98.813,29.731,-98.223,29.186";

const KNOWN_CITIES = [
  "SAN ANTONIO",
  "BOERNE",
  "HELOTES",
  "UNIVERSAL CITY",
  "LIVE OAK",
  "CONVERSE",
  "SCHERTZ",
  "SELMA",
  "WINDCREST",
  "KIRBY",
  "LEON VALLEY",
  "CASTLE HILLS",
  "ALAMO HEIGHTS",
  "TERRELL HILLS",
  "OLMOS PARK",
  "BALCONES HEIGHTS",
  "SHAVANO PARK",
  "HOLLYWOOD PARK",
  "HILL COUNTRY VILLAGE",
  "CHINA GROVE",
  "ELMENDORF",
  "SOMERSET",
  "VON ORMY",
  "ST HEDWIG",
  "SAINT HEDWIG",
  "ADKINS",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a Nominatim search query from BCAD situs (+ optional mail ZIP).
 * Situs is often "123 MAIN ST" or "123 MAIN ST SAN ANTONIO" without ZIP.
 */
export function buildGeocodeQuery(prop) {
  const situs = String(prop?.situs || "").trim();
  if (!situs) return null;

  const upper = situs.toUpperCase();
  let city = null;
  for (const c of KNOWN_CITIES) {
    if (upper.includes(c)) {
      city =
        c === "ST HEDWIG" || c === "SAINT HEDWIG" ? "Saint Hedwig" : c;
      break;
    }
  }

  // ZIP only when it appears after a state token or at the very end
  // (never treat a 5-digit house number as a postal code).
  const zipFromSitus =
    (situs.match(/(?:TX|TEXAS)[,\s]+(\d{5})(?:-\d{4})?\b/i) || [])[1] ||
    (situs.match(/[A-Za-z]\s+(\d{5})(?:-\d{4})?\s*$/) || [])[1] ||
    null;
  const mailZip = String(prop?.addr_zip || "")
    .trim()
    .replace(/^(\d{5}).*$/, "$1");
  const zip =
    zipFromSitus ||
    (/^\d{5}$/.test(mailZip) ? mailZip : null) ||
    null;

  // Strip trailing city / state / zip so we can re-append normalized locality.
  let street = situs
    .replace(/,?\s*(TX|TEXAS)\b.*$/i, "")
    .replace(/\b\d{5}(?:-\d{4})?\s*$/, "")
    .trim();
  if (city) {
    const re = new RegExp(
      `,?\\s*${city.replace(/\s+/g, "\\s+")}\\s*$`,
      "i"
    );
    street = street.replace(re, "").trim();
  }
  street = street.replace(/,\s*$/, "").trim();
  if (!street) street = situs;

  const parts = [street];
  parts.push(city || "San Antonio");
  parts.push("TX");
  if (zip) parts.push(zip);
  parts.push("USA");
  return parts.join(", ");
}

/**
 * Call Nominatim /search. Honors 1 req/sec courtesy when callers gap between calls.
 */
export async function nominatimSearch(query, opts = {}) {
  const base = String(opts.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", String(opts.limit ?? 1));
  url.searchParams.set("countrycodes", opts.countrycodes || "us");
  if (opts.viewbox !== false) {
    url.searchParams.set("viewbox", opts.viewbox || BEXAR_VIEWBOX);
    url.searchParams.set("bounded", opts.bounded ? "1" : "0");
  }

  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Nominatim HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function hitToFields(hit, query) {
  return {
    geocode_lat: hit?.lat != null ? Number(hit.lat) : null,
    geocode_lng: hit?.lon != null ? Number(hit.lon) : null,
    geocode_display_name: hit?.display_name || null,
    geocode_place_id: hit?.place_id != null ? Number(hit.place_id) : null,
    geocode_osm_type: hit?.osm_type || null,
    geocode_osm_id: hit?.osm_id != null ? Number(hit.osm_id) : null,
    geocode_importance:
      hit?.importance != null ? Number(hit.importance) : null,
    geocode_class: hit?.class || null,
    geocode_type: hit?.type || null,
    geocode_query: query,
    geocode_status: "ok",
    geocode_error: null,
    geocode_raw: hit || null,
  };
}

async function writeGeocode(propertyId, fields, client = bcadPool) {
  await client.query(
    `
    UPDATE bcad_properties SET
      geocode_lat = $2,
      geocode_lng = $3,
      geocode_display_name = $4,
      geocode_place_id = $5,
      geocode_osm_type = $6,
      geocode_osm_id = $7,
      geocode_importance = $8,
      geocode_class = $9,
      geocode_type = $10,
      geocode_query = $11,
      geocode_status = $12,
      geocode_error = $13,
      geocode_raw = $14::jsonb,
      geocoded_at = NOW()
    WHERE id = $1
    `,
    [
      propertyId,
      fields.geocode_lat,
      fields.geocode_lng,
      fields.geocode_display_name,
      fields.geocode_place_id,
      fields.geocode_osm_type,
      fields.geocode_osm_id,
      fields.geocode_importance,
      fields.geocode_class,
      fields.geocode_type,
      fields.geocode_query,
      fields.geocode_status,
      fields.geocode_error,
      fields.geocode_raw ? JSON.stringify(fields.geocode_raw) : null,
    ]
  );
}

/**
 * Geocode one property by id. Returns status summary.
 */
export async function geocodePropertyById(propertyId, opts = {}) {
  const client = opts.client || bcadPool;
  await ensureBcadSchema(client);

  const { rows } = await client.query(
    `
    SELECT id, situs, addr_zip, addr_city, addr_state,
           geocode_lat, geocode_lng, geocode_status, geocoded_at,
           ST_Y(ST_Centroid(geom))::float8 AS centroid_lat,
           ST_X(ST_Centroid(geom))::float8 AS centroid_lng
    FROM bcad_properties
    WHERE id = $1
    `,
    [propertyId]
  );
  const prop = rows[0];
  if (!prop) throw new Error(`property ${propertyId} not found`);

  if (
    !opts.force &&
    prop.geocode_status === "ok" &&
    prop.geocode_lat != null &&
    prop.geocode_lng != null
  ) {
    return {
      id: propertyId,
      skipped: true,
      reason: "already_geocoded",
      lat: Number(prop.geocode_lat),
      lng: Number(prop.geocode_lng),
      status: prop.geocode_status,
    };
  }

  const query = buildGeocodeQuery(prop);
  if (!query) {
    const fields = {
      geocode_lat: null,
      geocode_lng: null,
      geocode_display_name: null,
      geocode_place_id: null,
      geocode_osm_type: null,
      geocode_osm_id: null,
      geocode_importance: null,
      geocode_class: null,
      geocode_type: null,
      geocode_query: null,
      geocode_status: "skipped",
      geocode_error: "missing situs",
      geocode_raw: null,
    };
    if (opts.fallbackCentroid && prop.centroid_lat != null) {
      fields.geocode_lat = Number(prop.centroid_lat);
      fields.geocode_lng = Number(prop.centroid_lng);
      fields.geocode_status = "centroid_fallback";
      fields.geocode_error = "missing situs; used parcel centroid";
      fields.geocode_display_name = "parcel centroid";
    }
    await writeGeocode(propertyId, fields, client);
    return {
      id: propertyId,
      skipped: false,
      status: fields.geocode_status,
      lat: fields.geocode_lat,
      lng: fields.geocode_lng,
      query: null,
      error: fields.geocode_error,
    };
  }

  try {
    const hits = await nominatimSearch(query, opts);
    const hit = hits[0];
    if (hit?.lat != null && hit?.lon != null) {
      const fields = hitToFields(hit, query);
      await writeGeocode(propertyId, fields, client);
      return {
        id: propertyId,
        skipped: false,
        status: "ok",
        lat: fields.geocode_lat,
        lng: fields.geocode_lng,
        query,
        display_name: fields.geocode_display_name,
      };
    }

    const fields = {
      geocode_lat: null,
      geocode_lng: null,
      geocode_display_name: null,
      geocode_place_id: null,
      geocode_osm_type: null,
      geocode_osm_id: null,
      geocode_importance: null,
      geocode_class: null,
      geocode_type: null,
      geocode_query: query,
      geocode_status: "not_found",
      geocode_error: "no Nominatim results",
      geocode_raw: null,
    };
    if (opts.fallbackCentroid && prop.centroid_lat != null) {
      fields.geocode_lat = Number(prop.centroid_lat);
      fields.geocode_lng = Number(prop.centroid_lng);
      fields.geocode_status = "centroid_fallback";
      fields.geocode_error = "Nominatim empty; used parcel centroid";
      fields.geocode_display_name = "parcel centroid";
    }
    await writeGeocode(propertyId, fields, client);
    return {
      id: propertyId,
      skipped: false,
      status: fields.geocode_status,
      lat: fields.geocode_lat,
      lng: fields.geocode_lng,
      query,
      error: fields.geocode_error,
    };
  } catch (err) {
    const fields = {
      geocode_lat: null,
      geocode_lng: null,
      geocode_display_name: null,
      geocode_place_id: null,
      geocode_osm_type: null,
      geocode_osm_id: null,
      geocode_importance: null,
      geocode_class: null,
      geocode_type: null,
      geocode_query: query,
      geocode_status: "error",
      geocode_error: err.message || String(err),
      geocode_raw: null,
    };
    if (opts.fallbackCentroid && prop.centroid_lat != null) {
      fields.geocode_lat = Number(prop.centroid_lat);
      fields.geocode_lng = Number(prop.centroid_lng);
      fields.geocode_status = "centroid_fallback";
      fields.geocode_error = `Nominatim error (${err.message}); used parcel centroid`;
      fields.geocode_display_name = "parcel centroid";
    }
    await writeGeocode(propertyId, fields, client);
    return {
      id: propertyId,
      skipped: false,
      status: fields.geocode_status,
      lat: fields.geocode_lat,
      lng: fields.geocode_lng,
      query,
      error: fields.geocode_error,
    };
  }
}

/**
 * Queue: VA opportunities whose property still needs geocoding.
 */
export async function listVaOpportunitiesNeedingGeocode(opts = {}) {
  const client = opts.client || bcadPool;
  await ensureBcadSchema(client);
  const minScore = opts.minScore != null ? Number(opts.minScore) : 0;
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 50000);
  const force = !!opts.force;
  const cooldownHours = Math.max(Number(opts.cooldownHours) || 0, 0);

  const params = [minScore, limit];
  let statusSql;
  if (force) {
    statusSql = "TRUE";
  } else {
    statusSql = `
      (
        p.geocode_lat IS NULL
        OR p.geocode_status IS NULL
        OR p.geocode_status IN ('not_found', 'error', 'skipped')
      )
    `;
    if (cooldownHours > 0) {
      params.push(String(cooldownHours));
      statusSql += `
        AND (
          p.geocoded_at IS NULL
          OR p.geocoded_at < NOW() - ($${params.length}::text || ' hours')::interval
        )
      `;
    }
  }

  const { rows } = await client.query(
    `
    SELECT
      v.bcad_property_id AS id,
      v.score,
      v.tier,
      v.owner_name,
      COALESCE(NULLIF(TRIM(v.situs), ''), p.situs) AS situs,
      p.addr_zip,
      p.geocode_status,
      p.geocoded_at
    FROM bcad_va_opportunities v
    JOIN bcad_properties p ON p.id = v.bcad_property_id
    WHERE v.score >= $1
      AND (${statusSql})
    ORDER BY
      CASE WHEN p.geocode_lat IS NULL THEN 0 ELSE 1 END,
      v.score DESC,
      v.bcad_property_id
    LIMIT $2
    `,
    params
  );
  return rows;
}

/**
 * Aggregate geocode coverage for VA opportunities.
 */
export async function getVaGeocodeStats(opts = {}) {
  const client = opts.client || bcadPool;
  await ensureBcadSchema(client);
  const minScore = opts.minScore != null ? Number(opts.minScore) : 0;

  const { rows } = await client.query(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE p.geocode_status = 'ok' AND p.geocode_lat IS NOT NULL
      )::int AS ok,
      COUNT(*) FILTER (
        WHERE p.geocode_status = 'centroid_fallback' AND p.geocode_lat IS NOT NULL
      )::int AS centroid_fallback,
      COUNT(*) FILTER (
        WHERE p.geocode_status = 'not_found'
      )::int AS not_found,
      COUNT(*) FILTER (
        WHERE p.geocode_status = 'error'
      )::int AS error,
      COUNT(*) FILTER (
        WHERE p.geocode_status = 'skipped'
      )::int AS skipped,
      COUNT(*) FILTER (
        WHERE p.geocode_lat IS NULL
          OR p.geocode_status IS NULL
          OR p.geocode_status IN ('not_found', 'error', 'skipped')
      )::int AS needing,
      COUNT(*) FILTER (
        WHERE p.geocode_lat IS NOT NULL
      )::int AS with_coords
    FROM bcad_va_opportunities v
    JOIN bcad_properties p ON p.id = v.bcad_property_id
    WHERE v.score >= $1
    `,
    [minScore]
  );
  const r = rows[0] || {};
  return {
    total: Number(r.total) || 0,
    ok: Number(r.ok) || 0,
    centroid_fallback: Number(r.centroid_fallback) || 0,
    not_found: Number(r.not_found) || 0,
    error: Number(r.error) || 0,
    skipped: Number(r.skipped) || 0,
    needing: Number(r.needing) || 0,
    with_coords: Number(r.with_coords) || 0,
    min_score: minScore,
    nominatim: String(
      process.env.NOMINATIM_URL || "https://geocode.forteapps.dev"
    ).replace(/\/$/, ""),
  };
}

export async function geocodeVaOpportunities(opts = {}) {
  const concurrency = Math.min(
    Math.max(Number(opts.concurrency) || 10, 1),
    10
  );
  const gapMs = Math.max(
    Number(
      opts.gapMs != null
        ? opts.gapMs
        : (opts.gapSeconds != null ? opts.gapSeconds : 0) * 1000
    ),
    0
  );
  const onProgress =
    typeof opts.onProgress === "function" ? opts.onProgress : null;
  const shouldCancel =
    typeof opts.shouldCancel === "function" ? opts.shouldCancel : () => false;

  const candidates = await listVaOpportunitiesNeedingGeocode(opts);
  const results = {
    queued: candidates.length,
    ok: 0,
    not_found: 0,
    error: 0,
    skipped: 0,
    centroid_fallback: 0,
    cancelled: false,
    concurrency,
    rows: [],
  };

  if (onProgress) {
    onProgress({
      phase: "running",
      message:
        candidates.length === 0
          ? "Nothing left to geocode"
          : `Queued ${candidates.length.toLocaleString()} properties (${concurrency} workers)…`,
      pct: 0,
      current: 0,
      total: candidates.length,
      ok: 0,
      not_found: 0,
      error: 0,
      skipped: 0,
      centroid_fallback: 0,
      concurrency,
      recent: [],
    });
  }

  const recent = [];
  const pushRecent = (entry) => {
    recent.unshift(entry);
    if (recent.length > 40) recent.length = 40;
  };

  let nextIndex = 0;
  let completed = 0;
  const inFlight = new Set();

  const emitProgress = (extra = {}) => {
    if (!onProgress) return;
    onProgress({
      phase: results.cancelled ? "cancelled" : "running",
      message: results.cancelled
        ? `Cancelled after ${completed.toLocaleString()} / ${candidates.length.toLocaleString()}`
        : `Geocoding ${completed.toLocaleString()} / ${candidates.length.toLocaleString()}${
            inFlight.size
              ? ` · ${inFlight.size} in flight`
              : ""
          }${extra.situs ? `: ${extra.situs}` : ""}`,
      pct: candidates.length
        ? Math.round((100 * completed) / candidates.length)
        : 100,
      current: completed,
      total: candidates.length,
      ok: results.ok,
      not_found: results.not_found,
      error: results.error,
      skipped: results.skipped,
      centroid_fallback: results.centroid_fallback,
      concurrency,
      recent: [...recent],
      ...extra,
    });
  };

  const recordResult = (c, out) => {
    const row = {
      ...out,
      score: c.score,
      tier: c.tier,
      situs: c.situs,
      owner_name: c.owner_name,
    };
    results.rows.push(row);

    let bucket = "skipped";
    if (out.skipped) {
      results.skipped += 1;
      bucket = "skip";
    } else if (out.status === "ok") {
      results.ok += 1;
      bucket = "ok";
    } else if (out.status === "not_found") {
      results.not_found += 1;
      bucket = "miss";
    } else if (out.status === "centroid_fallback") {
      results.centroid_fallback += 1;
      bucket = "cent";
    } else if (out.status === "error") {
      results.error += 1;
      bucket = "err";
    } else {
      results.skipped += 1;
    }

    pushRecent({
      status: bucket,
      id: c.id,
      label: `#${c.id} ${c.situs || c.owner_name || ""}`.trim(),
      detail:
        out.lat != null
          ? `${Number(out.lat).toFixed(5)},${Number(out.lng).toFixed(5)}`
          : out.error || out.status || "—",
    });

    completed += 1;
    emitProgress({ last: row, situs: c.situs || `#${c.id}` });
    return row;
  };

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(candidates.length, 0)) },
    async () => {
      while (true) {
        if (shouldCancel()) {
          results.cancelled = true;
          return;
        }
        const i = nextIndex++;
        if (i >= candidates.length) return;

        const c = candidates[i];
        inFlight.add(c.id);
        try {
          const out = await geocodePropertyById(c.id, opts);
          recordResult(c, out);
        } catch (err) {
          recordResult(c, {
            id: c.id,
            skipped: false,
            status: "error",
            lat: null,
            lng: null,
            error: err.message || String(err),
          });
        } finally {
          inFlight.delete(c.id);
        }

        if (gapMs > 0) await sleep(gapMs);
      }
    }
  );

  await Promise.all(workers);

  if (results.cancelled) {
    emitProgress({
      done: true,
      message: `Cancelled after ${completed.toLocaleString()} / ${candidates.length.toLocaleString()}`,
    });
  } else if (onProgress) {
    onProgress({
      phase: candidates.length ? "done" : "idle",
      message: candidates.length
        ? `Finished ${candidates.length.toLocaleString()} (${concurrency} workers) — ok ${results.ok}, miss ${results.not_found}, err ${results.error}`
        : "Nothing left to geocode",
      pct: 100,
      current: candidates.length,
      total: candidates.length,
      ok: results.ok,
      not_found: results.not_found,
      error: results.error,
      skipped: results.skipped,
      centroid_fallback: results.centroid_fallback,
      concurrency,
      recent: [...recent],
      done: true,
    });
  }

  return results;
}

/**
 * GeoJSON FeatureCollection of VA opportunities with coordinates.
 * Prefers Nominatim geocode_*; falls back to parcel centroid when allowed.
 */
export async function listVaOpportunitiesGeojson(opts = {}) {
  const client = opts.client || bcadPool;
  await ensureBcadSchema(client);
  const minScore = opts.minScore != null ? Number(opts.minScore) : 0;
  const tier = opts.tier || null;
  const includeCentroid = opts.includeCentroid !== false;

  const params = [minScore];
  let tierSql = "";
  if (tier) {
    params.push(tier);
    tierSql = ` AND v.tier = $${params.length}`;
  }

  const lngExpr = includeCentroid
    ? `COALESCE(p.geocode_lng, ST_X(ST_Centroid(p.geom)))`
    : `p.geocode_lng`;
  const latExpr = includeCentroid
    ? `COALESCE(p.geocode_lat, ST_Y(ST_Centroid(p.geom)))`
    : `p.geocode_lat`;

  const { rows } = await client.query(
    `
    SELECT
      v.bcad_property_id AS id,
      v.owner_name,
      v.situs,
      v.exemptions,
      v.score,
      v.tier,
      ${lngExpr}::float8 AS lng,
      ${latExpr}::float8 AS lat,
      CASE
        WHEN p.geocode_lat IS NOT NULL AND p.geocode_lng IS NOT NULL THEN
          COALESCE(p.geocode_status, 'ok')
        ELSE 'centroid'
      END AS coord_source
    FROM bcad_va_opportunities v
    JOIN bcad_properties p ON p.id = v.bcad_property_id
    WHERE v.score >= $1
      ${tierSql}
      AND ${latExpr} IS NOT NULL
      AND ${lngExpr} IS NOT NULL
    ORDER BY v.score DESC, v.bcad_property_id
    `,
    params
  );

  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [Number(r.lng), Number(r.lat)],
      },
      // Keep properties lean — ~60k points on the county map.
      properties: {
        id: Number(r.id),
        owner_name: r.owner_name,
        situs: r.situs,
        exemptions: r.exemptions,
        score: Number(r.score) || 0,
        tier: r.tier,
        src: r.coord_source,
      },
    })),
  };
}

export { sleep };
