import express from "express";
import { spawn } from "child_process";
import { mkdir, readdir, readFile, writeFile, unlink } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import open from "open";
import logger from "./logger.js";
import { importCsvDirectory, ensureSchema, ImportAbortedError } from "./importCsv.js";
import { browseProperties, listBrowseFields, listDefaultBrowseFilters } from "./browse.js";
import {
  searchAllProperties,
  listSearchFields,
  listCountyPropertyTables,
  loadUserCountyAccess,
} from "./searchAll.js";
import pool, { IMPORT_CONCURRENCY } from "./db.js";
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
import {
  truncateCountyTables,
  deleteCountyCsvFiles,
} from "./resetCountyData.js";
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
/** ArcGIS/host lock: hostname → county key currently scraping that host */
const scrapeHostOwner = new Map();
/** Queued scrapes waiting on a busy host: hostname → [{ key, ctx, source, opts }] */
const scrapeHostQueue = new Map();
/** Per-scrape options (autoImport, host) keyed by county key */
const scrapeJobMeta = new Map();
/**
 * Pending county imports (concurrency-limited).
 * @type {{ key: string, ctx: object, resolve: (v: object) => void }[]}
 */
const importWaitQueue = [];
let importActiveCount = 0;
/** @type {Map<string, { aborted: boolean }>} */
const importAbortFlags = new Map();

function countyKey(ctx) {
  return `${ctx.state}/${ctx.slug}`;
}

/** Normalize ArcGIS / CAD host so same-server counties share a lock. */
function scrapeHostFromSource(source) {
  const url = source?.arcgis_mapserver_url;
  if (url) {
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      /* fall through */
    }
  }
  const host = String(source?.property_search_host || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .split("/")[0];
  return (host || "unknown").toLowerCase();
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

function isCountyImportQueued(key) {
  return importWaitQueue.some((job) => job.key === key);
}

function isCountyBusy(key) {
  return (
    scrapeProcs.has(key) ||
    importRunningKeys.has(key) ||
    isCountyImportQueued(key)
  );
}

function isCountyQueued(key) {
  if (isCountyImportQueued(key)) return true;
  for (const q of scrapeHostQueue.values()) {
    if (q.some((job) => job.key === key)) return true;
  }
  return false;
}

function busyCounties() {
  const queued = {};
  for (const [host, q] of scrapeHostQueue.entries()) {
    queued[host] = q.map((j) => j.key);
  }
  return {
    scraping: [...scrapeProcs.keys()],
    importing: [...importRunningKeys],
    importQueued: importWaitQueue.map((j) => j.key),
    importConcurrency: IMPORT_CONCURRENCY,
    importActive: importActiveCount,
    scrapeHosts: Object.fromEntries(scrapeHostOwner),
    scrapeQueued: queued,
  };
}

/** Structured scrape queue for admin UI. */
function getScrapeQueueSnapshot() {
  const running = [];
  for (const [key, proc] of scrapeProcs.entries()) {
    const meta = scrapeJobMeta.get(key);
    const [state, slug] = String(key).split("/");
    running.push({
      key,
      state,
      slug,
      countyName: meta?.ctx?.countyName || slug,
      host: meta?.host || scrapeHostOwner.get(key) || null,
      autoImport: Boolean(meta?.autoImport),
      pid: proc?.pid ?? null,
    });
  }

  const hosts = [];
  let queuedTotal = 0;
  for (const [host, q] of scrapeHostQueue.entries()) {
    const ownerKey = scrapeHostOwner.get(host) || null;
    const items = (q || []).map((job, i) => {
      queuedTotal += 1;
      const [state, slug] = String(job.key).split("/");
      return {
        key: job.key,
        state,
        slug,
        countyName: job.ctx?.countyName || slug,
        position: i + 1,
        autoImport: Boolean(job.opts?.autoImport),
      };
    });
    hosts.push({
      host,
      running: ownerKey,
      queue: items,
    });
  }
  hosts.sort((a, b) => a.host.localeCompare(b.host));

  return {
    running,
    hosts,
    queuedTotal,
    runningTotal: running.length,
  };
}

/** Remove one county from scrape wait queues (does not stop a running scrape). */
function removeFromScrapeQueue(key) {
  let removed = false;
  let hostFound = null;
  for (const [host, q] of scrapeHostQueue.entries()) {
    const next = q.filter((j) => j.key !== key);
    if (next.length !== q.length) {
      removed = true;
      hostFound = host;
      if (next.length) scrapeHostQueue.set(host, next);
      else scrapeHostQueue.delete(host);
    }
  }
  return { removed, key, host: hostFound };
}

/**
 * Clear waiting scrape jobs. Running scrapes are left alone.
 * @param {{ state?: string | null }} opts
 */
function clearScrapeQueue({ state = null } = {}) {
  const stateFilter = state
    ? String(state).trim().toLowerCase()
    : null;
  const cleared = [];
  for (const [host, q] of [...scrapeHostQueue.entries()]) {
    const keep = [];
    for (const job of q) {
      const jobState = String(job.key).split("/")[0];
      if (stateFilter && jobState !== stateFilter) {
        keep.push(job);
        continue;
      }
      cleared.push({ key: job.key, host });
    }
    if (keep.length) scrapeHostQueue.set(host, keep);
    else scrapeHostQueue.delete(host);
  }
  if (cleared.length) {
    logger.warn(
      `Cleared scrape queue: ${cleared.length} job(s)${stateFilter ? ` (state=${stateFilter})` : ""}`,
      "scraper"
    );
  }
  return { cleared, count: cleared.length, queue: getScrapeQueueSnapshot() };
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

function buildScrapeArgs(ctx, source, opts = {}) {
  const {
    limit = 0,
    force = false,
    delay = 0.75,
    hoods = [],
    skipEmpty = false,
    mode = "bulk",
    pageSize = 0,
  } = opts;
  const scrapeMode =
    Array.isArray(hoods) && hoods.some((h) => h)
      ? "by-hood"
      : mode === "by-hood"
        ? "by-hood"
        : "bulk";
  const args = [
    "scrape_neighborhoods.py",
    "--out-dir",
    ctx.csvDir,
    "--processed-dir",
    ctx.processedDir,
    "--index",
    join(ctx.dataDir, "neighborhoods.json"),
    "--mode",
    scrapeMode,
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
  // 0 = auto (layer maxRecordCount). Always pass so CLI default stays explicit.
  const ps = Number(pageSize);
  args.push("--page-size", String(Number.isFinite(ps) && ps >= 0 ? Math.floor(ps) : 0));
  if (Array.isArray(hoods)) {
    for (const h of hoods) {
      if (h) args.push("--hood", String(h).trim());
    }
  }
  return args;
}

/**
 * Run one county import. Caller must already own importRunningKeys for this key.
 */
async function runCountyImportJob(ctx) {
  const key = countyKey(ctx);
  const log = countyLogger("import", ctx);
  const abortFlag = importAbortFlags.get(key) || { aborted: false };
  importAbortFlags.set(key, abortFlag);
  log.info(
    `Starting import [${key}] → ${ctx.propertiesTable} (slot ${importActiveCount}/${IMPORT_CONCURRENCY})`
  );
  try {
    if (abortFlag.aborted) throw new ImportAbortedError();
    await ensureCountyTables(ctx);
    await importCsvDirectory({
      csvDir: ctx.csvDir,
      processedDir: ctx.processedDir,
      neighborhoodsTable: ctx.neighborhoodsTable,
      propertiesTable: ctx.propertiesTable,
      log,
      shouldAbort: () => abortFlag.aborted,
    });
    if (abortFlag.aborted) throw new ImportAbortedError();
    return { ok: true };
  } catch (err) {
    if (err instanceof ImportAbortedError || err?.code === "IMPORT_ABORTED") {
      log.warn(`Import [${key}] aborted`);
      return { ok: false, reason: "aborted" };
    }
    log.error(`Import [${key}] crashed: ${err.message}`);
    return { ok: false, reason: err.message };
  } finally {
    importAbortFlags.delete(key);
  }
}

function pumpImportQueue() {
  while (importActiveCount < IMPORT_CONCURRENCY && importWaitQueue.length) {
    const job = importWaitQueue.shift();
    importRunningKeys.add(job.key);
    importActiveCount += 1;
    importAbortFlags.set(job.key, { aborted: false });
    const log = countyLogger("import", job.ctx);
    log.info(
      `Import dequeued [${job.key}] (active=${importActiveCount}/${IMPORT_CONCURRENCY}, waiting=${importWaitQueue.length})`
    );
    runCountyImportJob(job.ctx)
      .then((result) => job.resolve(result))
      .catch((err) => job.resolve({ ok: false, reason: err.message }))
      .finally(() => {
        importRunningKeys.delete(job.key);
        importAbortFlags.delete(job.key);
        importActiveCount = Math.max(0, importActiveCount - 1);
        pumpImportQueue();
      });
  }
}

/**
 * Clear queued imports and signal all active imports to stop.
 * Active jobs finish their current batch then abort (transaction rolls back).
 */
function cancelAllImports() {
  const clearedQueue = importWaitQueue.splice(0).map((job) => {
    job.resolve({ ok: false, reason: "cancelled" });
    return job.key;
  });
  const aborting = [...importRunningKeys];
  for (const key of aborting) {
    const flag = importAbortFlags.get(key);
    if (flag) flag.aborted = true;
    else importAbortFlags.set(key, { aborted: true });
  }
  if (clearedQueue.length || aborting.length) {
    logger.warn(
      `Stop all imports: clearedQueue=${clearedQueue.length} aborting=${aborting.length} [${aborting.join(", ")}]`,
      "import"
    );
  }
  return {
    clearedQueue,
    aborting,
    busy: busyCounties(),
  };
}

/**
 * Queue a county CSV→Postgres import. Up to IMPORT_CONCURRENCY run at once
 * (default 4; set env IMPORT_CONCURRENCY=8 to raise).
 * @returns {Promise<{ ok: boolean, reason?: string, queued?: boolean }>}
 */
function enqueueCountyImport(ctx) {
  const key = countyKey(ctx);
  if (scrapeProcs.has(key)) {
    return Promise.resolve({
      ok: false,
      reason: "scrape running",
    });
  }
  if (importRunningKeys.has(key) || isCountyImportQueued(key)) {
    return Promise.resolve({ ok: false, reason: "busy" });
  }
  return new Promise((resolve) => {
    importWaitQueue.push({ key, ctx, resolve });
    const log = countyLogger("import", ctx);
    const startsImmediately = importActiveCount < IMPORT_CONCURRENCY;
    log.info(
      startsImmediately
        ? `Import accepted [${key}] (concurrency ${IMPORT_CONCURRENCY})`
        : `Import queued [${key}] (waiting=${importWaitQueue.length}, active=${importActiveCount}/${IMPORT_CONCURRENCY})`
    );
    pumpImportQueue();
  });
}

function releaseScrapeHost(host, key) {
  if (scrapeHostOwner.get(host) === key) {
    scrapeHostOwner.delete(host);
  }
  pumpScrapeHostQueue(host);
}

function pumpScrapeHostQueue(host) {
  if (scrapeHostOwner.has(host)) return;
  const q = scrapeHostQueue.get(host);
  if (!q?.length) {
    scrapeHostQueue.delete(host);
    return;
  }
  while (q.length) {
    const job = q.shift();
    if (isCountyBusy(job.key) || scrapeProcs.has(job.key)) continue;
    spawnCountyScrape(job.ctx, job.source, job.opts);
    break;
  }
  if (!q.length) scrapeHostQueue.delete(host);
  else scrapeHostQueue.set(host, q);
}

function spawnCountyScrape(ctx, source, opts = {}) {
  const key = countyKey(ctx);
  const host = scrapeHostFromSource(source);
  const args = buildScrapeArgs(ctx, source, opts);
  const log = countyLogger("scraper", ctx);
  log.info(`Starting scraper [${key}] host=${host}: python3 ${args.join(" ")}`);

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
  scrapeHostOwner.set(host, key);
  scrapeJobMeta.set(key, {
    host,
    autoImport: Boolean(opts.autoImport),
    ctx,
  });
  pipeChildOutput(proc, processSource("scraper", ctx));

  const finish = async (code, signal) => {
    if (scrapeProcs.get(key) === proc) scrapeProcs.delete(key);
    const meta = scrapeJobMeta.get(key);
    scrapeJobMeta.delete(key);
    if (signal) log.warn(`Scraper [${key}] stopped (signal ${signal})`);
    else if (code === 0) log.success(`Scraper [${key}] finished successfully (exit ${code})`);
    else if (code === 3) log.warn(`Scraper [${key}] aborted by guard (exit ${code})`);
    else log.error(`Scraper [${key}] exited with code ${code}`);

    releaseScrapeHost(host, key);

    if (code === 0 && meta?.autoImport) {
      log.info(`Auto-import queued after scrape [${key}]`);
      // Do not await — keep scrape host slots free and allow parallel imports.
      enqueueCountyImport(ctx).catch((err) => {
        log.error(`Auto-import failed [${key}]: ${err.message || err}`);
      });
    }
  };

  proc.on("error", (err) => {
    log.error(`Failed to start python [${key}]: ${err.message}`);
    if (scrapeProcs.get(key) === proc) scrapeProcs.delete(key);
    scrapeJobMeta.delete(key);
    releaseScrapeHost(host, key);
  });

  proc.on("close", (code, signal) => {
    finish(code, signal).catch((err) => {
      log.error(`Post-scrape hook failed [${key}]: ${err.message}`);
    });
  });

  return { key, host, args };
}

/**
 * Start or queue a scrape. Same ArcGIS host runs one county at a time;
 * different hosts run in parallel.
 */
async function enqueueCountyScrape(ctx, source, opts = {}) {
  const key = countyKey(ctx);
  if (isCountyBusy(key)) {
    return {
      ok: false,
      status: 409,
      queued: false,
      message: importRunningKeys.has(key)
        ? "Import is running for this county. Wait for it to finish."
        : "Scraper already running for this county. Use Stop, or wait for it to finish.",
    };
  }
  if (isCountyQueued(key)) {
    return {
      ok: false,
      status: 409,
      queued: true,
      message: "This county is already queued for scrape.",
    };
  }
  if (source && source.scrape_strategy !== "arcgis_rest") {
    return {
      ok: false,
      status: 501,
      message: `Scrape not implemented for strategy "${source.scrape_strategy}" yet.`,
      scrape_strategy: source.scrape_strategy,
    };
  }

  await mkdir(ctx.csvDir, { recursive: true });
  await mkdir(ctx.processedDir, { recursive: true });

  const host = scrapeHostFromSource(source);
  if (scrapeHostOwner.has(host)) {
    const q = scrapeHostQueue.get(host) || [];
    q.push({ key, ctx, source, opts });
    scrapeHostQueue.set(host, q);
    const owner = scrapeHostOwner.get(host);
    countyLogger("scraper", ctx).info(
      `Queued scrape [${key}] behind ${owner} on host ${host} (position ${q.length})`
    );
    return {
      ok: true,
      status: 202,
      queued: true,
      host,
      position: q.length,
      blockedBy: owner,
      message: `Queued behind ${owner} on ${host}`,
      county: ctx.slug,
    };
  }

  const started = spawnCountyScrape(ctx, source, opts);
  return {
    ok: true,
    status: 200,
    queued: false,
    host: started.host,
    args: started.args,
    message: "Scraper started — watch Console Output",
    running: true,
    county: ctx.slug,
  };
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
          importMode: "none",
          bulkComplete: false,
          byHoodComplete: false,
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
          importMode: stats.importMode || "none",
          bulkComplete: stats.bulkComplete === true,
          byHoodComplete: stats.byHoodComplete === true,
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
    res.json({
      fields: listBrowseFields(),
      defaultFilters: listDefaultBrowseFilters(),
    });
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

/** Cross-county master search (UNION of live county property tables). */
app.get("/api/search/fields", requireAuth, (_req, res) => {
  res.json({ fields: listSearchFields() });
});

app.get("/api/search/counties", requireAuth, async (req, res) => {
  try {
    let allowedCounties = null;
    if (req.user.role !== "ADMIN") {
      allowedCounties = await loadUserCountyAccess(req.user.id);
    }
    const state = req.query.state ? String(req.query.state).trim().toLowerCase() : null;
    const tables = await listCountyPropertyTables({
      state,
      allowedCounties,
    });
    res.json({
      counties: tables.map((t) => ({
        state: t.state,
        slug: t.slug,
        name: t.countyName,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/search/properties", requireAuth, async (req, res) => {
  try {
    let allowedCounties = null;
    if (req.user.role !== "ADMIN") {
      allowedCounties = await loadUserCountyAccess(req.user.id);
      if (!allowedCounties.length) {
        return res.status(403).json({
          error: "No county access granted. Request access from an admin first.",
        });
      }
    }
    const result = await searchAllProperties({
      ...(req.body || {}),
      allowedCounties,
    });
    res.json(result);
  } catch (err) {
    const status = err.status || 400;
    logger.error(`Master search failed: ${err.message}`, "search");
    res.status(status).json({ error: err.message });
  }
});

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

  const source = await findCadSource(ctx.state, ctx.slug);
  const result = await enqueueCountyScrape(ctx, source, req.body || {});
  if (!result.ok) {
    return res.status(result.status || 409).json({
      message: result.message,
      scrape_strategy: result.scrape_strategy,
      running: result.status === 409,
      busy: busyCounties(),
    });
  }
  res.status(result.status || 200).json({
    message: result.message,
    args: result.args,
    running: !result.queued,
    queued: result.queued,
    host: result.host,
    position: result.position,
    blockedBy: result.blockedBy,
    county: result.county,
    busy: busyCounties(),
  });
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
  // Drop from host queue if waiting
  for (const [host, q] of scrapeHostQueue.entries()) {
    const next = q.filter((j) => j.key !== key);
    if (next.length !== q.length) {
      if (next.length) scrapeHostQueue.set(host, next);
      else scrapeHostQueue.delete(host);
      countyLogger("scraper", ctx).warn(`Removed queued scrape [${key}] on ${host}`);
      return res.json({ message: "Removed from scrape queue", stopped: true, queued: true });
    }
  }
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
        : "Import already running or queued for this county.",
      running: true,
      busy: busyCounties(),
    });
  }

  res.json({
    message: `Import queued — up to ${IMPORT_CONCURRENCY} counties import at once (watch Console)`,
    running: true,
    busy: busyCounties(),
  });
  enqueueCountyImport(ctx).catch(() => {});
  }
);

/** Stop all queued/active CSV imports (scrapes continue). */
app.post(
  "/api/imports/stop",
  requireAuth,
  requireAdmin,
  (_req, res) => {
    const result = cancelAllImports();
    res.json({
      message:
        result.aborting.length || result.clearedQueue.length
          ? `Stopping imports: ${result.aborting.length} active, ${result.clearedQueue.length} cleared from queue`
          : "No imports were running or queued",
      ...result,
    });
  }
);

/** Live scrape queue: running jobs + per-host wait lists. */
app.get("/api/scrape/queue", requireAuth, requireAdmin, (_req, res) => {
  res.json(getScrapeQueueSnapshot());
});

/** Remove one county from the scrape wait queue (running scrapes untouched). */
app.post(
  "/api/scrape/queue/remove",
  requireAuth,
  requireAdmin,
  (req, res) => {
    let key = String(req.body?.key || "").trim().toLowerCase();
    if (!key) {
      const state = String(req.body?.state || "").trim().toLowerCase();
      const county = String(req.body?.county || req.body?.slug || "")
        .trim()
        .toLowerCase();
      if (state && county) key = `${state}/${county}`;
    }
    if (!key.includes("/")) {
      return res.status(400).json({ error: "Provide key (state/slug) or state+county" });
    }
    const result = removeFromScrapeQueue(key);
    if (!result.removed) {
      return res.status(404).json({
        error: "County is not in the scrape queue (it may already be running)",
        key,
        queue: getScrapeQueueSnapshot(),
      });
    }
    logger.warn(`Removed queued scrape [${key}] on ${result.host}`, "scraper");
    res.json({
      message: `Removed ${key} from scrape queue`,
      ...result,
      queue: getScrapeQueueSnapshot(),
    });
  }
);

/** Clear all waiting scrape jobs (optionally one state). Does not stop running scrapes. */
app.post(
  "/api/scrape/queue/clear",
  requireAuth,
  requireAdmin,
  (req, res) => {
    const state = req.body?.state
      ? String(req.body.state).trim().toLowerCase()
      : null;
    const result = clearScrapeQueue({ state });
    res.json({
      message:
        result.count > 0
          ? `Cleared ${result.count} queued scrape(s)${state ? ` for ${state.toUpperCase()}` : ""}`
          : "Scrape queue was already empty",
      ...result,
    });
  }
);

/** Bulk scrape: parallel across different ArcGIS hosts; one-at-a-time per host. */
app.post(
  "/api/state/:state/scrape/bulk",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const state = String(req.params.state || "")
      .trim()
      .toLowerCase();
    if (!/^[a-z]{2}$/.test(state)) {
      return res.status(400).json({ error: "Invalid state" });
    }
    const {
      counties = null,
      allReady = false,
      force = true,
      delay = 0.5,
      limit = 0,
      mode = "bulk",
      autoImport = true,
      skipEmpty = false,
    } = req.body || {};

    let slugs = Array.isArray(counties)
      ? counties.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
      : [];
    if (allReady || !slugs.length) {
      const { rows } = await pool.query(
        `
        SELECT county_name
        FROM cad_sources
        WHERE is_active = TRUE
          AND state_code = $1
          AND scrape_strategy = 'arcgis_rest'
        ORDER BY county_name
        `,
        [state.toUpperCase()]
      );
      const ready = rows.map((r) =>
        String(r.county_name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "")
      );
      slugs = allReady || !slugs.length ? ready : slugs.filter((s) => ready.includes(s));
    }

    const opts = { force, delay, limit, mode, autoImport, skipEmpty };
    const started = [];
    const queued = [];
    const skipped = [];

    for (const slug of slugs) {
      let ctx;
      try {
        ctx = resolveCounty(state, slug, DATA);
      } catch (err) {
        skipped.push({ county: slug, reason: err.message });
        continue;
      }
      const source = await findCadSource(ctx.state, ctx.slug);
      if (!source || source.scrape_strategy !== "arcgis_rest") {
        skipped.push({ county: slug, reason: "not arcgis_rest" });
        continue;
      }
      const result = await enqueueCountyScrape(ctx, source, opts);
      if (!result.ok) {
        skipped.push({ county: slug, reason: result.message });
      } else if (result.queued) {
        queued.push({
          county: slug,
          host: result.host,
          position: result.position,
          blockedBy: result.blockedBy,
        });
      } else {
        started.push({ county: slug, host: result.host });
      }
    }

    logger.info(
      `Bulk scrape ${state.toUpperCase()}: started=${started.length} queued=${queued.length} skipped=${skipped.length}`,
      "server"
    );
    res.json({
      message: `Bulk scrape: ${started.length} started, ${queued.length} queued (same-host), ${skipped.length} skipped`,
      started,
      queued,
      skipped,
      busy: busyCounties(),
    });
  }
);

/** Bulk import: run many counties in parallel (local DB; no ArcGIS host lock). */
app.post(
  "/api/state/:state/import/bulk",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const state = String(req.params.state || "")
      .trim()
      .toLowerCase();
    if (!/^[a-z]{2}$/.test(state)) {
      return res.status(400).json({ error: "Invalid state" });
    }
    const { counties = null, pendingOnly = true } = req.body || {};

    let slugs = Array.isArray(counties)
      ? counties.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
      : [];

    if (!slugs.length) {
      const { rows } = await pool.query(
        `
        SELECT county_name
        FROM cad_sources
        WHERE is_active = TRUE AND state_code = $1
        ORDER BY county_name
        `,
        [state.toUpperCase()]
      );
      slugs = rows.map((r) =>
        String(r.county_name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "")
      );
    }

    const started = [];
    const skipped = [];

    for (const slug of slugs) {
      let ctx;
      try {
        ctx = resolveCounty(state, slug, DATA);
      } catch (err) {
        skipped.push({ county: slug, reason: err.message });
        continue;
      }
      const key = countyKey(ctx);
      if (isCountyBusy(key)) {
        skipped.push({ county: slug, reason: "busy" });
        continue;
      }
      if (pendingOnly) {
        const pending = await countCsvFilesRecursive(ctx.csvDir);
        if (!pending) {
          skipped.push({ county: slug, reason: "no pending csv" });
          continue;
        }
      }
      started.push(slug);
      // Queue — pumpImportQueue runs up to IMPORT_CONCURRENCY at once
      enqueueCountyImport(ctx).catch(() => {});
    }

    logger.info(
      `Bulk import ${state.toUpperCase()}: queued=${started.length} skipped=${skipped.length} concurrency=${IMPORT_CONCURRENCY}`,
      "server"
    );
    res.json({
      message: `Bulk import: ${started.length} queued (concurrency ${IMPORT_CONCURRENCY}), ${skipped.length} skipped`,
      started,
      skipped,
      importConcurrency: IMPORT_CONCURRENCY,
      busy: busyCounties(),
    });
  }
);

/** Admin: truncate this county's neighborhoods + properties tables. */
app.post(
  "/api/c/:state/:county/truncate",
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
        message:
          "Scrape or import is running for this county. Stop/wait before truncating.",
        running: true,
        busy: busyCounties(),
      });
    }
    const log = countyLogger("admin", ctx);
    try {
      const result = await truncateCountyTables(ctx);
      log.warn(
        `Truncated tables [${key}]: ${result.truncated.join(", ") || "(none)"} ` +
          `(props was ${result.propertiesBefore}, hoods was ${result.neighborhoodsBefore})`
      );
      res.json({
        ok: true,
        message: `Truncated ${result.truncated.length} table(s)`,
        ...result,
      });
    } catch (err) {
      log.error(`Truncate [${key}] failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  }
);

/** Admin: delete downloaded CSV + sidecars from csv/ and processed/. */
app.post(
  "/api/c/:state/:county/delete-files",
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
        message:
          "Scrape or import is running for this county. Stop/wait before deleting files.",
        running: true,
        busy: busyCounties(),
      });
    }
    const log = countyLogger("admin", ctx);
    try {
      const result = await deleteCountyCsvFiles(ctx);
      log.warn(
        `Deleted download files [${key}]: ${result.deleted} ` +
          `(csv=${result.csvDeleted}, processed=${result.processedDeleted})`
      );
      res.json({
        ok: true,
        message: `Deleted ${result.deleted} file(s)`,
        ...result,
      });
    } catch (err) {
      log.error(`Delete files [${key}] failed: ${err.message}`);
      res.status(500).json({ error: err.message });
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

app.get("/search", (_req, res) => {
  res.sendFile(join(PUBLIC, "search.html"));
});

app.get("/search.html", (_req, res) => {
  res.redirect(302, "/search");
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
