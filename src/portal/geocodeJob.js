import {
  geocodeVaOpportunities,
  getVaGeocodeStats,
} from "./geocode.js";

/** @type {{
 *   running: boolean,
 *   cancelRequested: boolean,
 *   startedAt: string|null,
 *   finishedAt: string|null,
 *   options: object,
 *   progress: object,
 *   result: object|null,
 *   error: string|null,
 *   startedBy: string|null,
 *   stats: object|null,
 * }} */
let job = {
  running: false,
  cancelRequested: false,
  startedAt: null,
  finishedAt: null,
  options: {},
  progress: {
    phase: "idle",
    message: "No geocode job running",
    pct: 0,
    current: 0,
    total: 0,
    ok: 0,
    not_found: 0,
    error: 0,
    skipped: 0,
    centroid_fallback: 0,
    recent: [],
  },
  result: null,
  error: null,
  startedBy: null,
  stats: null,
};

/** @type {Set<import('express').Response>} */
const sseClients = new Set();

function snapshot() {
  return {
    running: job.running,
    cancelRequested: job.cancelRequested,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    options: job.options,
    progress: job.progress,
    result: job.result,
    error: job.error,
    startedBy: job.startedBy,
    stats: job.stats,
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

export function getGeocodeJobStatus() {
  return snapshot();
}

export function subscribeGeocodeProgress(res) {
  sseClients.add(res);
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  return () => sseClients.delete(res);
}

export function requestGeocodeCancel() {
  if (!job.running) return false;
  job.cancelRequested = true;
  setProgress({
    message: "Cancel requested… finishing current address",
  });
  return true;
}

async function refreshStats(minScore = 0) {
  try {
    job.stats = await getVaGeocodeStats({ minScore });
  } catch (err) {
    job.stats = {
      error: err.message || String(err),
    };
  }
  return job.stats;
}

/**
 * @param {{
 *   limit?: number,
 *   minScore?: number,
 *   force?: boolean,
 *   fallbackCentroid?: boolean,
 *   concurrency?: number,
 *   gapSeconds?: number,
 *   cooldownHours?: number,
 *   startedBy?: string,
 * }} opts
 */
export async function startGeocodeJob(opts = {}) {
  if (job.running) {
    const err = new Error("A geocode job is already running");
    err.code = "GEOCODE_BUSY";
    throw err;
  }

  const options = {
    limit: Math.min(Math.max(Number(opts.limit) || 200, 1), 20000),
    minScore: Math.max(Number(opts.minScore) || 0, 0),
    force: opts.force === true,
    fallbackCentroid: opts.fallbackCentroid === true,
    concurrency: Math.min(Math.max(Number(opts.concurrency) || 10, 1), 10),
    gapSeconds: Math.max(
      Number(opts.gapSeconds != null ? opts.gapSeconds : 0),
      0
    ),
    cooldownHours: Math.max(Number(opts.cooldownHours) || 24, 0),
  };

  job.running = true;
  job.cancelRequested = false;
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.options = options;
  job.result = null;
  job.error = null;
  job.startedBy = opts.startedBy || null;
  job.progress = {
    phase: "starting",
    message: `Starting geocode (limit ${options.limit.toLocaleString()}, ${options.concurrency} workers)…`,
    pct: 0,
    current: 0,
    total: 0,
    ok: 0,
    not_found: 0,
    error: 0,
    skipped: 0,
    centroid_fallback: 0,
    concurrency: options.concurrency,
    recent: [],
  };
  await refreshStats(options.minScore);
  broadcast();

  (async () => {
    try {
      const result = await geocodeVaOpportunities({
        ...options,
        onProgress: (p) => setProgress(p),
        shouldCancel: () => job.cancelRequested,
      });
      job.result = {
        queued: result.queued,
        ok: result.ok,
        not_found: result.not_found,
        error: result.error,
        skipped: result.skipped,
        centroid_fallback: result.centroid_fallback,
        cancelled: Boolean(result.cancelled),
      };
      await refreshStats(options.minScore);
      if (!result.cancelled && !job.progress.done) {
        setProgress({
          phase: "done",
          message: `Finished — ok ${result.ok}, miss ${result.not_found}, err ${result.error}`,
          pct: 100,
          done: true,
        });
      }
    } catch (e) {
      job.error = e.message || String(e);
      setProgress({
        phase: "error",
        message: job.error,
        done: true,
      });
      await refreshStats(options.minScore).catch(() => {});
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      broadcast();
    }
  })();

  return snapshot();
}

/** Status payload with fresh queue stats (for page load / poll). */
export async function getGeocodeJobStatusWithStats(opts = {}) {
  if (!job.running) {
    await refreshStats(opts.minScore != null ? Number(opts.minScore) : 0);
  }
  return snapshot();
}
