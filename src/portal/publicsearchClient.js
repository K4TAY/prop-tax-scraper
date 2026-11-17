/**
 * Bexar County Clerk publicsearch.us WebSocket client (GovOS / Kofile).
 * Guest session: HTML sets window.__ort + authToken cookie; search goes over wss://…/ws.
 */

export const PUBLICSEARCH_BASE = "https://bexar.tx.publicsearch.us";
export const PUBLICSEARCH_WS = "wss://bexar.tx.publicsearch.us/ws";

const UA =
  "Mozilla/5.0 (compatible; prop-tax-scraper/bcad-portal; +https://github.com/K4TAY/prop-tax-scraper)";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripEm(s) {
  return String(s || "")
    .replace(/<\/?em>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstPartyName(val) {
  if (Array.isArray(val)) {
    for (const v of val) {
      const s = stripEm(v);
      if (s) return s;
    }
    return null;
  }
  return stripEm(val) || null;
}

/**
 * @returns {Promise<{ ort: string, cookies: string }>}
 */
export async function createPublicsearchSession() {
  const res = await fetch(`${PUBLICSEARCH_BASE}/`, {
    headers: { Accept: "text/html", "User-Agent": UA },
  });
  if (!res.ok) {
    throw new Error(`publicsearch HTML HTTP ${res.status}`);
  }
  const html = await res.text();
  const ort = (html.match(/window\.__ort="([^"]+)"/) || [])[1];
  if (!ort) throw new Error("publicsearch: no guest __ort token in HTML");
  const cookies = (res.headers.getSetCookie?.() || [])
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookies.includes("authToken=")) {
    throw new Error("publicsearch: missing authToken cookie");
  }
  return { ort, cookies };
}

function openPublicsearchWs(session) {
  const ws = new WebSocket(PUBLICSEARCH_WS, {
    headers: {
      Origin: PUBLICSEARCH_BASE,
      "User-Agent": UA,
      Cookie: session.cookies,
    },
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("publicsearch WS connect timeout")), 12000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(t);
      reject(e?.error || new Error("publicsearch WS error"));
    });
  });
}

function wsRequest(ws, msg, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 12000;
  const match = opts.match || (() => true);
  return new Promise((resolve, reject) => {
    const replies = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `publicsearch WS timeout waiting for ${msg.type} (got: ${replies
            .map((r) => r.type)
            .join(", ") || "nothing"})`
        )
      );
    }, timeoutMs);
    const onMsg = (e) => {
      let data;
      try {
        data = JSON.parse(String(e.data));
      } catch {
        return;
      }
      replies.push(data);
      if (match(data, replies)) {
        cleanup();
        resolve({ replies, data });
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
    };
    ws.addEventListener("message", onMsg);
    ws.send(
      JSON.stringify({
        ...msg,
        authToken: msg.authToken,
        correlationId: msg.correlationId || crypto.randomUUID(),
      })
    );
  });
}

/**
 * Map a publicsearch document hash entry → clerk import row shape.
 */
export function publicsearchDocToClerkRow(doc) {
  if (!doc || typeof doc !== "object") return null;
  const doc_number = stripEm(doc.docNumber || doc.instrumentNumber);
  const doc_type = stripEm(doc.docType);
  if (!doc_number && !doc_type) return null;
  const ncb =
    firstPartyName(doc.block2) ||
    firstPartyName(doc.block3) ||
    null;
  const lot = firstPartyName(doc.lot) || null;
  const block = firstPartyName(doc.block) || null;
  const legal = Array.isArray(doc.legalDescription)
    ? doc.legalDescription.map(stripEm).filter(Boolean).join("; ")
    : stripEm(doc.legalDescription);
  const addr =
    stripEm(doc.propertyAddress) ||
    stripEm(doc.address) ||
    (Array.isArray(doc.addresses) ? stripEm(doc.addresses[0]) : null);
  return {
    recorded_date: stripEm(doc.recordedDate),
    doc_type,
    grantor: firstPartyName(doc.grantor),
    grantee: firstPartyName(doc.grantee),
    doc_number,
    book_volume_page: stripEm(doc.bookVolumePage),
    legal_description: legal || null,
    lot,
    block,
    ncb,
    property_address: addr || null,
    raw: doc,
  };
}

/**
 * Quick-search land records by party name (grantor/grantee index).
 * Paginates until exhausted or maxRecords.
 */
export async function searchPublicsearchByParty(partyName, opts = {}) {
  const term = String(partyName || "").trim();
  if (!term) throw new Error("party name required");
  const pageSize = Math.min(50, Math.max(1, Number(opts.pageSize) || 50));
  const maxRecords = Math.min(500, Math.max(pageSize, Number(opts.maxRecords) || 200));
  const recordedDateRange =
    opts.recordedDateRange ||
    `18000101,${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

  const session = opts.session || (await createPublicsearchSession());
  const ws = await openPublicsearchWs(session);

  try {
    // Warm department date metadata (mirrors the browser app).
    await wsRequest(
      ws,
      {
        type: "fetch-department-dates",
        payload: { department: "RP" },
        authToken: session.ort,
      },
      {
        timeoutMs: 8000,
        match: (d) => d.type === "department-dates" || String(d.type).includes("error"),
      }
    ).catch(() => null);

    const byHash = {};
    const byOrder = [];
    let offset = 0;
    let pages = 0;

    while (byOrder.length < maxRecords) {
      const workspaceID = `pts${Date.now().toString(36)}${pages}`;
      const { data } = await wsRequest(
        ws,
        {
          type: "@kofile/FETCH_DOCUMENTS/v4",
          payload: {
            workspaceID,
            query: {
              department: "RP",
              searchType: "quickSearch",
              searchValue: term,
              keywordSearch: false,
              searchOcrText: false,
              recordedDateRange,
              limit: pageSize,
              offset,
            },
          },
          authToken: session.ort,
        },
        {
          timeoutMs: 15000,
          match: (d) =>
            String(d.type).includes("FULFILLED") ||
            String(d.type).includes("REJECTED") ||
            String(d.type).includes("API_ERROR"),
        }
      );

      if (String(data.type).includes("API_ERROR") || String(data.type).includes("REJECTED")) {
        const reason =
          data.payload?.reason?.message ||
          data.payload?.errors ||
          data.type;
        throw new Error(`publicsearch search failed: ${reason}`);
      }

      const chunkOrder = data.payload?.data?.byOrder || [];
      const chunkHash = data.payload?.data?.byHash || {};
      pages++;
      if (!chunkOrder.length) break;

      for (const id of chunkOrder) {
        if (byHash[id]) continue;
        byHash[id] = chunkHash[id];
        byOrder.push(id);
        if (byOrder.length >= maxRecords) break;
      }

      if (chunkOrder.length < pageSize) break;
      offset += pageSize;
      await sleep(opts.throttleMs ?? 80);
    }

    const documents = byOrder.map((id) => byHash[id]).filter(Boolean);
    const rows = documents.map(publicsearchDocToClerkRow).filter(Boolean);

    return {
      party: term,
      recordedDateRange,
      pages,
      total: rows.length,
      rows,
      source: "publicsearch_ws",
    };
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Look up land records by recorded document / instrument number.
 * Returns the same shape as searchPublicsearchByParty.
 */
export async function searchPublicsearchByDocumentNumber(docNumber, opts = {}) {
  const num = String(docNumber || "").trim();
  if (!num || num === "0") throw new Error("document number required");
  const recordedDateRange =
    opts.recordedDateRange ||
    `18000101,${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

  const session = opts.session || (await createPublicsearchSession());
  const ws = await openPublicsearchWs(session);

  try {
    await wsRequest(
      ws,
      {
        type: "fetch-department-dates",
        payload: { department: "RP" },
        authToken: session.ort,
      },
      {
        timeoutMs: 8000,
        match: (d) => d.type === "department-dates" || String(d.type).includes("error"),
      }
    ).catch(() => null);

    // quickSearch by instrument # is reliable; advanced documentNumberRange often hangs.
    const workspaceID = `ptdoc${Date.now().toString(36)}`;
    const { data } = await wsRequest(
      ws,
      {
        type: "@kofile/FETCH_DOCUMENTS/v4",
        payload: {
          workspaceID,
          query: {
            department: "RP",
            searchType: "quickSearch",
            searchValue: num,
            keywordSearch: false,
            searchOcrText: false,
            recordedDateRange,
            limit: Math.min(20, Number(opts.limit) || 10),
            offset: 0,
          },
        },
        authToken: session.ort,
      },
      {
        timeoutMs: 20000,
        match: (d) =>
          String(d.type).includes("FULFILLED") ||
          String(d.type).includes("REJECTED") ||
          String(d.type).includes("API_ERROR"),
      }
    );

    if (String(data.type).includes("API_ERROR") || String(data.type).includes("REJECTED")) {
      const reason =
        data.payload?.reason?.message || data.payload?.errors || data.type;
      throw new Error(`publicsearch doc search failed: ${reason}`);
    }

    const byOrder = data.payload?.data?.byOrder || [];
    const byHash = data.payload?.data?.byHash || {};
    const documents = byOrder.map((id) => byHash[id]).filter(Boolean);
    const rows = documents.map(publicsearchDocToClerkRow).filter(Boolean);
    return {
      docNumber: num,
      recordedDateRange,
      total: rows.length,
      rows,
      session,
      source: "publicsearch_ws_doc",
    };
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Fetch a single document summary (signed page image URLs + consideration).
 * @param {number|string} docId publicsearch internal document id
 * @param {{ session?: { ort: string, cookies: string } }} [opts]
 */
export async function fetchPublicsearchDocument(docId, opts = {}) {
  const id = Number(String(docId).replace(/\D/g, ""));
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("publicsearch doc id required");
  }
  const session = opts.session || (await createPublicsearchSession());
  const ws = await openPublicsearchWs(session);
  try {
    const { data } = await wsRequest(
      ws,
      {
        type: "fetch-a-document",
        payload: { id },
        authToken: session.ort,
      },
      {
        timeoutMs: 20000,
        match: (d) =>
          d.type === "document" ||
          String(d.type).includes("error") ||
          String(d.type).includes("ERROR"),
      }
    );
    if (data.type !== "document") {
      const reason =
        data.payload?.reason?.message ||
        data.payload?.message ||
        data.type;
      throw new Error(`publicsearch document fetch failed: ${reason}`);
    }
    return { session, document: data.payload || {} };
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Download the first N page PNGs for a publicsearch document.
 * Returns absolute URLs resolved against PUBLICSEARCH_BASE plus raw bytes.
 *
 * @param {number|string} docId
 * @param {{ maxPages?: number, session?: object }} [opts]
 */
export async function fetchPublicsearchDocumentPages(docId, opts = {}) {
  const maxPages = Math.min(5, Math.max(1, Number(opts.maxPages) || 3));
  const { session, document } = await fetchPublicsearchDocument(docId, {
    session: opts.session,
  });
  const urls = Array.isArray(document.urls) ? document.urls : [];
  const pages = [];
  for (let i = 0; i < Math.min(maxPages, urls.length); i++) {
    const rel = urls[i];
    const abs = rel.startsWith("http") ? rel : `${PUBLICSEARCH_BASE}${rel}`;
    const res = await fetch(abs, {
      headers: {
        Accept: "image/png,image/*,*/*",
        "User-Agent": UA,
        Cookie: session.cookies,
        Referer: `${PUBLICSEARCH_BASE}/`,
        Origin: PUBLICSEARCH_BASE,
      },
    });
    if (!res.ok) {
      throw new Error(`publicsearch page ${i + 1} HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    pages.push({
      page_no: i + 1,
      content_type: res.headers.get("content-type") || "image/png",
      bytes: buf,
      source_url: abs.split("?")[0],
    });
    await sleep(opts.throttleMs ?? 40);
  }
  return { session, document, pages };
}
