import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

/** Keep pool large enough for concurrent county imports (see IMPORT_CONCURRENCY). */
export const IMPORT_CONCURRENCY = Math.min(
  16,
  Math.max(1, parseInt(process.env.IMPORT_CONCURRENCY || "4", 10) || 4)
);

/**
 * Local: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 * Managed: DATABASE_URL (ssl on unless DATABASE_SSL=false)
 */
function poolConfig() {
  const max = Math.max(20, IMPORT_CONCURRENCY + 8);
  if (process.env.DATABASE_URL) {
    const disableSsl = process.env.DATABASE_SSL === "false";
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: disableSsl ? false : { rejectUnauthorized: false },
      max,
    };
  }
  return {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "prop_tax",
    user: process.env.DB_USER || process.env.USER || "postgres",
    password: process.env.DB_PASSWORD || "",
    max,
  };
}

const pool = new Pool(poolConfig());

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err.message);
});

export default pool;
