import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

/**
 * Local: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 * Managed: DATABASE_URL (ssl on unless DATABASE_SSL=false)
 */
function poolConfig() {
  if (process.env.DATABASE_URL) {
    const disableSsl = process.env.DATABASE_SSL === "false";
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: disableSsl ? false : { rejectUnauthorized: false },
    };
  }
  return {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "prop_tax",
    user: process.env.DB_USER || process.env.USER || "postgres",
    password: process.env.DB_PASSWORD || "",
  };
}

const pool = new Pool(poolConfig());

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err.message);
});

export default pool;
