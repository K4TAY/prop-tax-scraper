import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import {
  getBcadBounds,
  getBcadMvtTile,
  getBcadParcelById,
} from "./bcadSchema.js";
import {
  getStreetViewMetaForProperty,
  fetchStreetViewImageForProperty,
} from "./streetView.js";
import {
  getImportJobStatus,
  startImportJob,
  requestImportCancel,
  subscribeImportProgress,
} from "./bcadImportJob.js";
import {
  browseBcadProperties,
  listBcadBrowseFields,
  listDefaultBcadFilters,
  listBcadPageSizes,
} from "./bcadBrowse.js";
import {
  importTaxPaymentsForProperty,
  importTaxPaymentsByGeoId,
  listTaxPaymentsForProperty,
  getTaxAccountForProperty,
  actTaxPaymentUrl,
  actTaxDetailUrl,
  geoIdToCan,
} from "./taxPayments.js";
import {
  importDeedsForProperty,
  importDeedsByGeoId,
  listDeedsForProperty,
  hgoPropertyUrl,
} from "./deeds.js";
import {
  getPropertyDetail,
  refreshPropertySources,
} from "./propertyDetail.js";
import {
  rebuildVaOpportunities,
  upsertVaOpportunityForProperty,
  listVaOpportunities,
  getVaOpportunity,
} from "./vaOpportunities.js";
import {
  listClerkInstrumentsForProperty,
  importClerkResultsForProperty,
  prepareClerkFinancingForProperty,
  importClerkFinancingFromPublicsearch,
  clerkPartySearchUrl,
  clerkDocumentSearchUrl,
  ownerToClerkParty,
} from "./clerkRecords.js";

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

router.get("/browse/meta", requireAuth, (_req, res) => {
  res.json({
    fields: listBcadBrowseFields(),
    defaultFilters: listDefaultBcadFilters(),
    pageSizes: listBcadPageSizes(),
    defaultPageSize: 1000,
  });
});

router.post("/browse", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await browseBcadProperties({
      fields: body.fields,
      filters: body.filters,
      limit: body.limit,
      offset: body.offset,
      sort: body.sort,
      order: body.order,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** List stored ACT Tax account snapshot + payments for a property */
router.get("/properties/:id/tax-payments", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const [account, payments] = await Promise.all([
      getTaxAccountForProperty(id),
      listTaxPaymentsForProperty(id),
    ]);
    res.json({
      bcad_property_id: id,
      account,
      count: payments.length,
      payments,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Fetch from bexar.acttax.com using geo_id → can (digits only) and upsert rows.
 * Body optional: { geo_id } to resolve by geo instead of :id
 */
router.post("/properties/:id/tax-payments/fetch", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const result = await importTaxPaymentsForProperty(id, {
      ownerNo: req.body?.ownerNo ?? 0,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/tax-payments/fetch", requireAuth, async (req, res) => {
  try {
    const geoId = req.body?.geo_id || req.body?.geoId || req.body?.can;
    if (!geoId) return res.status(400).json({ error: "geo_id is required" });
    const result = await importTaxPaymentsByGeoId(geoId, {
      ownerNo: req.body?.ownerNo ?? 0,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/tax-payments/url", requireAuth, (req, res) => {
  try {
    const geoId = req.query.geo_id || req.query.can;
    const can = geoIdToCan(geoId);
    if (!can) return res.status(400).json({ error: "geo_id is required" });
    res.json({
      can,
      payment_url: actTaxPaymentUrl(can),
      detail_url: actTaxDetailUrl(can),
      url: actTaxPaymentUrl(can),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** List stored HGO deed history for a property */
router.get("/properties/:id/deeds", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const deeds = await listDeedsForProperty(id);
    res.json({ bcad_property_id: id, count: deeds.length, deeds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Fetch HGO deed history (pacs_prop_id → propertyId) and upsert */
router.post("/properties/:id/deeds/fetch", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const result = await importDeedsForProperty(id, {
      year: req.body?.year,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/deeds/fetch", requireAuth, async (req, res) => {
  try {
    const geoId = req.body?.geo_id || req.body?.geoId;
    if (!geoId) return res.status(400).json({ error: "geo_id is required" });
    const result = await importDeedsByGeoId(geoId, { year: req.body?.year });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/deeds/url", requireAuth, (req, res) => {
  try {
    const propertyId = req.query.property_id || req.query.pacs_prop_id;
    const year = req.query.year || new Date().getFullYear();
    if (!propertyId) {
      return res.status(400).json({ error: "property_id / pacs_prop_id required" });
    }
    res.json({
      hgo_property_id: String(propertyId).replace(/\D/g, ""),
      url: hgoPropertyUrl(propertyId, year),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** VA opportunity list (scored DV* + mortgage signals) */
router.get("/va-opportunities", requireAuth, async (req, res) => {
  try {
    const result = await listVaOpportunities({
      limit: req.query.limit,
      offset: req.query.offset,
      tier: req.query.tier || null,
      minScore: req.query.min_score ?? req.query.minScore ?? 0,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/va-opportunities/rebuild", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await rebuildVaOpportunities({
      limit: body.limit != null ? Number(body.limit) : null,
      onlyDv: body.onlyDv !== false,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/properties/:id/va-opportunity", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    let row = await getVaOpportunity(id);
    if (!row && req.query.refresh === "1") {
      row = await upsertVaOpportunityForProperty(id);
    }
    if (!row) return res.status(404).json({ error: "not scored yet" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/properties/:id/va-opportunity/score", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const row = await upsertVaOpportunityForProperty(id);
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/properties/:id/clerk-instruments", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const instruments = await listClerkInstrumentsForProperty(id);
    res.json({ bcad_property_id: id, count: instruments.length, instruments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Import captured clerk results for a property.
 * Body: { rows?: [...], text?: string, search_party?, forceMatch?, financingOnly?, source_url? }
 */
router.post("/properties/:id/clerk-instruments/import", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const rows = req.body?.rows;
    const text = req.body?.text;
    const payload = rows != null ? rows : text;
    if (
      payload == null ||
      (typeof payload === "string" && !payload.trim()) ||
      (Array.isArray(payload) && !payload.length)
    ) {
      return res.status(400).json({ error: "rows[] or text required" });
    }
    const result = await importClerkResultsForProperty(id, payload, {
      search_party: req.body?.search_party,
      forceMatch: req.body?.forceMatch === true,
      financingOnly: req.body?.financingOnly !== false,
      source_url: req.body?.source_url,
    });
    if (req.body?.rescore !== false) {
      result.opportunity = await upsertVaOpportunityForProperty(id);
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/properties/:id/clerk-financing", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const packet = await prepareClerkFinancingForProperty(id);
    res.json(packet);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Live publicsearch pull (same path refresh uses). Paste import remains available. */
router.post("/properties/:id/clerk-financing/pull", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const result = await importClerkFinancingFromPublicsearch(id, {
      forceMatch: req.body?.forceMatch === true,
      financingOnly: req.body?.financingOnly !== false,
    });
    if (result.automated && req.body?.rescore !== false) {
      try {
        result.opportunity = await upsertVaOpportunityForProperty(id);
      } catch (e) {
        result.rescore_error = e.message;
      }
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/clerk/search-url", requireAuth, (req, res) => {
  try {
    const party = req.query.party || ownerToClerkParty(req.query.owner || "");
    if (!party) return res.status(400).json({ error: "party or owner required" });
    res.json({ party, url: clerkPartySearchUrl(party) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/clerk/doc-url", requireAuth, (req, res) => {
  try {
    const doc =
      req.query.doc ||
      req.query.doc_number ||
      req.query.instrument ||
      req.query.instrument_number;
    const url = clerkDocumentSearchUrl(doc);
    if (!url) return res.status(400).json({ error: "doc / instrument number required" });
    res.json({ doc_number: String(doc).trim(), url });
  } catch (err) {
    res.status(400).json({ error: err.message });
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

/** Full property packet: CAD + HGO appraisal/exemptions/roll + ACT Tax + deeds */
router.get("/properties/:id/detail", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const detail = await getPropertyDetail(id);
    if (!detail) return res.status(404).json({ error: "not found" });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Street View availability + Maps deep link (optional GOOGLE_MAPS_API_KEY). */
router.get("/properties/:id/street-view", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const meta = await getStreetViewMetaForProperty(id);
    res.json(meta);
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ error: err.message });
  }
});

/**
 * Proxied Static Street View JPEG (keeps API key server-side).
 * Auth: Bearer header or ?token= (for <img src>).
 */
router.get("/properties/:id/street-view.jpg", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const { buf, contentType, meta } = await fetchStreetViewImageForProperty(id, {
      size: req.query.size || "640x400",
      heading: req.query.heading != null ? Number(req.query.heading) : undefined,
      fov: req.query.fov != null ? Number(req.query.fov) : undefined,
      pitch: req.query.pitch != null ? Number(req.query.pitch) : undefined,
    });
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=86400");
    if (meta?.date) res.setHeader("X-Street-View-Date", String(meta.date));
    res.send(buf);
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ error: err.message });
  }
});

/**
 * Refresh from live sources: HGO appraisal/exemptions/roll + deeds,
 * ACT Tax account + payment history.
 */
router.post("/properties/:id/refresh", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const parcel = await getBcadParcelById(id);
    if (!parcel) return res.status(404).json({ error: "not found" });
    const result = await refreshPropertySources(id, {
      year: req.body?.year,
      ownerNo: req.body?.ownerNo ?? 0,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
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
