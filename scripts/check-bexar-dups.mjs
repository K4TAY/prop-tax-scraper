#!/usr/bin/env node
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

async function tableStats(name) {
  try {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS rows,
              COUNT(DISTINCT pacs_prop_id)::int AS distinct_props,
              COUNT(*)::int - COUNT(DISTINCT pacs_prop_id)::int AS dup_extra
       FROM ${name}`
    );
    return rows[0];
  } catch (err) {
    return { error: err.message };
  }
}

console.log("bexar_tx_properties", await tableStats("bexar_tx_properties"));
console.log("legacy properties", await tableStats("properties"));

const hoods = await client.query(
  `SELECT COUNT(*)::int AS hood_rows, COUNT(DISTINCT hood_cd)::int AS distinct_hoods
   FROM bexar_tx_neighborhoods`
);
console.log("bexar_tx_neighborhoods", hoods.rows[0]);

const dups = await client.query(
  `SELECT pacs_prop_id, COUNT(*)::int AS n
   FROM bexar_tx_properties
   GROUP BY 1 HAVING COUNT(*) > 1
   ORDER BY n DESC LIMIT 5`
);
console.log("dup_samples", dups.rows);

await client.end();
