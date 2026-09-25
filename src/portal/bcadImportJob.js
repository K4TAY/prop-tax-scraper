import { runBcadImport } from "./bcadImport.js";
import { resolveS3Config } from "./s3.js";
import { getBcadBounds } from "./bcadSchema.js";

/** @type {null | {
 *   running: boolean,
 *   cancelRequested: boolean,
 *   startedAt: string|null,
 *   finishedAt: string|null,
 *   force: boolean,
 *   progress: object,
 *   result: object|null,
 *   error: string|null,
 *   startedBy: string|null,
 * }} */
let job = {
  running: false,
  cancelRequested: false,
  startedAt: null,
  finishedAt: null,
  force: false,
  progress: {
    phase: "idle",
    message: "No import running",
    pct: 0,
    current: 0,
    total: 0,
    ok: 0,
    failed: 0,
    empty: 0,
    parcels: 0,
    recent: [],
  },
  result: null,
  error: null,
  startedBy: null,
};

/** @type {Set<import('express').Response>} */
const sseClients = new Set();

function snapshot() {
  return {
    running: job.running,
    cancelRequested: job.cancelRequested,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    force: job.force,
    progress: job.progress,
    result: job.result,
    error: job.error,
    startedBy: job.startedBy,
    bucketConfigured: Boolean(resolveS3Config()),
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function setProgress(partial) {
  job.progress = { ...job.progress, ...partial };
  broadcast();
}

export function getImportJobStatus() {
  return snapshot();
}

export function subscribeImportProgress(res) {
  sseClients.add(res);
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  return () => sseClients.delete(res);
}

export function requestImportCancel() {
  if (!job.running) return false;
  job.cancelRequested = true;
  setProgress({ message: "Cancel requested… waiting for current hood" });
  return true;
}

/**
 * @param {{ force?: boolean, limit?: number, hood?: string, startedBy?: string }} opts
 */
export async function startImportJob(opts = {}) {
  if (job.running) {
    const err = new Error("An import is already running");
    err.code = "IMPORT_BUSY";
    throw err;
  }
  if (!resolveS3Config()) {
    const err = new Error(
      "Bucket credentials missing (ENDPOINT, BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY)"
    );
    err.code = "NO_BUCKET";
    throw err;
  }

  job.running = true;
  job.cancelRequested = false;
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.force = opts.force === true;
  job.result = null;
  job.error = null;
  job.startedBy = opts.startedBy || null;
  job.progress = {
    phase: "starting",
    message: opts.force
      ? "Starting full reload (truncate + import)…"
      : "Starting import…",
    pct: 0,
    current: 0,
    total: 0,
    ok: 0,
    failed: 0,
    empty: 0,
    parcels: 0,
    recent: [],
  };
  broadcast();

  // Fire-and-forget; errors stored on job
  (async () => {
    try {
      const result = await runBcadImport({
        force: opts.force === true,
        limit: opts.limit || 0,
        hood: opts.hood || null,
        onProgress: (p) => setProgress(p),
        shouldCancel: () => job.cancelRequested,
      });
      job.result = result;
      if (!result.cancelled) {
        try {
          const bounds = await getBcadBounds();
          job.progress = {
            ...job.progress,
            tableTotal: bounds.count,
            bounds: bounds.bounds,
          };
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      job.error = e.message || String(e);
      setProgress({
        phase: "error",
        message: job.error,
        done: true,
      });
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      broadcast();
    }
  })();

  return snapshot();
}
