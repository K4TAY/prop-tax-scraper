import { randomBytes, createHash } from "crypto";
import { Router } from "express";
import pool from "../db.js";
import { hashPassword, verifyPassword } from "./password.js";
import { signToken } from "./jwt.js";
import { sendPasswordResetEmail } from "./mail.js";
import {
  normalizeEmail,
  normalizeMobile,
  publicUser,
} from "./schema.js";
import { requireAuth, requireAdmin } from "./middleware.js";
import logger from "../logger.js";

const router = Router();

const MIN_PASSWORD_LEN = 8;

function hashToken(raw) {
  return createHash("sha256").update(String(raw)).digest("hex");
}

function validatePassword(password) {
  if (!password || String(password).length < MIN_PASSWORD_LEN) {
    return `Password must be at least ${MIN_PASSWORD_LEN} characters`;
  }
  return null;
}

router.post("/register", async (req, res) => {
  try {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const mobile = normalizeMobile(body.mobile);
    const password = body.password;
    const firstName = String(body.firstName || body.first_name || "").trim();
    const lastName = String(body.lastName || body.last_name || "").trim();
    const companyName = String(
      body.companyName || body.company_name || body.company || ""
    ).trim();

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "valid email is required" });
    }
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    if (!firstName || !lastName) {
      return res.status(400).json({ error: "first name and last name are required" });
    }
    if (!companyName) {
      return res.status(400).json({ error: "company name is required" });
    }
    if (body.mobile != null && String(body.mobile).trim() !== "" && !mobile) {
      return res.status(400).json({ error: "mobile number is invalid" });
    }

    const passwordHash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (email, mobile, password_hash, first_name, last_name, company_name, role)
       VALUES ($1, $2, $3, $4, $5, $6, 'USER')
       RETURNING *`,
      [email, mobile, passwordHash, firstName, lastName, companyName]
    );
    const user = publicUser(rows[0]);
    const token = await signToken(user);
    res.status(201).json({ token, user });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "email or mobile already registered" });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = req.body?.password;
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    let rows;
    if (username.includes("@")) {
      const email = normalizeEmail(username);
      ({ rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]));
    } else {
      const mobile = normalizeMobile(username);
      if (!mobile) {
        return res.status(400).json({ error: "invalid username" });
      }
      ({ rows } = await pool.query(`SELECT * FROM users WHERE mobile = $1`, [mobile]));
    }

    if (!rows.length) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    const ok = await verifyPassword(password, rows[0].password_hash);
    if (!ok) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    const user = publicUser(rows[0]);
    const token = await signToken(user);
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const grants = await pool.query(
      `SELECT state_code, county_slug, granted_at
       FROM user_county_access
       WHERE user_id = $1
       ORDER BY state_code, county_slug`,
      [req.user.id]
    );
    const requests = await pool.query(
      `SELECT id, state_code, county_slug, status, created_at, reviewed_at
       FROM county_access_requests
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({
      user: req.user,
      grants: grants.rows.map((r) => ({
        state: r.state_code,
        county: r.county_slug,
        grantedAt: r.granted_at,
      })),
      requests: requests.rows.map((r) => ({
        id: Number(r.id),
        state: r.state_code,
        county: r.county_slug,
        status: r.status,
        createdAt: r.created_at,
        reviewedAt: r.reviewed_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/forgot-password", async (req, res) => {
  const generic = {
    message:
      "If an account exists for that email, a reset link has been sent.",
  };
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      return res.json(generic);
    }
    const { rows } = await pool.query(`SELECT id, email FROM users WHERE email = $1`, [
      email,
    ]);
    if (!rows.length) {
      return res.json(generic);
    }

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await pool.query(
      `UPDATE password_reset_tokens SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL`,
      [rows[0].id]
    );
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [rows[0].id, tokenHash, expiresAt]
    );

    try {
      await sendPasswordResetEmail({ to: rows[0].email, resetToken: rawToken });
    } catch (mailErr) {
      logger.error(`Password reset email failed: ${mailErr.message}`, "auth");
      return res.status(503).json({
        error: "unable to send reset email; check SMTP configuration",
      });
    }
    res.json(generic);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const rawToken = String(req.body?.token || "").trim();
    const password = req.body?.password;
    if (!rawToken) {
      return res.status(400).json({ error: "reset token is required" });
    }
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const tokenHash = hashToken(rawToken);
    const { rows } = await pool.query(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1
         AND used_at IS NULL
         AND expires_at > NOW()`,
      [tokenHash]
    );
    if (!rows.length) {
      return res.status(400).json({ error: "invalid or expired reset token" });
    }

    const passwordHash = await hashPassword(password);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
      passwordHash,
      rows[0].user_id,
    ]);
    await pool.query(
      `UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`,
      [rows[0].id]
    );
    res.json({ message: "password updated" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/county-access/request", requireAuth, async (req, res) => {
  try {
    if (req.user.role === "ADMIN") {
      return res.status(400).json({ error: "admins already have full access" });
    }
    const state = String(req.body?.state || "")
      .trim()
      .toUpperCase();
    const county = String(req.body?.county || req.body?.countySlug || "")
      .trim()
      .toLowerCase();
    if (!/^[A-Z]{2}$/.test(state) || !county) {
      return res.status(400).json({ error: "state and county are required" });
    }

    const granted = await pool.query(
      `SELECT 1 FROM user_county_access
       WHERE user_id = $1 AND state_code = $2 AND county_slug = $3`,
      [req.user.id, state, county]
    );
    if (granted.rows.length) {
      return res.json({ status: "approved", message: "already granted" });
    }

    const pending = await pool.query(
      `SELECT id FROM county_access_requests
       WHERE user_id = $1 AND state_code = $2 AND county_slug = $3 AND status = 'pending'`,
      [req.user.id, state, county]
    );
    if (pending.rows.length) {
      return res.json({
        status: "pending",
        id: Number(pending.rows[0].id),
        message: "request already pending",
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO county_access_requests (user_id, state_code, county_slug, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, status`,
      [req.user.id, state, county]
    );
    logger.info(
      `County access requested: user=${req.user.id} ${state}/${county}`,
      "auth"
    );
    res.status(201).json({
      status: rows[0].status,
      id: Number(rows[0].id),
      message: "request submitted",
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.json({ status: "pending", message: "request already pending" });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get("/county-access/mine", requireAuth, async (req, res) => {
  try {
    const grants = await pool.query(
      `SELECT state_code, county_slug, granted_at
       FROM user_county_access WHERE user_id = $1`,
      [req.user.id]
    );
    const requests = await pool.query(
      `SELECT id, state_code, county_slug, status, created_at
       FROM county_access_requests WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({
      grants: grants.rows.map((r) => ({
        state: r.state_code,
        county: r.county_slug,
        grantedAt: r.granted_at,
      })),
      requests: requests.rows.map((r) => ({
        id: Number(r.id),
        state: r.state_code,
        county: r.county_slug,
        status: r.status,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export const adminCountyAccessRouter = Router();

adminCountyAccessRouter.get(
  "/county-access/requests",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const status = String(req.query.status || "pending").trim().toLowerCase();
      const allowed = new Set(["pending", "approved", "denied", "all"]);
      if (!allowed.has(status)) {
        return res.status(400).json({ error: "invalid status filter" });
      }
      const params = [];
      let where = "";
      if (status !== "all") {
        params.push(status);
        where = `WHERE r.status = $1`;
      }
      const { rows } = await pool.query(
        `
        SELECT r.id, r.state_code, r.county_slug, r.status, r.created_at, r.reviewed_at,
               u.id AS user_id, u.email, u.first_name, u.last_name, u.company_name, u.mobile
        FROM county_access_requests r
        JOIN users u ON u.id = r.user_id
        ${where}
        ORDER BY r.created_at ASC
        `,
        params
      );
      res.json({
        requests: rows.map((r) => ({
          id: Number(r.id),
          state: r.state_code,
          county: r.county_slug,
          status: r.status,
          createdAt: r.created_at,
          reviewedAt: r.reviewed_at,
          user: {
            id: Number(r.user_id),
            email: r.email,
            mobile: r.mobile,
            firstName: r.first_name,
            lastName: r.last_name,
            companyName: r.company_name,
          },
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

adminCountyAccessRouter.post(
  "/county-access/requests/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      const action = String(req.body?.action || "")
        .trim()
        .toLowerCase();
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "invalid request id" });
      }
      if (action !== "approve" && action !== "deny") {
        return res.status(400).json({ error: "action must be approve or deny" });
      }

      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT * FROM county_access_requests WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (!rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "request not found" });
      }
      const row = rows[0];
      if (row.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `request already ${row.status}` });
      }

      const newStatus = action === "approve" ? "approved" : "denied";
      await client.query(
        `UPDATE county_access_requests
         SET status = $1, reviewed_by = $2, reviewed_at = NOW()
         WHERE id = $3`,
        [newStatus, req.user.id, id]
      );

      if (action === "approve") {
        await client.query(
          `INSERT INTO user_county_access (user_id, state_code, county_slug, granted_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, state_code, county_slug) DO NOTHING`,
          [row.user_id, row.state_code, row.county_slug, req.user.id]
        );
      }

      await client.query("COMMIT");
      logger.info(
        `County access ${newStatus}: request=${id} user=${row.user_id} ${row.state_code}/${row.county_slug}`,
        "auth"
      );
      res.json({ ok: true, status: newStatus });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

export default router;
