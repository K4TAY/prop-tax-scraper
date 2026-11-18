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

/** Metro viewbox (Bexar + fringe cities): left,top,right,bottom (Nominatim order). */
export const BEXAR_VIEWBOX = "-98.95,29.85,-98.10,29.05";

/** Accept Nominatim hit only if within this distance of the parcel centroid. */
export const MAX_NOMINATIM_METERS = 750;

const CITY_ALIASES = {
  "ST HEDWIG": "Saint Hedwig",
  "SAINT HEDWIG": "Saint Hedwig",
  "VON ORMY": "Von Ormy",
};

/** Longer names first so "HILL COUNTRY VILLAGE" wins over shorter tokens. */
const KNOWN_CITIES = [
  "HILL COUNTRY VILLAGE",
  "UNIVERSAL CITY",
  "BALCONES HEIGHTS",
  "HOLLYWOOD PARK",
  "ALAMO HEIGHTS",
  "TERRELL HILLS",
  "CASTLE HILLS",
  "SHAVANO PARK",
  "LEON VALLEY",
  "SAINT HEDWIG",
  "ST HEDWIG",
  "SAN ANTONIO",
  "OLMOS PARK",
  "CHINA GROVE",
  "WINDCREST",
  "ELMENDORF",
  "LIVE OAK",
  "CONVERSE",
  "ATASCOSA",
  "VON ORMY",
  "HELOTES",
  "SCHERTZ",
  "SOMERSET",
  "BOERNE",
  "CIBOLO",
  "ADKINS",
  "SELMA",
  "KIRBY",
  "MACDONA",
  "LACOSTE",
].sort((a, b) => b.length - a.length);

const STREET_EXPAND = [
  [/\bFM\s*(\d+)\b/gi, "Farm-to-Market Road $1"],
  [/\bRM\s*(\d+)\b/gi, "Ranch-to-Market Road $1"],
  [/\bBLVD\b/gi, "Boulevard"],
  [/\bPKWY\b/gi, "Parkway"],
  [/\bHWY\b/gi, "Highway"],
  [/\bFWY\b/gi, "Freeway"],
  [/\bEXPY\b/gi, "Expressway"],
  [/\bAVE\b/gi, "Avenue"],
  [/\bDR\b/gi, "Drive"],
  [/\bRD\b/gi, "Road"],
  [/\bST\b/gi, "Street"],
  [/\bLN\b/gi, "Lane"],
  [/\bCT\b/gi, "Court"],
  [/\bCIR\b/gi, "Circle"],
  [/\bPL\b/gi, "Place"],
  [/\bTRL\b/gi, "Trail"],
  [/\bRDG\b/gi, "Ridge"],
  [/\bBND\b/gi, "Bend"],
  [/\bFLD\b/gi, "Field"],
  [/\bCV\b/gi, "Cove"],
  [/\bPT\b/gi, "Point"],
  [/\bTER\b/gi, "Terrace"],
  [/\bRUN\b/gi, "Run"],
  [/\bPASS\b/gi, "Pass"],
  [/\bWAY\b/gi, "Way"],
  [/\bLOOP\b/gi, "Loop"],
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Great-circle distance in meters. */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lng2 - lng1);
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function expandStreetName(street) {
  let s = String(street || "").trim();
  for (const [re, repl] of STREET_EXPAND) s = s.replace(re, repl);
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Parse BCAD situs into street / city / zip pieces.
 */
export function parseSitusAddress(prop) {
  const situs = String(prop?.situs || "").trim();
  if (!situs) return null;

  const upper = situs.toUpperCase();
  let cityKey = null;
  for (const c of KNOWN_CITIES) {
    if (upper.includes(c)) {
      cityKey = c;
      break;
    }
  }
  const city =
    (cityKey && (CITY_ALIASES[cityKey] || cityKey)) ||
    String(prop?.addr_city || "").trim() ||
    "San Antonio";

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

  let street = situs
    .replace(/,?\s*(TX|TEXAS)\b.*$/i, "")
    .replace(/\b\d{5}(?:-\d{4})?\s*$/, "")
    .trim();

  const cityStripKeys = new Set(
    [cityKey, city, CITY_ALIASES[cityKey], city?.toUpperCase()].filter(Boolean)
  );
  for (const key of cityStripKeys) {
    const re = new RegExp(`,?\\s*${String(key).replace(/\s+/g, "\\s+")}\\s*$`, "i");
    street = street.replace(re, "").trim();
  }
  // Unit / lot trailing digits like "BENTON CITY RD 2"
  street = street.replace(/,\s*$/, "").trim();
  if (!street) street = situs;

  const houseNumber = (street.match(/^\s*(\d+[A-Z]?)\b/i) || [])[1] || null;
  const streetNoNumber = houseNumber
    ? street.replace(/^\s*\d+[A-Z]?\s+/i, "").trim()
    : street;
  const streetExpanded = expandStreetName(street);
  const streetNoNumberExpanded = expandStreetName(streetNoNumber);

  return {
    situs,
    street,
    streetExpanded,
    streetNoNumber,
    streetNoNumberExpanded,
    houseNumber,
    city,
    zip,
  };
}

/**
 * Build freeform Nominatim queries (best → fallback).
 */
export function buildGeocodeCandidates(prop) {
  const parsed = parseSitusAddress(prop);
  if (!parsed) return [];

  const { street, streetExpanded, streetNoNumberExpanded, city, zip } = parsed;
  const locality = [city, "TX", zip, "USA"].filter(Boolean).join(", ");
  const localityNoZip = [city, "TX", "USA"].filter(Boolean).join(", ");

  const queries = [];
  const add = (q) => {
    const s = String(q || "").trim();
    if (s && !queries.includes(s)) queries.push(s);
  };

  add(`${streetExpanded}, ${locality}`);
  add(`${street}, ${locality}`);
  if (zip) {
    add(`${streetExpanded}, ${localityNoZip}`);
    add(`${street}, ${localityNoZip}`);
  }
  // Road-only (many OSM streets lack house numbers)
  add(`${streetNoNumberExpanded}, ${localityNoZip}`);
  add(`${streetNoNumberExpanded}, ${city}, Texas`);

  return queries;
}

/** Primary freeform query (first cascade candidate). */
export function buildGeocodeQuery(prop) {
  const qs = buildGeocodeCandidates(prop);
  return qs[0] || null;
}

/**
 * Call Nominatim /search. Freeform `q` or structured fields.
 */
export async function nominatimSearch(queryOrFields, opts = {}) {
  const base = String(opts.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
  const url = new URL(`${base}/search`);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", String(opts.limit ?? 3));
  url.searchParams.set("countrycodes", opts.countrycodes || "us");

  if (queryOrFields && typeof queryOrFields === "object" && !Array.isArray(queryOrFields)) {
    for (const [k, v] of Object.entries(queryOrFields)) {
      if (v != null && v !== "") url.searchParams.set(k, String(v));
    }
  } else {
    url.searchParams.set("q", String(queryOrFields || ""));
  }

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

function hitToFields(hit, query, status = "ok") {
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
    geocode_status: status,
    geocode_error: null,
    geocode_raw: hit || null,
  };
}

function centroidFields(prop, query, reason) {
  return {
    geocode_lat: Number(prop.centroid_lat),
    geocode_lng: Number(prop.centroid_lng),
    geocode_display_name: "parcel centroid",
    geocode_place_id: null,
    geocode_osm_type: null,
    geocode_osm_id: null,
    geocode_importance: null,
    geocode_class: "parcel",
    geocode_type: "centroid",
    geocode_query: query || null,
    geocode_status: "centroid_fallback",
    geocode_error: reason,
    geocode_raw: {
      source: "parcel_centroid",
      reason,
    },
  };
}

function useCentroidFallback(opts) {
  return opts.fallbackCentroid !== false;
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
 *
 * Cascade: expanded freeform → raw freeform → road-only → structured.
 * Accept Nominatim only when within MAX_NOMINATIM_METERS of parcel centroid;
 * otherwise (and on miss) default to parcel centroid.
 */
export async function geocodePropertyById(propertyId, opts = {}) {
  const client = opts.client || bcadPool;
  await ensureBcadSchema(client);
  const maxMeters = Math.max(
    Number(opts.maxMeters != null ? opts.maxMeters : MAX_NOMINATIM_METERS),
    50
  );
  const fallback = useCentroidFallback(opts);

  const { rows } = await client.query(
    `
    SELECT id, situs, addr_zip, addr_city, addr_state,
           geocode_lat, geocode_lng, geocode_status, geocode_class, geocoded_at,
           ST_Y(ST_Centroid(geom))::float8 AS centroid_lat,
           ST_X(ST_Centroid(geom))::float8 AS centroid_lng
    FROM bcad_properties
    WHERE id = $1
    `,
    [propertyId]
  );
  const prop = rows[0];
  if (!prop) throw new Error(`property ${propertyId} not found`);

  const hasCoords = prop.geocode_lat != null && prop.geocode_lng != null;
  const preciseOk =
    prop.geocode_status === "ok" &&
    hasCoords &&
    prop.geocode_class &&
    prop.geocode_class !== "highway";
  const goodCentroid =
    prop.geocode_status === "centroid_fallback" && hasCoords;
  // Re-do road-level "ok" hits — they are often far from the parcel.
  const roadLevelOk =
    prop.geocode_status === "ok" && prop.geocode_class === "highway";

  if (!opts.force && (preciseOk || goodCentroid) && !roadLevelOk) {
    return {
      id: propertyId,
      skipped: true,
      reason: "already_geocoded",
      lat: Number(prop.geocode_lat),
      lng: Number(prop.geocode_lng),
      status: prop.geocode_status,
    };
  }

  const parsed = parseSitusAddress(prop);
  const candidates = buildGeocodeCandidates(prop);
  const primaryQuery = candidates[0] || null;

  if (!parsed || !candidates.length) {
    const fields =
      fallback && prop.centroid_lat != null
        ? centroidFields(prop, null, "missing situs; used parcel centroid")
        : {
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

  const pickClosestHit = (hits, query) => {
    let best = null;
    for (const hit of hits || []) {
      if (hit?.lat == null || hit?.lon == null) continue;
      const lat = Number(hit.lat);
      const lng = Number(hit.lon);
      const meters =
        prop.centroid_lat != null
          ? haversineMeters(
              prop.centroid_lat,
              prop.centroid_lng,
              lat,
              lng
            )
          : 0;
      if (!best || meters < best.meters) {
        best = { hit, query, lat, lng, meters };
      }
    }
    return best;
  };

  try {
    let best = null;

    for (const q of candidates) {
      const hits = await nominatimSearch(q, opts);
      const picked = pickClosestHit(hits, q);
      if (!picked) continue;
      if (!best || picked.meters < best.meters) best = picked;
      // Good enough — stop cascading
      if (picked.meters <= maxMeters) break;
    }

    // Structured search as last Nominatim attempt
    if (!best || best.meters > maxMeters) {
      const structured = {
        street: parsed.streetExpanded || parsed.street,
        city: parsed.city,
        state: "Texas",
        country: "USA",
      };
      if (parsed.zip) structured.postalcode = parsed.zip;
      const hits = await nominatimSearch(structured, opts);
      const label = `structured:${parsed.streetExpanded || parsed.street}`;
      const picked = pickClosestHit(hits, label);
      if (picked && (!best || picked.meters < best.meters)) best = picked;
    }

    if (best && best.meters <= maxMeters) {
      const fields = hitToFields(best.hit, best.query, "ok");
      fields.geocode_raw = {
        ...(fields.geocode_raw || {}),
        meters_from_parcel: Math.round(best.meters),
      };
      await writeGeocode(propertyId, fields, client);
      return {
        id: propertyId,
        skipped: false,
        status: "ok",
        lat: fields.geocode_lat,
        lng: fields.geocode_lng,
        query: best.query,
        display_name: fields.geocode_display_name,
        meters_from_parcel: Math.round(best.meters),
      };
    }

    // Miss or too far → parcel centroid (default)
    if (fallback && prop.centroid_lat != null) {
      const reason = best
        ? `Nominatim ${Math.round(best.meters)}m from parcel (>${maxMeters}m); used centroid`
        : "Nominatim empty; used parcel centroid";
      const fields = centroidFields(prop, best?.query || primaryQuery, reason);
      if (best) {
        fields.geocode_raw = {
          source: "parcel_centroid",
          reason,
          rejected_nominatim: {
            lat: best.lat,
            lng: best.lng,
            meters: Math.round(best.meters),
            query: best.query,
            display_name: best.hit?.display_name || null,
          },
        };
      }
      await writeGeocode(propertyId, fields, client);
      return {
        id: propertyId,
        skipped: false,
        status: "centroid_fallback",
        lat: fields.geocode_lat,
        lng: fields.geocode_lng,
        query: fields.geocode_query,
        error: reason,
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
      geocode_query: primaryQuery,
      geocode_status: "not_found",
      geocode_error: best
        ? `Nominatim too far (${Math.round(best.meters)}m)`
        : "no Nominatim results",
      geocode_raw: best
        ? {
            rejected_nominatim: {
              lat: best.lat,
              lng: best.lng,
              meters: Math.round(best.meters),
              query: best.query,
            },
          }
        : null,
    };
    await writeGeocode(propertyId, fields, client);
    return {
      id: propertyId,
      skipped: false,
      status: "not_found",
      lat: null,
      lng: null,
      query: primaryQuery,
      error: fields.geocode_error,
    };
  } catch (err) {
    if (fallback && prop.centroid_lat != null) {
      const fields = centroidFields(
        prop,
        primaryQuery,
        `Nominatim error (${err.message}); used parcel centroid`
      );
      await writeGeocode(propertyId, fields, client);
      return {
        id: propertyId,
        skipped: false,
        status: "centroid_fallback",
        lat: fields.geocode_lat,
        lng: fields.geocode_lng,
        query: primaryQuery,
        error: fields.geocode_error,
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
      geocode_query: primaryQuery,
      geocode_status: "error",
      geocode_error: err.message || String(err),
      geocode_raw: null,
    };
    await writeGeocode(propertyId, fields, client);
    return {
      id: propertyId,
      skipped: false,
      status: "error",
      lat: null,
      lng: null,
      query: primaryQuery,
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
    // Include road-level "ok" hits so we can replace far street matches with centroids.
    statusSql = `
      (
        p.geocode_lat IS NULL
        OR p.geocode_status IS NULL
        OR p.geocode_status IN ('not_found', 'error', 'skipped')
        OR (p.geocode_status = 'ok' AND COALESCE(p.geocode_class, '') = 'highway')
      )
    `;
    if (cooldownHours > 0) {
      params.push(String(cooldownHours));
      statusSql += `
        AND (
          p.geocode_status = 'ok' AND COALESCE(p.geocode_class, '') = 'highway'
          OR p.geocoded_at IS NULL
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
