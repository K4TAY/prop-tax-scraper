import dotenv from "dotenv";
dotenv.config({ quiet: true });
import bcadPool from "../src/portal/bcadDb.js";

const { rows } = await bcadPool.query(
  `
  SELECT id, geo_id, pacs_prop_id, prop_id, objectid, owner_name
  FROM bcad_properties
  WHERE replace(COALESCE(geo_id, ''), '-', '') = $1
  LIMIT 1
  `,
  ["046610000350"]
);
console.log(rows[0]);
await bcadPool.end();
