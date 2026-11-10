// Server side of "PDF guides -> SOPs with screenshots". The server NEVER opens or draws a PDF: the browser does that
// (public/pdf/layout.js + read.js) and sends the finished structure, with its screenshots already uploaded as images.
// This file shares the layout logic (listing(), limits) and strictly validates what the browser sends.
const L = require("../public/pdf/layout.js");

const { StepsError, MAX_SHOTS, MAX_PAGES } = L;
const MAX_PROCS = 60, MAX_ITEMS_PROC = 300, MAX_ITEMS = 600, MAX_TEXT_CHARS = 130000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CRUDE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu; // control, invisible and line-separator characters

// Text from the browser: control characters out, whitespace collapsed, capped.
const tidy = (s, max) => String(s == null ? "" : s).replace(CRUDE, " ").replace(/\s+/g, " ").trim().slice(0, max);
const int = (v, lo, hi, dflt) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

// body: { name, pages, warnings, procedures, text }. Returns a clean { name, pages, warnings, procedures, text, imgIds } or throws StepsError.
// Items carry img (an image id, not yet checked against the database) or null. Nothing is trusted: counts, lengths and shapes are all re-cut here.
function cleanSubmission(body) {
  const b = body && typeof body === "object" ? body : {};
  const name = tidy(String(b.name || "guide.pdf").replace(/[\\/]/g, "_"), 120) || "guide.pdf";
  const pages = int(b.pages, 1, 10000, 1);
  const warnings = (Array.isArray(b.warnings) ? b.warnings : []).map((w) => tidy(w, 300)).filter(Boolean).slice(0, 10);
  const text = typeof b.text === "string" ? b.text.replace(/\u0000/g, "").slice(0, MAX_TEXT_CHARS) : "";
  const seenImg = new Set();
  let total = 0, shots = 0, overShots = 0, past = 0;
  const procedures = [];
  for (const p of (Array.isArray(b.procedures) ? b.procedures : []).slice(0, MAX_PROCS)) {
    if (!p || typeof p !== "object") continue;
    const items = [];
    for (const it of (Array.isArray(p.items) ? p.items : []).slice(0, MAX_ITEMS_PROC)) {
      if (!it || typeof it !== "object" || total >= MAX_ITEMS) continue;
      const page = int(it.page, 1, 10000, 1);
      if (page > MAX_PAGES) { past++; continue; } // the reader stops at MAX_PAGES; anything later was not read
      const itext = tidy(it.text, 1000);
      let img = typeof it.img === "string" && UUID.test(it.img) ? it.img.toLowerCase() : null;
      if (img && seenImg.has(img)) img = null; // one picture, one step
      if (img && shots >= MAX_SHOTS) { overShots++; img = null; }
      if (!itext && !img) continue;
      if (img) { seenImg.add(img); shots++; }
      total++;
      items.push({ text: itext, page, ...(Number.isInteger(it.n) && it.n >= 0 && it.n <= 99 ? { n: it.n } : {}), img });
    }
    if (!items.length) continue;
    const title = tidy(p.title, 160) || `Procedure ${procedures.length + 1}`;
    const intro = tidy(p.intro, 1500);
    const pg = items.map((x) => x.page);
    procedures.push({ title, ...(intro ? { intro } : {}), pages: [Math.min(...pg), Math.max(...pg)], items });
  }
  if (overShots) warnings.push(`This guide has more than ${MAX_SHOTS} screenshots. Only the first ${MAX_SHOTS} were used.`);
  if (past) warnings.push(`Only the first ${MAX_PAGES} pages are read.`);
  if (!procedures.length && !text.trim()) throw new StepsError("We couldn't find any steps or text in that PDF.");
  return { name, pages, warnings: warnings.slice(0, 12), procedures, text, imgIds: [...seenImg] };
}

// Keeps only the pictures that passed the database check (owned: Set of image ids). Returns the same shape the listing and the checks use.
function applyOwned(sub, owned) {
  let shots = 0;
  const procedures = sub.procedures.map((p) => ({
    ...p,
    items: p.items.map((it) => { const img = it.img && owned.has(it.img) ? it.img : null; if (img) shots++; return { ...it, img }; }).filter((it) => it.text || it.img),
  })).filter((p) => p.items.length);
  return { ...sub, procedures, shots, imgIds: sub.imgIds.filter((id) => owned.has(id)) };
}

// Plain text for a guide that turned out not to be one (used when the browser could not send text itself).
const guideText = (sub) => L.listing(sub, () => null);

module.exports = {
  cleanSubmission, applyOwned, guideText, StepsError,
  isStepGuide: L.isStepGuide, listing: (res, idOf) => L.listing(res, idOf || ((it) => it.img)),
  MAX_SHOTS, MAX_PAGES, MAX_PROCS, MAX_ITEMS, MAX_TEXT_CHARS,
};
