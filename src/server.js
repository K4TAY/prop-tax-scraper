import express from "express";
import { spawn } from "child_process";
import { readdir, readFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import open from "open";
import logger from "./logger.js";
import { getDbCounts, importCsvDirectory, ensureSchema } from "./importCsv.js";
import { browseProperties, listBrowseFields } from "./browse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PUBLIC = join(ROOT, "public");
const DATA = join(ROOT, "data");
const CSV_DIR = join(DATA, "csv");
const PROCESSED_DIR = join(DATA, "processed");
const PORT = Number(process.env.PORT) || 3847;

export const APP_VERSION = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8")
).version;

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC));

let scrapeProc = null;
let scrapeRunning = false;
let importRunning = false;

function parsePythonLine(line) {
  // "13:55:47 INFO message" or "13:55:47 WARNING message"
  const m = line.match(
    /^\d{1,2}:\d{2}:\d{2}\s+(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s+(.*)$/i
  );
  if (!m) return { level: "info", message: line };
  const raw = m[1].toUpperCase();
  let level = "info";
  if (raw === "WARNING" || raw === "WARN") level = "warn";
  else if (raw === "ERROR" || raw === "CRITICAL") level = "error";
  else if (raw === "DEBUG") level = "info";
  const message = m[2];
  if (/OVER 1000|STOPPED|REFUSED|aborted/i.test(message)) {
    level = level === "info" ? "warn" : level;
  }
  if (/wrote \d+\/\d+ rows/i.test(message)) {
    level = "success";
  }
  if (/^Done\b/i.test(message) && !/aborted/i.test(message) && !/failed=/i.test(message)) {
    // keep info; success if no failures embedded awkwardly
  }
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
      // Python logging goes to stderr by default
      const { level, message } = parsePythonLine(line.trim());
      logger.log(message, level, source);
    }
  });
}

async function getStats() {
  let csvCount = 0;
  let over1000 = 0;
  let metaCount = 0;
  let processedCount = 0;
  let neighborhoodCount = 0;

  if (existsSync(join(DATA, "neighborhoods.json"))) {
    try {
      const hoods = JSON.parse(await readFile(join(DATA, "neighborhoods.json"), "utf8"));
      neighborhoodCount = Array.isArray(hoods) ? hoods.length : 0;
    } catch {
      /* ignore */
    }
  }

  if (existsSync(CSV_DIR)) {
    const files = await readdir(CSV_DIR);
    for (const name of files) {
      if (name.endsWith(".csv")) csvCount += 1;
      if (name.endsWith(".OVER_1000")) over1000 += 1;
      if (name.endsWith(".meta.json")) metaCount += 1;
    }
  }

  if (existsSync(PROCESSED_DIR)) {
    const files = await readdir(PROCESSED_DIR);
    processedCount = files.filter((n) => n.endsWith(".csv")).length;
  }

  const db = await getDbCounts();

  return {
    version: APP_VERSION,
    running: scrapeRunning || importRunning,
    scrapeRunning,
    importRunning,
    neighborhoodCount,
    csvCount,
    over1000,
    metaCount,
    processedCount,
    db,
  };
}

app.get("/api/version", (_req, res) => {
  res.json({ version: APP_VERSION });
});

app.get("/api/stats", async (_req, res) => {
  try {
    res.json(await getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/logs/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  logger.addClient(res);
  req.on("close", () => logger.removeClient(res));
});

app.get("/api/logs", (req, res) => {
  const limit = parseInt(String(req.query.limit || "100"), 10) || 100;
  res.json({ logs: logger.getRecentLogs(limit) });
});

app.post("/api/logs/clear", (_req, res) => {
  logger.clear();
  res.json({ message: "Logs cleared" });
});

app.get("/api/scrape/status", (_req, res) => {
  res.json({ running: scrapeRunning, pid: scrapeProc?.pid ?? null });
});

app.post("/api/scrape", (req, res) => {
  if (scrapeRunning || importRunning) {
    return res.status(409).json({
      message: importRunning
        ? "Import is running. Wait for it to finish."
        : "Scraper already running. Use Stop, or wait for it to finish.",
      running: true,
    });
  }

  const {
    limit = 0,
    force = false,
    delay = 0.75,
    hoods = [],
    skipEmpty = false,
  } = req.body || {};

  const args = ["scrape_neighborhoods.py"];
  if (Number(limit) > 0) args.push("--limit", String(Number(limit)));
  if (force) args.push("--force");
  if (skipEmpty) args.push("--skip-empty");
  if (delay != null && delay !== "") args.push("--delay", String(delay));
  if (Array.isArray(hoods)) {
    for (const h of hoods) {
      if (h) args.push("--hood", String(h).trim());
    }
  }

  scrapeRunning = true;
  logger.info(`Starting scraper: python3 ${args.join(" ")}`, "scraper");

  const proc = spawn("python3", args, {
    cwd: ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  scrapeProc = proc;
  pipeChildOutput(proc, "scraper");

  proc.on("error", (err) => {
    logger.error(`Failed to start python: ${err.message}`, "scraper");
    scrapeRunning = false;
    scrapeProc = null;
  });

  proc.on("close", (code, signal) => {
    scrapeRunning = false;
    scrapeProc = null;
    if (signal) {
      logger.warn(`Scraper stopped (signal ${signal})`, "scraper");
    } else if (code === 0) {
      logger.success(`Scraper finished successfully (exit ${code})`, "scraper");
    } else if (code === 3) {
      logger.warn(`Scraper aborted by guard (exit ${code})`, "scraper");
    } else {
      logger.error(`Scraper exited with code ${code}`, "scraper");
    }
  });

  res.json({
    message: "Scraper started — watch Console Output",
    args,
    running: true,
  });
});

app.post("/api/scrape/stop", (_req, res) => {
  if (!scrapeRunning || !scrapeProc) {
    return res.json({ message: "No scraper is running", stopped: false });
  }
  logger.warn("Stop requested — sending SIGTERM to scraper…", "scraper");
  try {
    scrapeProc.kill("SIGTERM");
  } catch (err) {
    logger.error(`Stop failed: ${err.message}`, "scraper");
    return res.status(500).json({ error: err.message });
  }
  res.json({ message: "Stop signal sent", stopped: true });
});

app.post("/api/import", async (req, res) => {
  if (scrapeRunning || importRunning) {
    return res.status(409).json({
      message: scrapeRunning
        ? "Scraper is running. Stop it or wait before importing."
        : "Import already running.",
      running: true,
    });
  }

  importRunning = true;
  res.json({
    message: "Import started — watch Console Output",
    running: true,
  });

  try {
    await importCsvDirectory({
      csvDir: CSV_DIR,
      processedDir: PROCESSED_DIR,
      log: logger,
    });
  } catch (err) {
    logger.error(`Import crashed: ${err.message}`, "import");
  } finally {
    importRunning = false;
  }
});

app.get("/api/import/status", (_req, res) => {
  res.json({ running: importRunning });
});

app.get("/api/browse/fields", (_req, res) => {
  res.json({ fields: listBrowseFields() });
});

app.post("/api/browse/properties", async (req, res) => {
  try {
    const result = await browseProperties(req.body || {});
    res.json(result);
  } catch (err) {
    logger.error(`Browse failed: ${err.message}`, "browse");
    res.status(400).json({ error: err.message });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(join(PUBLIC, "index.html"));
});

app.listen(PORT, "0.0.0.0", async () => {
  const url = `http://localhost:${PORT}`;
  logger.success(`Prop tax scraper UI v${APP_VERSION} → ${url}`, "server");
  try {
    await ensureSchema();
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
