import pool from "../db.js";
import { hashPassword } from "./password.js";
import { normalizeEmail } from "./schema.js";
import logger from "../logger.js";

/**
 * Ensure an ADMIN user exists from ADMIN_EMAIL + ADMIN_PASSWORD.
 * Updates password and promotes to ADMIN if the email already exists.
 */
export async function bootstrapAdmin() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    logger.warn(
      "ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin bootstrap",
      "auth"
    );
    return null;
  }

  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query(
    `SELECT id, role FROM users WHERE email = $1`,
    [email]
  );

  if (rows.length) {
    await pool.query(
      `UPDATE users
       SET password_hash = $1, role = 'ADMIN'
       WHERE id = $2`,
      [passwordHash, rows[0].id]
    );
    logger.success(`Admin user ready (updated): ${email}`, "auth");
    return Number(rows[0].id);
  }

  const firstName = String(process.env.ADMIN_FIRST_NAME || "Admin").trim();
  const lastName = String(process.env.ADMIN_LAST_NAME || "User").trim();
  const company = String(process.env.ADMIN_COMPANY || "System").trim();

  const inserted = await pool.query(
    `INSERT INTO users (email, mobile, password_hash, first_name, last_name, company_name, role)
     VALUES ($1, NULL, $2, $3, $4, $5, 'ADMIN')
     RETURNING id`,
    [email, passwordHash, firstName, lastName, company]
  );
  logger.success(`Admin user created: ${email}`, "auth");
  return Number(inserted.rows[0].id);
}
