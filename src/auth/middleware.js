import pool from "../db.js";
import { verifyToken } from "./jwt.js";
import { publicUser } from "./schema.js";

function bearerToken(req) {
  const header = req.get("authorization") || req.get("Authorization") || "";
  const m = String(header).match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  // EventSource cannot set headers — allow ?token= for SSE logs
  if (req.query?.token) return String(req.query.token).trim();
  return "";
}

export async function requireAuth(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "authentication required" });
    }
    const payload = await verifyToken(token);
    const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [
      payload.userId,
    ]);
    if (!rows.length) {
      return res.status(401).json({ error: "user not found" });
    }
    req.user = publicUser(rows[0]);
    req.auth = payload;
    next();
  } catch {
    return res.status(401).json({ error: "invalid or expired token" });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "ADMIN") {
    return res.status(403).json({ error: "admin access required" });
  }
  next();
}

export async function userHasCountyAccess(userId, state, countySlug) {
  const stateCode = String(state || "")
    .trim()
    .toUpperCase();
  const slug = String(countySlug || "")
    .trim()
    .toLowerCase();
  const { rows } = await pool.query(
    `SELECT 1 FROM user_county_access
     WHERE user_id = $1 AND state_code = $2 AND county_slug = $3`,
    [userId, stateCode, slug]
  );
  return rows.length > 0;
}

/** ADMIN bypasses; USER needs a grant for the county in the route params. */
export async function requireCountyAccess(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "authentication required" });
    }
    if (req.user.role === "ADMIN") return next();

    const state = String(req.params.state || "")
      .trim()
      .toUpperCase();
    const county = String(req.params.county || "")
      .trim()
      .toLowerCase();
    const ok = await userHasCountyAccess(req.user.id, state, county);
    if (!ok) {
      return res.status(403).json({ error: "no access to this county" });
    }
    next();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
