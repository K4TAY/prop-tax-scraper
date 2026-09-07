import express from "express";
import { spawn } from "child_process";
import { mkdir, readdir, readFile, writeFile, unlink } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import open from "open";
import logger from "./logger.js";
import { importCsvDirectory, ensureSchema } from "./importCsv.js";
import { browseProperties, listBrowseFields } from "./browse.js";
import pool from "./db.js";
import {
  resolveCounty,
  ensureCountyTables,
  getCountyDbCounts,
  findCadSource,
  migrateLegacyBexarTables,
  mapImportStatsBySlug,
  migrateAllPropertiesTables,
  quoteTable,
  countCsvFilesRecursive,
} from "./county.js";
import { moveProcessedToCsv } from "./moveProcessedToCsv.js";
import { ensureAuthSchema } from "./auth/schema.js";
import { bootstrapAdmin } from "./auth/bootstrapAdmin.js";
import authRoutes, { adminCountyAccessRouter } from "./auth/routes.js";
import {
  requireAuth,
  requireAdmin,
  requireCountyAccess,
} from "./auth/middleware.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PUBLIC = join(ROOT, "public");
const DATA = process.env.DATA_DIR || join(ROOT, "data");
const PORT = Number(process.env.PORT) || 3847;
const DATA_UPLOAD_TOKEN = process.env.DATA_UPLOAD_TOKEN || "";

export const APP_VERSION = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8")
).version;

const app = express();

/** @type {Map<string, import('child_process').ChildProcess>} */
const scrapeProcs = new Map();
/** @type {Set<string>} */
const importRunningKeys = new Set();

function countyKey(ctx) {
  return `${ctx.state}/${ctx.slug}`;
}

/** Console source tag, e.g. scraper:Bexar → UI shows [SCRAPER:BEXAR] */
function processSource(kind, ctx) {
  const label = String(ctx.countyName || ctx.slug || "unknown").trim();
  return `${kind}:${label}`;
}

/** Logger facade that always tags messages with the county process source. */
function countyLogger(kind, ctx) {
  const source = processSource(kind, ctx);
  return {
    info: (message) => logger.info(message, source),
    warn: (message) => logger.warn(message, source),
    error: (message) => logger.error(message, source),
    success: (message) => logger.success(message, source),
    log: (message, level = "info") => logger.log(message, level, source),
  };
}

function isCountyBusy(key) {
  return scrapeProcs.has(key) || importRunningKeys.has(key);
}

function busyCounties() {
  return {
    scraping: [...scrapeProcs.keys()],
    importing: [...importRunningKeys],
  };
}

function countCsv(dir) {
  if (!existsSync(dir)) return 0;
  return readdir(dir).then((files) => files.filter((n) => n.endsWith(".csv")).length);
}

function runTarExtract(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn("tar", ["xzf", archivePath, "-C", destDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    proc.stderr.on("data", (b) => {
      err += b.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `tar exited ${code}`));
    });
  });
}

function parsePythonLine(line) {
  const m = line.match(
    /^\d{1,2}:\d{2}:\d{2}\s+(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s+(.*)$/i
  );
  if (!m) return { level: "info", message: line };
  const raw = m[1].toUpperCase();
  let level = "info";
  if (raw === "WARNING" || raw === "WARN") level = "warn";
  else if (raw === "ERROR" || raw === "CRITICAL") level = "error";
  const message = m[2];
  if (/OVER 1000|STOPPED|REFUSED|aborted/i.test(message)) {
    level = level === "info" ? "warn" : level;
  }
  if (/wrote \d+\/\d+ rows/i.test(message)) level = "success";
  if (/^Done\b/i.test(message) && /failed=0/.test(message) && !/aborted/i.test(message)) {
    level = "success";
  }
  return { level, message: line };
}

function pipeChildOutput(proc, source) {
  let stdoutBuf = "";
  let stderrBuf = "";
  proc.stdout.on("data", (buf) => {
    stdoutBuf += buf.toString();
    const parts = stdoutBuf.split(/\r?\n/);
    stdoutBuf = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      const { level, message } = parsePythonLine(line.trim());
      logger.log(message, level, source);
    }
  });
  proc.stderr.on("data", (buf) => {
    stderrBuf += buf.toString();
    const parts = stderrBuf.split(/\r?\n/);
    stderrBuf = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      const { level, message } = parsePythonLine(line.trim());
      logger.log(message, level, source);
    }
  });
}

function resolveCtx(req) {
  return resolveCounty(req.params.state, req.params.county, DATA);
}

async function getCountyStats(ctx) {
  let csvCount = 0;
  let over1000 = 0;
  let metaCount = 0;
  let processedCount = 0;
  let discoveredNeighborhoodCount = 0;

  await mkdir(ctx.csvDir, { recursive: true });
  await mkdir(ctx.processedDir, { recursive: true });

  const indexPath = join(ctx.dataDir, "neighborhoods.json");
  if (existsSync(indexPath)) {
    try {
      const hoods = JSON.parse(await readFile(indexPath, "utf8"));
      discoveredNeighborhoodCount = Array.isArray(hoods) ? hoods.length : 0;
    } catch {
      /* ignore */
    }
  }

  if (existsSync(ctx.csvDir)) {
    const files = await readdir(ctx.csvDir);
    for (const name of files) {
      if (name.endsWith(".OVER_1000")) over1000 += 1;
      if (name.endsWith(".meta.json")) metaCount += 1;
    }
  }
  csvCount = await countCsvFilesRecursive(ctx.csvDir);
  processedCount = await countCsvFilesRecursive(ctx.processedDir);

  const db = await getCountyDbCounts(ctx);
  const source = await findCadSource(ctx.state, ctx.slug);
  const key = countyKey(ctx);
  const scrapeRunning = scrapeProcs.has(key);
  const importRunning = importRunningKeys.has(key);

  // Imported neighborhoods (= DB rows) should match processed CSVs after import.
  // neighborhoods.json is only the scrape discovery list and can be larger.
  const neighborhoodCount = db.neighborhoodDbCount ?? 0;

  return {
    version: APP_VERSION,
    state: ctx.state,
    county: ctx.slug,
    countyName: source?.county_name || ctx.countyName,
    tables: {
      neighborhoods: ctx.neighborhoodsTable,
      properties: ctx.propertiesTable,
    },
    paths: { dataDir: ctx.dataDir, csvDir: ctx.csvDir, processedDir: ctx.processedDir },
    source,
    running: isCountyBusy(key),
    scrapeRunning,
    importRunning,
    busy: busyCounties(),
    neighborhoodCount,
    discoveredNeighborhoodCount,
    csvCount,
    over1000,
    metaCount,
    processedCount,
    db,
  };
}

/** Restore tarball into a county data dir (default tx/bexar). */
app.post(
  "/api/data/restore",
  express.raw({ type: () => true, limit: "500mb" }),
  async (req, res) => {
    if (!DATA_UPLOAD_TOKEN) {
      return res.status(503).json({ error: "DATA_UPLOAD_TOKEN not configured" });
    }
    const token = String(req.get("x-upload-token") || "").trim();
    if (token !== DATA_UPLOAD_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 16) {
      return res.status(400).json({ error: "expected gzipped tar body" });
    }
    const state = String(req.query.state || "tx");
    const county = String(req.query.county || "bexar");
    let ctx;
    try {
      ctx = resolveCounty(state, county, DATA);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const tmp = join("/tmp", `prop-tax-restore-${Date.now()}.tgz`);
    try {
      await mkdir(ctx.dataDir, { recursive: true });
      await mkdir(ctx.csvDir, { recursive: true });
      await mkdir(ctx.processedDir, { recursive: true });
      await writeFile(tmp, body);
      await runTarExtract(tmp, ctx.dataDir);
      const [csvCount, processedCount] = await Promise.all([
        countCsv(ctx.csvDir),
        countCsv(ctx.processedDir),
      ]);
      logger.success(
        `Data restore OK (${ctx.state}/${ctx.slug}): csv=${csvCount} processed=${processedCount}`,
        "server"
      );
      res.json({
        ok: true,
        bytes: body.length,
        csvCount,
        processedCount,
        dataDir: ctx.dataDir,
        county: ctx.slug,
        state: ctx.state,
      });
    } catch (err) {
      logger.error(`Data restore failed: ${err.message}`, "server");
      res.status(500).json({ error: err.message });
    } finally {
      try {
        await unlink(tmp);
      } catch {
        /* ignore */
      }
    }
  }
);

app.use(express.json());

app.get("/api/version", (_req, res) => {
  res.json({ version: APP_VERSION });
});

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminCountyAccessRouter);

/** Move processed/ CSVs back to csv/; migrate schema; truncate property tables. */
app.post("/api/admin/prepare-reimport", async (req, res) => {
  if (!DATA_UPLOAD_TOKEN) {
    return res.status(503).json({ error: "DATA_UPLOAD_TOKEN not configured" });
  }
  const token = String(req.get("x-upload-token") || "").trim();
  if (token !== DATA_UPLOAD_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const dryRun = String(req.query.dryRun || "") === "1";
    const doMigrate = String(req.query.migrate || "1") !== "0";
    const doTruncate = String(req.query.truncate || "1") !== "0";
    const doMove = String(req.query.move || "1") !== "0";

    let migrated = [];
    if (doMigrate && !dryRun) {
      migrated = await migrateAllPropertiesTables();
    }

    let truncated = [];
    if (doTruncate) {
      const { rows } = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND (
            table_name = 'properties'
            OR table_name = 'neighborhoods'
            OR table_name LIKE '%\\_properties' ESCAPE '\\'
            OR table_name LIKE '%\\_neighborhoods' ESCAPE '\\'
          )
        ORDER BY table_name
      `);
      truncated = rows.map((r) => r.table_name);
      if (!dryRun && truncated.length) {
        const list = truncated.map((t) => quoteTable(t)).join(", ");
        await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY`);
      }
    }

    let moveSummary = null;
    if (doMove) {
      moveSummary = await moveProcessedToCsv({
        dataRoot: DATA,
        state: req.query.state,
        county: req.query.county,
        dryRun,
      });
    }

    res.json({
      ok: true,
      dryRun,
      migratedTables: migrated.length,
      truncatedTables: truncated,
      move: moveSummary,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** @deprecated Prefer /api/admin/prepare-reimport */
app.post("/api/admin/move-processed-to-csv", async (req, res) => {
  if (!DATA_UPLOAD_TOKEN) {
    return res.status(503).json({ error: "DATA_UPLOAD_TOKEN not configured" });
  }
  const token = String(req.get("x-upload-token") || "").trim();
  if (token !== DATA_UPLOAD_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const migrate = String(req.query.migrate || "1") !== "0";
    if (migrate) {
      await migrateAllPropertiesTables();
    }
    const summary = await moveProcessedToCsv({
      dataRoot: DATA,
      state: req.query.state,
      county: req.query.county,
      dryRun: String(req.query.dryRun || "") === "1",
    });
    res.json({ ok: true, migrated: migrate, ...summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/cad-sources/states", requireAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT state_code AS state,
             count(*)::int AS county_count,
             count(*) FILTER (WHERE scrape_strategy = 'arcgis_rest')::int AS ready_count
      FROM cad_sources
      WHERE is_active = TRUE
      GROUP BY state_code
      ORDER BY state_code
    `);
    res.json({
      version: APP_VERSION,
      states: rows.map((r) => ({
        state: String(r.state).trim(),
        countyCount: r.county_count,
        readyCount: r.ready_count,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/cad-sources", requireAuth, async (req, res) => {
  try {
    const state = String(req.query.state || "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) {
      return res.status(400).json({ error: "state query param required (e.g. TX)" });
    }
    const { rows } = await pool.query(
      `
      SELECT id, county_name, state_code, client_id, scrape_strategy,
             propaccess_base_url, map_search_url, arcgis_mapserver_url,
             same_stack_as_bexar, notes, evidence_source
      FROM cad_sources
      WHERE is_active = TRUE AND state_code = $1
      ORDER BY county_name
      `,
      [state]
    );
    const counties = rows.map((r) => ({
      ...r,
      state_code: String(r.state_code).trim(),
      slug: String(r.county_name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, ""),
      portalPath: `/c/${String(r.state_code).trim().toLowerCase()}/${String(r.county_name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")}/`,
    }));
    const importStats = await mapImportStatsBySlug(state, counties, DATA);
    res.json({
      state,
      counties: counties.map((c) => {
        const stats = importStats.get(c.slug) || {
          importComplete: false,
          propertyCount: 0,
          uniqueParcelCount: 0,
          nullParcelIdCount: 0,
          unassignedCount: 0,
          neighborhoodCount: 0,
          discoveredNeighborhoodCount: 0,
          processedCsvCount: 0,
          pendingCsvCount: 0,
        };
        return {
          ...c,
          importComplete: stats.importComplete === true,
          propertyCount: stats.propertyCount ?? 0,
          uniqueParcelCount: stats.uniqueParcelCount ?? 0,
          nullParcelIdCount: stats.nullParcelIdCount ?? 0,
          unassignedCount: stats.unassignedCount ?? 0,
          neighborhoodCount: stats.neighborhoodCount ?? 0,
          discoveredNeighborhoodCount: stats.discoveredNeighborhoodCount ?? 0,
          processedCsvCount: stats.processedCsvCount ?? 0,
          pendingCsvCount: stats.pendingCsvCount ?? 0,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- County-scoped APIs ---
app.get(
  "/api/c/:state/:county/stats",
  requireAuth,
  requireCountyAccess,
  async (req, res) => {
    try {
      const ctx = resolveCtx(req);
      await ensureCountyTables(ctx);
      res.json(await getCountyStats(ctx));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

app.get(
  "/api/c/:state/:county/browse/fields",
  requireAuth,
  requireCountyAccess,
  (_req, res) => {
    res.json({ fields: listBrowseFields() });
  }
);

app.post(
  "/api/c/:state/:county/browse/properties",
  requireAuth,
  requireCountyAccess,
  async (req, res) => {
    try {
      const ctx = resolveCtx(req);
      await ensureCountyTables(ctx);
      const result = await browseProperties({
        ...(req.body || {}),
        propertiesTable: ctx.propertiesTable,
      });
      res.json(result);
    } catch (err) {
      logger.error(`Browse failed: ${err.message}`, "browse");
      res.status(400).json({ error: err.message });
    }
  }
);

app.get("/api/logs/stream", requireAuth, requireAdmin, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  logger.addClient(res);
  req.on("close", () => logger.removeClient(res));
});

app.get("/api/logs", requireAuth, requireAdmin, (req, res) => {
  const limit = parseInt(String(req.query.limit || "100"), 10) || 100;
  res.json({ logs: logger.getRecentLogs(limit) });
});

app.post("/api/logs/clear", requireAuth, requireAdmin, (_req, res) => {
  logger.clear();
  res.json({ message: "Logs cleared" });
});

app.post(
  "/api/c/:state/:county/scrape",
  requireAuth,
  requireAdmin,
  async (req, res) => {
  let ctx;
  try {
    ctx = resolveCtx(req);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const key = countyKey(ctx);
  if (isCountyBusy(key)) {
    return res.status(409).json({
      message: importRunningKeys.has(key)
        ? "Import is running for this county. Wait for it to finish."
        : "Scraper already running for this county. Use Stop, or wait for it to finish.",
      running: true,
      busy: busyCounties(),
    });
  }

  const source = await findCadSource(ctx.state, ctx.slug);
  if (source && source.scrape_strategy !== "arcgis_rest") {
    return res.status(501).json({
      message: `Scrape not implemented for strategy "${source.scrape_strategy}" yet.`,
      scrape_strategy: source.scrape_strategy,
    });
  }

  const {
    limit = 0,
    force = false,
    delay = 0.75,
    hoods = [],
    skipEmpty = false,
  } = req.body || {};

  await mkdir(ctx.csvDir, { recursive: true });
  await mkdir(ctx.processedDir, { recursive: true });

  const args = [
    "scrape_neighborhoods.py",
    "--out-dir",
    ctx.csvDir,
    "--processed-dir",
    ctx.processedDir,
    "--index",
    join(ctx.dataDir, "neighborhoods.json"),
  ];
  if (source?.arcgis_mapserver_url) {
    args.push("--map-server", source.arcgis_mapserver_url);
  }
  if (source?.property_search_host) {
    const host = String(source.property_search_host);
    args.push(
      "--map-origin",
      host.startsWith("http") ? host : `https://${host}`
    );
  } else if (source?.arcgis_mapserver_url) {
    try {
      args.push("--map-origin", new URL(source.arcgis_mapserver_url).origin);
    } catch {
      /* ignore invalid URL */
    }
  }
  if (source?.client_id != null) args.push("--cid", String(source.client_id));
  if (source?.neighborhoods_layer_id != null) {
    args.push("--hood-layer", String(source.neighborhoods_layer_id));
  }
  if (source?.properties_layer_id != null) {
    args.push("--prop-layer", String(source.properties_layer_id));
  }
  if (source?.property_id_field) {
    args.push("--prop-id-field", String(source.property_id_field));
  }
  if (source?.hood_filter_field) {
    args.push("--hood-field", String(source.hood_filter_field));
  }
  // Non-TrueAutomation mapSearch counties (e.g. Calhoun BIS) skip setup.json
  if (
    source &&
    (!source.map_search_url ||
      !String(source.map_search_url).includes("trueautomation.com/mapSearch"))
  ) {
    args.push("--skip-setup");
  }
  if (Number(limit) > 0) args.push("--limit", String(Number(limit)));
  if (force) args.push("--force");
  if (skipEmpty) args.push("--skip-empty");
  if (delay != null && delay !== "") args.push("--delay", String(delay));
  if (Array.isArray(hoods)) {
    for (const h of hoods) {
      if (h) args.push("--hood", String(h).trim());
    }
  }

  const log = countyLogger("scraper", ctx);
  log.info(`Starting scraper [${key}]: python3 ${args.join(" ")}`);

  const proc = spawn("python3", args, {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      DATA_DIR: ctx.dataDir,
      CSV_DIR: ctx.csvDir,
      PROCESSED_DIR: ctx.processedDir,
    },
  });
  scrapeProcs.set(key, proc);
  pipeChildOutput(proc, processSource("scraper", ctx));

  proc.on("error", (err) => {
    log.error(`Failed to start python [${key}]: ${err.message}`);
    if (scrapeProcs.get(key) === proc) scrapeProcs.delete(key);
  });

  proc.on("close", (code, signal) => {
    if (scrapeProcs.get(key) === proc) scrapeProcs.delete(key);
    if (signal) log.warn(`Scraper [${key}] stopped (signal ${signal})`);
    else if (code === 0) log.success(`Scraper [${key}] finished successfully (exit ${code})`);
    else if (code === 3) log.warn(`Scraper [${key}] aborted by guard (exit ${code})`);
    else log.error(`Scraper [${key}] exited with code ${code}`);
  });

  res.json({ message: "Scraper started — watch Console Output", args, running: true, county: ctx.slug });
  }
);

app.post(
  "/api/c/:state/:county/scrape/stop",
  requireAuth,
  requireAdmin,
  (req, res) => {
  let ctx;
  try {
    ctx = resolveCtx(req);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const key = countyKey(ctx);
  const proc = scrapeProcs.get(key);
  if (!proc) {
    return res.json({ message: "No scraper is running for this county", stopped: false });
  }
  countyLogger("scraper", ctx).warn(`Stop requested [${key}] — sending SIGTERM…`);
  try {
    proc.kill("SIGTERM");
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.json({ message: "Stop signal sent", stopped: true });
  }
);

app.post(
  "/api/c/:state/:county/import",
  requireAuth,
  requireAdmin,
  async (req, res) => {
  let ctx;
  try {
    ctx = resolveCtx(req);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const key = countyKey(ctx);
  if (isCountyBusy(key)) {
    return res.status(409).json({
      message: scrapeProcs.has(key)
        ? "Scraper is running for this county. Stop it or wait before importing."
        : "Import already running for this county.",
      running: true,
      busy: busyCounties(),
    });
  }

  const log = countyLogger("import", ctx);
  importRunningKeys.add(key);
  res.json({ message: "Import started — watch Console Output", running: true });
  log.info(`Starting import [${key}] → ${ctx.propertiesTable}`);

  try {
    await ensureCountyTables(ctx);
    await importCsvDirectory({
      csvDir: ctx.csvDir,
      processedDir: ctx.processedDir,
      neighborhoodsTable: ctx.neighborhoodsTable,
      propertiesTable: ctx.propertiesTable,
      log,
    });
  } catch (err) {
    log.error(`Import [${key}] crashed: ${err.message}`);
  } finally {
    importRunningKeys.delete(key);
  }
  }
);

// Pages
app.get("/", (_req, res) => {
  res.sendFile(join(PUBLIC, "index.html"));
});

app.get("/login.html", (_req, res) => {
  res.sendFile(join(PUBLIC, "login.html"));
});

app.get("/register.html", (_req, res) => {
  res.sendFile(join(PUBLIC, "register.html"));
});

app.get("/forgot-password.html", (_req, res) => {
  res.sendFile(join(PUBLIC, "forgot-password.html"));
});

app.get("/reset-password.html", (_req, res) => {
  res.sendFile(join(PUBLIC, "reset-password.html"));
});

app.get("/admin.html", (_req, res) => {
  res.sendFile(join(PUBLIC, "admin.html"));
});

app.get("/state.html", (_req, res) => {
  res.sendFile(join(PUBLIC, "state.html"));
});

app.get("/c/:state/:county", (_req, res) => {
  res.sendFile(join(PUBLIC, "county.html"));
});

app.get("/c/:state/:county/", (_req, res) => {
  res.sendFile(join(PUBLIC, "county.html"));
});

app.get("/c/:state/:county/browse", (_req, res) => {
  res.sendFile(join(PUBLIC, "browse.html"));
});

app.get("/c/:state/:county/browse/", (_req, res) => {
  res.sendFile(join(PUBLIC, "browse.html"));
});

app.get("/c/:state/:county/browse.html", (req, res) => {
  res.redirect(302, `/c/${req.params.state}/${req.params.county}/browse`);
});

// Legacy redirects
app.get("/browse.html", (_req, res) => {
  res.redirect(302, "/c/tx/bexar/browse");
});
app.get("/scraper.html", (_req, res) => {
  res.redirect(302, "/c/tx/bexar/");
});

app.use(express.static(PUBLIC));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  if (req.path.startsWith("/c/")) return res.status(404).send("County portal not found");
  res.sendFile(join(PUBLIC, "index.html"));
});

app.listen(PORT, "0.0.0.0", async () => {
  const url = `http://localhost:${PORT}`;
  logger.success(`Prop tax scraper UI v${APP_VERSION} → ${url}`, "server");
  try {
    await ensureSchema();
    await ensureAuthSchema();
    await bootstrapAdmin();
    const mig = await migrateLegacyBexarTables();
    if (mig.migrated) {
      logger.success(
        `Migrated legacy tables → bexar_tx_* (props=${mig.copiedProps}, hoods=${mig.copiedHoods})`,
        "server"
      );
    }
    logger.success("Postgres schema ready", "server");
  } catch (err) {
    logger.error(`Schema init failed: ${err.message}`, "server");
  }
  const shouldOpen =
    process.env.OPEN_BROWSER !== "0" && !process.env.RAILWAY_ENVIRONMENT;
  if (shouldOpen) {
    try {
      await open(url);
    } catch {
      /* ignore */
    }
  }
});
