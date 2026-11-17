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
  getBcadCompletenessStats,
  listBcadBrowseFields,
  listDefaultBcadFilters,
  listBcadMissingDataPresets,
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
  getVaOpportunityWithDetail,
  stampVaOpportunityEnriched,
} from "./vaOpportunities.js";
import {
  VA_LEAD_STATUSES,
  VA_LEAD_STATUS_IDS,
  claimVaLead,
  updateVaLeadStatus,
  releaseVaLead,
  getVaLead,
  listVaLeadPool,
  listVaLeads,
  listVaLeadNotes,
  addVaLeadNote,
} from "./vaLeads.js";
import {
  listClerkInstrumentsForProperty,
  importClerkResultsForProperty,
  prepareClerkFinancingForProperty,
  importClerkFinancingFromPublicsearch,
  enrichDeedOfTrustPagesForProperty,
  listClerkDocumentPages,
  getClerkDocumentPageBytes,
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
    missingDataPresets: listBcadMissingDataPresets(),
    pageSizes: listBcadPageSizes(),
    defaultPageSize: 1000,
  });
});

router.get("/browse/completeness", requireAuth, async (_req, res) => {
  try {
    const completeness = await getBcadCompletenessStats();
    res.json({ completeness });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

/**
 * Pull live public records (ACT Tax + HGO + clerk), rescore, stamp enriched_at.
 * Used by the VA Opportunities grid "Pull records" button.
 */
router.post("/va-opportunities/:id/enrich", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const parcel = await getBcadParcelById(id);
    if (!parcel) return res.status(404).json({ error: "not found" });

    const refresh = await refreshPropertySources(id, {
      year: req.body?.year,
      ownerNo: req.body?.ownerNo ?? 0,
    });
    await upsertVaOpportunityForProperty(id);
    await stampVaOpportunityEnriched(id);
    const opportunity = await getVaOpportunityWithDetail(id);

    res.json({
      ok: refresh.ok,
      errors: refresh.errors || [],
      tax: refresh.tax,
      deeds: refresh.deeds,
      appraisal: refresh.appraisal,
      clerk: refresh.clerk
        ? {
            automated: refresh.clerk.automated,
            needs_manual: refresh.clerk.needs_manual,
            inserted: refresh.clerk.inserted,
            financing_count: refresh.clerk.financing_count,
            message: refresh.clerk.message,
            auto_error: refresh.clerk.auto_error,
          }
        : null,
      opportunity,
    });
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

/** Fetch DOT page screenshots + extract filed mortgage amount for a property. */
router.post("/properties/:id/clerk-dot-pages", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const result = await enrichDeedOfTrustPagesForProperty(id, {
      maxPages: Number(req.body?.maxPages) || 3,
      maxDocs: Number(req.body?.maxDocs) || 1,
    });
    if (req.body?.rescore !== false) {
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

router.get(
  "/properties/:id/clerk-instruments/:instrumentId/pages",
  requireAuth,
  async (req, res) => {
    try {
      const propertyId = Number(req.params.id);
      const instrumentId = Number(req.params.instrumentId);
      if (
        !Number.isFinite(propertyId) ||
        propertyId <= 0 ||
        !Number.isFinite(instrumentId) ||
        instrumentId <= 0
      ) {
        return res.status(400).json({ error: "invalid id" });
      }
      const instruments = await listClerkInstrumentsForProperty(propertyId);
      const owns = instruments.some((r) => Number(r.id) === instrumentId);
      if (!owns) return res.status(404).json({ error: "instrument not found for property" });
      const pages = await listClerkDocumentPages(instrumentId);
      res.json({
        instrument_id: instrumentId,
        pages: pages.map((p) => ({
          page_no: p.page_no,
          content_type: p.content_type,
          byte_length: p.byte_length,
          fetched_at: p.fetched_at,
          url: `/api/bcad/properties/${propertyId}/clerk-instruments/${instrumentId}/pages/${p.page_no}.png`,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.get(
  "/properties/:id/clerk-instruments/:instrumentId/pages/:pageNo.png",
  requireAuth,
  async (req, res) => {
    try {
      const propertyId = Number(req.params.id);
      const instrumentId = Number(req.params.instrumentId);
      const pageNo = Number(req.params.pageNo);
      if (
        !Number.isFinite(propertyId) ||
        propertyId <= 0 ||
        !Number.isFinite(instrumentId) ||
        instrumentId <= 0 ||
        !Number.isFinite(pageNo) ||
        pageNo <= 0
      ) {
        return res.status(400).json({ error: "invalid id" });
      }
      const instruments = await listClerkInstrumentsForProperty(propertyId);
      const owns = instruments.some((r) => Number(r.id) === instrumentId);
      if (!owns) return res.status(404).json({ error: "instrument not found for property" });
      const page = await getClerkDocumentPageBytes(instrumentId, pageNo);
      if (!page?.bytes) return res.status(404).json({ error: "page not found" });
      res.setHeader("Content-Type", page.content_type || "image/png");
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.send(Buffer.from(page.bytes));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

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

// ---------------------------------------------------------------------------
// VA Lead claiming routes — all requireAuth
// ---------------------------------------------------------------------------

/** Metadata: status list etc. */
router.get("/va-leads/meta", requireAuth, (_req, res) => {
  res.json({ statuses: VA_LEAD_STATUSES });
});

/** Unclaimed VA opportunity pool */
router.get("/va-leads/pool", requireAuth, async (req, res) => {
  try {
    const result = await listVaLeadPool({
      limit: req.query.limit,
      offset: req.query.offset,
      tier: req.query.tier || null,
      q: req.query.q || null,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** My (or admin-requested) claimed leads */
router.get("/va-leads/mine", requireAuth, async (req, res) => {
  try {
    let userId = req.user.id;
    const all = req.query.all === "1" || req.query.all === "true";

    if (all) {
      if (req.user.role !== "ADMIN") {
        return res.status(403).json({ error: "admin access required" });
      }
      userId = null; // no user filter → all leads
    } else if (req.query.userId) {
      if (req.user.role !== "ADMIN") {
        return res.status(403).json({ error: "admin access required" });
      }
      userId = Number(req.query.userId);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({ error: "invalid userId" });
      }
    }

    const result = await listVaLeads({
      userId,
      status: req.query.status || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Claim a property */
router.post("/va-leads/:propertyId/claim", requireAuth, async (req, res) => {
  try {
    const propertyId = Number(req.params.propertyId);
    if (!Number.isFinite(propertyId) || propertyId <= 0) {
      return res.status(400).json({ error: "invalid propertyId" });
    }
    const { ok, lead } = await claimVaLead(propertyId, req.user);
    res.status(201).json({ ok, lead });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message });
    }
    // FK violation means property doesn't exist in bcad_properties
    if (err.code === "23503") {
      return res.status(404).json({ error: "property not found" });
    }
    res.status(500).json({ error: err.message });
  }
});

/** Update lead status (owner or admin) */
router.patch("/va-leads/:propertyId", requireAuth, async (req, res) => {
  try {
    const propertyId = Number(req.params.propertyId);
    if (!Number.isFinite(propertyId) || propertyId <= 0) {
      return res.status(400).json({ error: "invalid propertyId" });
    }
    const status = String(req.body?.status || "").trim();
    if (!status || !VA_LEAD_STATUS_IDS.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${VA_LEAD_STATUS_IDS.join(", ")}`,
      });
    }

    const existing = await getVaLead(propertyId);
    if (!existing) return res.status(404).json({ error: "lead not found" });
    if (
      req.user.role !== "ADMIN" &&
      Number(existing.claimed_by_user_id) !== req.user.id
    ) {
      return res.status(403).json({ error: "not your lead" });
    }

    const lead = await updateVaLeadStatus(propertyId, status);
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Release (delete) a lead — owner or admin */
router.delete("/va-leads/:propertyId", requireAuth, async (req, res) => {
  try {
    const propertyId = Number(req.params.propertyId);
    if (!Number.isFinite(propertyId) || propertyId <= 0) {
      return res.status(400).json({ error: "invalid propertyId" });
    }

    const existing = await getVaLead(propertyId);
    if (!existing) return res.status(404).json({ error: "lead not found" });
    if (
      req.user.role !== "ADMIN" &&
      Number(existing.claimed_by_user_id) !== req.user.id
    ) {
      return res.status(403).json({ error: "not your lead" });
    }

    const deleted = await releaseVaLead(propertyId);
    res.json({ ok: deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** List notes for a lead (owner or admin) */
router.get("/va-leads/:propertyId/notes", requireAuth, async (req, res) => {
  try {
    const propertyId = Number(req.params.propertyId);
    if (!Number.isFinite(propertyId) || propertyId <= 0) {
      return res.status(400).json({ error: "invalid propertyId" });
    }

    const existing = await getVaLead(propertyId);
    if (!existing) return res.status(404).json({ error: "lead not found" });
    if (
      req.user.role !== "ADMIN" &&
      Number(existing.claimed_by_user_id) !== req.user.id
    ) {
      return res.status(403).json({ error: "not your lead" });
    }

    const notes = await listVaLeadNotes(propertyId);
    res.json({ bcad_property_id: propertyId, count: notes.length, notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Add a note to a lead (owner or admin) */
router.post("/va-leads/:propertyId/notes", requireAuth, async (req, res) => {
  try {
    const propertyId = Number(req.params.propertyId);
    if (!Number.isFinite(propertyId) || propertyId <= 0) {
      return res.status(400).json({ error: "invalid propertyId" });
    }
    const body = String(req.body?.body || "").trim();
    if (!body) {
      return res.status(400).json({ error: "note body is required" });
    }

    const existing = await getVaLead(propertyId);
    if (!existing) return res.status(404).json({ error: "lead not found" });
    if (
      req.user.role !== "ADMIN" &&
      Number(existing.claimed_by_user_id) !== req.user.id
    ) {
      return res.status(403).json({ error: "not your lead" });
    }

    const note = await addVaLeadNote(propertyId, req.user, body);
    res.status(201).json({ ok: true, note });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------

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
