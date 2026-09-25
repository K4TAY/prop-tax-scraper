import { getBcadParcelGeoById } from "./bcadSchema.js";

/**
 * Optional Google Street View Static imagery for property context.
 * Requires GOOGLE_MAPS_API_KEY (Street View Static API enabled).
 * Metadata is free; panorama images use the Static Street View SKU (free tier applies).
 */

const UA =
  "Mozilla/5.0 (compatible; prop-tax-scraper/bcad-portal; +https://github.com/K4TAY/prop-tax-scraper)";

function mapsStreetViewUrl(lat, lng) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
}

/** Initial camera heading from Street View point toward parcel centroid (degrees). */
export function bearingDegrees(fromLat, fromLng, toLat, toLng) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(fromLat);
  const φ2 = toRad(toLat);
  const Δλ = toRad(toLng - fromLng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function googleMapsApiKey() {
  return (
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_MAPS_KEY ||
    process.env.GMAPS_API_KEY ||
    ""
  ).trim();
}

/**
 * Describe Street View availability for a property (no image bytes).
 */
export async function getStreetViewMetaForProperty(propertyId, opts = {}) {
  const geo = await getBcadParcelGeoById(propertyId, opts.client);
  if (!geo) throw new Error(`property ${propertyId} not found`);
  const lat = geo.properties.lat;
  const lng = geo.properties.lng;
  const maps_url = mapsStreetViewUrl(lat, lng);
  const key = googleMapsApiKey();

  if (!key) {
    return {
      configured: false,
      available: false,
      lat,
      lng,
      maps_url,
      message:
        "Set GOOGLE_MAPS_API_KEY (Street View Static API) to embed imagery. Open Google Maps for Street View in the meantime.",
    };
  }

  const metaUrl = new URL(
    "https://maps.googleapis.com/maps/api/streetview/metadata"
  );
  metaUrl.searchParams.set("location", `${lat},${lng}`);
  metaUrl.searchParams.set("source", "outdoor");
  metaUrl.searchParams.set("key", key);

  const res = await fetch(metaUrl, { headers: { "User-Agent": UA } });
  const meta = await res.json().catch(() => ({}));
  if (meta.status !== "OK") {
    return {
      configured: true,
      available: false,
      lat,
      lng,
      maps_url,
      status: meta.status || `HTTP_${res.status}`,
      message: `No Street View near this parcel (${meta.status || res.status}).`,
    };
  }

  const plat = Number(meta.location?.lat ?? lat);
  const plng = Number(meta.location?.lng ?? lng);
  const heading = bearingDegrees(plat, plng, lat, lng);

  return {
    configured: true,
    available: true,
    lat: plat,
    lng: plng,
    parcel_lat: lat,
    parcel_lng: lng,
    heading: Math.round(heading),
    pano_id: meta.pano_id || null,
    date: meta.date || null,
    maps_url: mapsStreetViewUrl(plat, plng),
    image_path: `/api/bcad/properties/${propertyId}/street-view.jpg`,
  };
}

/**
 * Fetch Static Street View JPEG bytes for a property (server-side; keeps API key private).
 */
export async function fetchStreetViewImageForProperty(propertyId, opts = {}) {
  const key = googleMapsApiKey();
  if (!key) {
    const err = new Error("GOOGLE_MAPS_API_KEY not configured");
    err.status = 503;
    throw err;
  }
  const info = await getStreetViewMetaForProperty(propertyId, opts);
  if (!info.available) {
    const err = new Error(info.message || "Street View unavailable");
    err.status = 404;
    throw err;
  }

  const size = opts.size || "640x400";
  const imgUrl = new URL("https://maps.googleapis.com/maps/api/streetview");
  imgUrl.searchParams.set("size", size);
  imgUrl.searchParams.set("location", `${info.lat},${info.lng}`);
  imgUrl.searchParams.set("fov", String(opts.fov ?? 80));
  imgUrl.searchParams.set("heading", String(opts.heading ?? info.heading ?? 0));
  imgUrl.searchParams.set("pitch", String(opts.pitch ?? 0));
  imgUrl.searchParams.set("source", "outdoor");
  imgUrl.searchParams.set("return_error_code", "true");
  imgUrl.searchParams.set("key", key);

  const res = await fetch(imgUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    const err = new Error(`Street View image HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "image/jpeg";
  return { buf, contentType, meta: info };
}
