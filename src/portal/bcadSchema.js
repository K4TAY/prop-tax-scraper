import bcadPool from "./bcadDb.js";

/**
 * Ensure PostGIS + bcad_properties for Bexar parcel geometry + assessor attrs.
 * Source: Railway bucket neighborhoods/{hood_cd}/parcels.geojson.gz
 */
export async function ensureBcadSchema(client = bcadPool) {
  await client.query(`CREATE EXTENSION IF NOT EXISTS postgis`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS bcad_properties (
      id BIGSERIAL PRIMARY KEY,
      pacs_prop_id TEXT,
      geo_id TEXT,
      owner_id TEXT,
      owner_name TEXT,
      legal_desc TEXT,
      situs TEXT,
      dba_name TEXT,
      appraised_val TEXT,
      appraised_val_num NUMERIC(14, 2),
      addr_line1 TEXT,
      addr_line2 TEXT,
      addr_line3 TEXT,
      addr_city TEXT,
      addr_state TEXT,
      addr_zip TEXT,
      addr_country TEXT,
      prop_type_cd TEXT,
      prop_type_desc TEXT,
      state_cd TEXT,
      exemptions TEXT,
      pct_ownership NUMERIC(8, 4),
      jurisdictions TEXT,
      abs_subdv_cd TEXT,
      hood_cd TEXT,
      hood_name TEXT,
      mapsco TEXT,
      map_id TEXT,
      agent_cd TEXT,
      prop_val_yr INTEGER,
      prop_id TEXT,
      account_id TEXT,
      objectid BIGINT,
      geom geometry(MultiPolygon, 4326) NOT NULL,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS bcad_properties_geom_gix
      ON bcad_properties USING GIST (geom);
    CREATE INDEX IF NOT EXISTS bcad_properties_pacs_idx
      ON bcad_properties (pacs_prop_id);
    CREATE INDEX IF NOT EXISTS bcad_properties_hood_idx
      ON bcad_properties (hood_cd);
    CREATE INDEX IF NOT EXISTS bcad_properties_geo_id_idx
      ON bcad_properties (geo_id);
  `);
}

export async function getBcadBounds(client = bcadPool) {
  const { rows } = await client.query(`
    SELECT
      ST_XMin(e) AS west,
      ST_YMin(e) AS south,
      ST_XMax(e) AS east,
      ST_YMax(e) AS north,
      (SELECT COUNT(*)::bigint FROM bcad_properties) AS count
    FROM (SELECT ST_Extent(geom) AS e FROM bcad_properties) x
    WHERE e IS NOT NULL
  `);
  if (!rows.length || rows[0].west == null) {
    return { count: 0, bounds: null };
  }
  const r = rows[0];
  return {
    count: Number(r.count) || 0,
    bounds: [
      [Number(r.west), Number(r.south)],
      [Number(r.east), Number(r.north)],
    ],
  };
}

export async function getBcadParcelById(id, client = bcadPool) {
  const { rows } = await client.query(
    `SELECT id, pacs_prop_id, geo_id, owner_name, situs, appraised_val,
            hood_cd, hood_name, legal_desc, prop_type_desc, addr_city, addr_zip
     FROM bcad_properties WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Serve Mapbox Vector Tile for one XYZ tile (EPSG:3857 envelope).
 */
export async function getBcadMvtTile(z, x, y, client = bcadPool) {
  const { rows } = await client.query(
    `
    SELECT ST_AsMVT(tile, 'parcels', 4096, 'geom') AS mvt
    FROM (
      SELECT
        id,
        pacs_prop_id,
        owner_name,
        situs,
        appraised_val,
        hood_cd,
        ST_AsMVTGeom(
          ST_Transform(geom, 3857),
          ST_TileEnvelope($1::int, $2::int, $3::int),
          4096,
          64,
          true
        ) AS geom
      FROM bcad_properties
      WHERE geom && ST_Transform(ST_TileEnvelope($1::int, $2::int, $3::int), 4326)
    ) tile
    `,
    [z, x, y]
  );
  return rows[0]?.mvt || null;
}
