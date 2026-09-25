import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import {
  getBcadBounds,
  getBcadMvtTile,
  getBcadParcelById,
} from "./bcadSchema.js";

const router = Router();

router.get("/status", requireAuth, async (_req, res) => {
  try {
    const info = await getBcadBounds();
    res.json({
      ok: true,
      count: info.count,
      bounds: info.bounds,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

/**
 * MapLibre vector source tiles. Auth via Authorization header or ?token=
 * (MapLibre cannot always set custom headers on tile requests).
 */
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
