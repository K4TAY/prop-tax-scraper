import express from "express";
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import pool from "../db.js";
import { ensureAuthSchema } from "../auth/schema.js";
import { bootstrapAdmin } from "../auth/bootstrapAdmin.js";
import authRoutes from "../auth/routes.js";
import { requireAuth } from "../auth/middleware.js";
import { ensureBcadSchema } from "./bcadSchema.js";
import bcadRoutes from "./bcadRoutes.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const PUBLIC_PORTAL = join(ROOT, "public", "portal");
const PORT = Number(process.env.PORTAL_PORT || process.env.PORT || 3850);

export const PORTAL_VERSION = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8")
).version;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get("/api/version", (_req, res) => {
  res.json({ version: PORTAL_VERSION, app: "bcad-portal" });
});

app.use("/api/auth", authRoutes);
app.use("/api/bcad", bcadRoutes);

/** Serve portal static assets; HTML pages require login except login.html */
app.get(["/", "/index.html"], (req, res, next) => {
  // Client will redirect if no token; still serve shell for SPA-like UX
  sendPortalFile(res, "index.html", next);
});

app.get("/login.html", (_req, res, next) => {
  sendPortalFile(res, "login.html", next);
});

app.get("/map.html", (_req, res, next) => {
  sendPortalFile(res, "map.html", next);
});

app.use(
  express.static(PUBLIC_PORTAL, {
    index: false,
    maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  })
);

function sendPortalFile(res, name, next) {
  const path = join(PUBLIC_PORTAL, name);
  if (!existsSync(path)) return next();
  res.sendFile(path);
}

/** Auth probe used by the shell */
app.get("/api/portal/me", requireAuth, (req, res) => {
  res.json({ user: req.user, version: PORTAL_VERSION });
});

app.use((err, _req, res, _next) => {
  console.error("[portal]", err);
  res.status(500).json({ error: err.message || "server error" });
});

async function boot() {
  await ensureAuthSchema(pool);
  await bootstrapAdmin();
  try {
    await ensureBcadSchema(pool);
  } catch (err) {
    console.error(
      "[portal] PostGIS / bcad_properties setup failed:",
      err.message
    );
    console.error(
      "  Enable PostGIS on the database (CREATE EXTENSION postgis) then restart."
    );
  }

  app.listen(PORT, () => {
    console.log(`bcad-portal v${PORTAL_VERSION} listening on :${PORT}`);
  });
}

boot().catch((err) => {
  console.error("Portal failed to start:", err);
  process.exit(1);
});
