/**
 * Extract the mortgage / note amount filed on a Deed of Trust.
 *
 * Primary source: Bexar clerk indexed `consideration` (publicsearch metadata).
 * Fallback: OCR snippets / free text for common Texas DOT note-amount phrases.
 */

/** Parse "$231,000.00" / "231000" / "231,000" → number or null. */
export function parseMoneyAmount(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 0 && raw < 1e9 ? Math.round(raw * 100) / 100 : null;
  }
  let s = String(raw).trim();
  if (!s || /^n\/?a$/i.test(s) || s === "--" || s === "0" || s === "$0") return null;
  s = s.replace(/USD/gi, "").replace(/\s+/g, " ").trim();
  // Prefer first currency-looking token
  const m =
    s.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/) ||
    s.match(/\b([\d,]{3,}(?:\.\d{1,2})?)\b/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n >= 1e9) return null;
  // Ignore tiny junk (page numbers, etc.)
  if (n < 1000) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Pull note amount from clerk / publicsearch document fields + OCR text.
 * @returns {{ amount: number|null, source: string|null }}
 */
export function extractNoteAmountFromClerkDoc(doc) {
  if (!doc || typeof doc !== "object") {
    return { amount: null, source: null };
  }

  const consideration =
    doc.consideration ??
    doc.Consideration ??
    doc.raw?.consideration ??
    null;
  const fromConsideration = parseMoneyAmount(consideration);
  if (fromConsideration != null) {
    return { amount: fromConsideration, source: "consideration" };
  }

  const textParts = [];
  for (const key of ["ocrText", "ocr_text", "text", "fullText"]) {
    const v = doc[key] ?? doc.raw?.[key];
    if (typeof v === "string" && v.trim()) textParts.push(v);
    else if (Array.isArray(v)) textParts.push(v.filter(Boolean).join(" "));
  }
  const blob = textParts.join("\n");
  if (!blob) return { amount: null, source: null };

  const patterns = [
    /amount\s+of\s+(?:the\s+)?note[:\s]+\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /principal\s+amount[:\s]+\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:note|loan)\s+amount[:\s]+\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /secured\s+(?:hereby\s+)?(?:is|in)\s+(?:the\s+)?(?:principal\s+)?(?:sum\s+of\s+)?\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /sum\s+of\s+\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ];
  for (const re of patterns) {
    const m = blob.match(re);
    if (!m) continue;
    const amount = parseMoneyAmount(m[1]);
    if (amount != null) return { amount, source: "ocr_heuristic" };
  }

  return { amount: null, source: null };
}
