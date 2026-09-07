import pool from "../db.js";

export async function ensureAuthSchema(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      mobile TEXT,
      password_hash TEXT NOT NULL,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      company_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'USER'
        CHECK (role IN ('USER', 'ADMIN')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT users_email_unique UNIQUE (email),
      CONSTRAINT users_mobile_unique UNIQUE (mobile)
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS password_reset_tokens_hash_idx
      ON password_reset_tokens (token_hash)
      WHERE used_at IS NULL;

    CREATE TABLE IF NOT EXISTS county_access_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state_code TEXT NOT NULL,
      county_slug TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'denied')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS county_access_requests_status_idx
      ON county_access_requests (status, created_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS county_access_requests_pending_unique
      ON county_access_requests (user_id, state_code, county_slug)
      WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS user_county_access (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state_code TEXT NOT NULL,
      county_slug TEXT NOT NULL,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      granted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (user_id, state_code, county_slug)
    );
  `);
}

/** Normalize mobile to digits only; strip leading US country code 1 when 11 digits. */
export function normalizeMobile(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  if (digits.length < 10) return null;
  return digits;
}

export function normalizeEmail(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    mobile: row.mobile || null,
    firstName: row.first_name,
    lastName: row.last_name,
    companyName: row.company_name,
    role: row.role,
    createdAt: row.created_at,
  };
}
