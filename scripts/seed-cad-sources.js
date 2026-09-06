#!/usr/bin/env bun
/** Create/update cad_sources and upsert seed rows. */
import { seedCadSources } from "../src/cadSources.js";
import pool from "../src/db.js";

const n = await seedCadSources();
const { rows } = await pool.query(`
  SELECT state_code, scrape_strategy, count(*)::int AS n
  FROM cad_sources
  GROUP BY 1, 2
  ORDER BY 1, 2
`);
console.log(`Upserted ${n} cad_sources rows`);
console.table(rows);
const { rows: total } = await pool.query(`SELECT count(*)::int AS n FROM cad_sources`);
console.log(`Total rows: ${total[0].n}`);
await pool.end();
