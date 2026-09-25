import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import {
  getBcadBounds,
  getBcadMvtTile,
  getBcadParcelById,
} from "./bcadSchema.js";
import {
  getImportJobStatus,
  startImportJob,
  requestImportCancel,
  subscribeImportProgress,
} from "./bcadImportJob.js";

const router = Router();

router.get("/status", requireAuth, async (_req, res) => {
  try {
    const info = await getBcadBounds();
    res.json({
      ok: true,
      count: info.count,
      bounds: info.bounds,
      import: getImportJobStatus(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/import/status", requireAuth, (_req, res) => {
  res.json(getImportJobStatus());
});

/** SSE progress stream — EventSource uses ?token= */
router.get("/import/events", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const unsub = subscribeImportProgress(res);
  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(keepAlive);
    }
  }, 15000);
  req.on("close", () => {
    clearInterval(keepAlive);
    unsub();
  });
});

router.post("/import/start", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const status = await startImportJob({
      force: body.force === true,
      limit: body.limit ? Number(body.limit) : 0,
      hood: body.hood || null,
      startedBy: req.user?.email || null,
    });
    res.status(202).json(status);
  } catch (err) {
    const code = err.code === "IMPORT_BUSY" ? 409 : 400;
    res.status(code).json({ error: err.message });
  }
});

router.post("/import/cancel", requireAuth, requireAdmin, (_req, res) => {
  const ok = requestImportCancel();
  res.json({ ok, ...getImportJobStatus() });
});

router.get("/parcel/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const parcel = await getBcadParcelById(id);
    if (!parcel) return res.status(404).json({ error: "not found" });
    res.json({ parcel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/tiles/:z/:x/:y.mvt", requireAuth, async (req, res) => {
  try {
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    if (![z, x, y].every((n) => Number.isInteger(n) && n >= 0)) {
      return res.status(400).json({ error: "invalid tile coordinates" });
    }
    if (z > 22) return res.status(400).json({ error: "zoom too high" });

    const mvt = await getBcadMvtTile(z, x, y);
    if (!mvt || (Buffer.isBuffer(mvt) && mvt.length === 0)) {
      res.status(204).end();
      return;
    }
    const buf = Buffer.isBuffer(mvt) ? mvt : Buffer.from(mvt);
    res.setHeader("Content-Type", "application/vnd.mapbox-vector-tile");
    res.setHeader("Cache-Control", "private, max-age=120");
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
