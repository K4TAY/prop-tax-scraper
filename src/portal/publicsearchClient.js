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
