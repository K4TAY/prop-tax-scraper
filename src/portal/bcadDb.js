import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

/**
 * Spatial DB for bcad_properties (PostGIS).
 * Prefer BCAD_DATABASE_URL so Railway can use a PostGIS service while
 * auth/users stay on the main prop-tax Postgres (DATABASE_URL).
 * Locally, both often point at the same PostGIS-enabled database.
 */
function poolConfig() {
  const url =
    process.env.BCAD_DATABASE_URL ||
    process.env.DATABASE_URL ||
    null;
  const max = 12;
  if (url) {
    const disableSsl = process.env.DATABASE_SSL === "false";
    return {
      connectionString: url,
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

const bcadPool = new Pool(poolConfig());

bcadPool.on("error", (err) => {
  console.error("Unexpected BCAD PostgreSQL pool error:", err.message);
});

export default bcadPool;
