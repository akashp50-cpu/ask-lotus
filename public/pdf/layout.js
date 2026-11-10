// Turns a "quick reference guide" PDF (numbered steps, usually a screenshot under each step) into procedures.
// This file runs in BOTH places: the browser (public/pdf/read.js, which also draws the screenshots) and node (tests, and the server
// for listing() and limits). It has no node-only or browser-only APIs: pdf.js is handed in, and nothing is drawn here.
//
//   analyze(doc, pdfjs, opts, onProgress) -> { procedures, textOnly, warnings, pages, shots, rawText }
//     procedures: [{ title, intro?, pages:[first,last], items:[{ text, page, n?, shot }] }]
//     shot is null or { page, W, H, crop:{x0,y0,x1,y1} } (page points, top-down). The caller draws it with cropPixels().
//
// How it works: pdf.js gives text positions and the image boxes (from the operator list, following the CTM). Boxes that overlap or
// touch are merged into one screenshot region, logos and number badges are dropped, then the page is read top to bottom:
// text lines pile up until a screenshot closes them into a step. Headings and a restart at "1." begin a new procedure.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PdfLayout = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_SHOTS = 80, MAX_PAGES = 60, MAX_TEXT_PAGES = 120;
  const RENDER_SCALE = 2, MAX_W = 1600, JPEG_Q = 0.82, PAD = 5, MAX_RENDER_PX = 6e6;
  const TIME_BUDGET_MS = 90000;
  const RAW_TEXT_CAP = 120000;
  const OPEN_ERROR = "That PDF couldn't be opened. It may be damaged or password protected.";

  class StepsError extends Error {}

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

  /* ---------- reading one page: lines and screenshot regions ---------- */

  const BOLD_RE = /bold|black|heavy|semibold|demi|extrabold/i;

  function groupLines(items, fonts, vp, pdfjs) {
    const its = [];
    for (const it of items) {
      if (typeof it.str !== "string" || !it.str.trim()) continue;
      const t = pdfjs.Util.transform(vp.transform, it.transform);
      const size = Math.hypot(t[2], t[3]) || it.height || 10;
      if (Math.abs(t[1]) > 0.5 * size && Math.abs(t[0]) < 0.5 * size) continue; // sideways text
      const w = (it.width || 0) * (vp.scale || 1);
      its.push({ str: it.str, x: t[4], y: t[5], w, size, bold: BOLD_RE.test(fonts.get(it.fontName) || ""), font: it.fontName });
    }
    its.sort((a, b) => a.y - b.y || a.x - b.x);
    const groups = [];
    for (const it of its) {
      const g = groups.find((g) => Math.abs(g.y - it.y) <= Math.max(2, 0.45 * Math.min(g.size, it.size)));
      if (g) g.items.push(it); else groups.push({ y: it.y, size: it.size, items: [it] });
    }
    const lines = [];
    for (const g of groups) {
      const row = g.items.sort((a, b) => a.x - b.x);
      let text = "", prev = null;
      for (const it of row) {
        if (prev) {
          const gap = it.x - (prev.x + prev.w);
          if (gap > 0.17 * Math.min(prev.size, it.size) && !/\s$/.test(text) && !/^\s/.test(it.str)) text += " ";
        }
        text += it.str;
        prev = it;
      }
      // A lone small number at the left, in its own font or well apart from the text, is a step number badge.
      let marker = null;
      const first = row[0], second = row[1];
      if (second && /^\d{1,2}$/.test(first.str.trim()) && (first.font !== second.font || second.x - (first.x + first.w) > 8)) {
        marker = +first.str.trim();
        text = text.slice(first.str.length);
      }
      text = clean(text);
      let m;
      if (marker == null && (m = text.match(/^(?:step\s+)?(\d{1,2})\s*[.):]\s+(\S.*)$/i)) && (/^step/i.test(text) || m[2].length > 1)) {
        marker = +m[1];
        text = clean(m[2]);
      }
      // list prefixes ("a.", "2)") don't count when judging whether a line is bold
      const body = row.filter((it) => (it !== first || marker == null) && !/^\(?[a-z0-9]{1,2}[.)]$/i.test(it.str.trim()));
      const chars = body.reduce((n, it) => n + it.str.length, 0) || 1;
      const bold = body.reduce((n, it) => n + (it.bold ? it.str.length : 0), 0) / chars;
      const size = Math.max(...(body.length ? body : row).map((it) => it.size));
      lines.push({ text, marker, x0: row[0].x, x1: Math.max(...row.map((it) => it.x + it.w)), top: g.y - size * 0.82, bottom: g.y + size * 0.22, size, bold, chars: text.length });
    }
    return lines.filter((l) => l.text || l.marker != null).sort((a, b) => a.top - b.top);
  }

  // Image boxes from the operator list, following save/restore/transform. Returns boxes in viewport (top-down) coordinates.
  function imageBoxes(ops, vp, pdfjs) {
    const { OPS, Util } = pdfjs;
    const out = [];
    let m = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const add = (w, h) => {
      const full = Util.transform(vp.transform, m);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [full[0] * x + full[2] * y + full[4], full[1] * x + full[3] * y + full[5]]);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      out.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), pw: w || 0, ph: h || 0 });
    };
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], a = ops.argsArray[i];
      if (fn === OPS.save) stack.push(m);
      else if (fn === OPS.restore) { if (stack.length) m = stack.pop(); }
      else if (fn === OPS.transform) m = Util.transform(m, a);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(m); if (a && a[0]) m = Util.transform(m, a[0]); }
      else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) m = stack.pop(); }
      else if (fn === OPS.paintImageXObject) add(a[1], a[2]);
      else if (fn === OPS.paintInlineImageXObject) add(a[0] && a[0].width, a[0] && a[0].height);
    }
    return out;
  }

  const touches = (a, b, gap) => a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.y0 < b.y1 + gap && a.y1 > b.y0 - gap;

  // Overlapping or touching boxes (a screenshot stored as several image objects) become one region.
  function mergeBoxes(boxes, gap = 6) {
    // Number badges and small icons sit right beside screenshots: they must not be swallowed by them.
    const regs = boxes.filter((b) => (b.x1 - b.x0) >= 45 || (b.y1 - b.y0) >= 45).map((b) => ({ ...b }));
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < regs.length && !changed; i++) {
        for (let j = i + 1; j < regs.length; j++) {
          if (touches(regs[i], regs[j], gap)) {
            const a = regs[i], b = regs[j];
            regs[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), pw: Math.max(a.pw, b.pw), ph: a.ph + b.ph };
            regs.splice(j, 1);
            changed = true;
            break;
          }
        }
      }
    }
    return regs.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  }

  // Keeps screenshots; drops logos, number badges, header/footer art and full-page backgrounds.
  function pickShots(regs, W, H) {
    const area = W * H;
    return regs.filter((r) => {
      const w = r.x1 - r.x0, h = r.y1 - r.y0;
      if (w < 90 || h < 34) return false;
      if (w * h > 0.88 * area) return false;
      const inBand = r.y1 < H * 0.1 || r.y0 > H * 0.93;
      if (inBand && w * h < 0.12 * area) return false;
      return true;
    });
  }

  /* ---------- reading order -> steps ---------- */

  const isFooterText = (t) => /confidential|proprietary|©|\(c\)\s*\d{4}|copyright|^page\s+\d+(\s+of\s+\d+)?$/i.test(t) || /^\d{1,3}$/.test(t);
  const NOTE_START = /^(note|notes|tip|tips|important|warning|caution|example|examples|see|reminder|please|keep in mind)\b/i;

  function bodySize(lines) {
    const hist = new Map();
    for (const l of lines) { const k = Math.round(l.size * 2) / 2; hist.set(k, (hist.get(k) || 0) + l.chars); }
    let best = 11, n = 0;
    for (const [k, v] of hist) if (v > n) { best = k; n = v; }
    return best;
  }

  function isHeading(l, body) {
    if (l.marker != null || !l.text) return false;
    const words = l.text.split(/\s+/).length;
    if (l.text.length > 120 || words > 16) return false;
    if (/[.,;]$/.test(l.text)) return false;
    if (NOTE_START.test(l.text)) return false;
    if (/^(steps?\s+to|how\s+to)\b/i.test(l.text)) return true;
    if (l.size >= body * 1.22) return true;
    return l.bold >= 0.9 && words <= 10 && l.size >= body * 0.95;
  }

  // pages: [{ n, W, H, lines, shots }]. Returns the procedures; each item with a screenshot carries shot:{page, box, W, H}.
  function buildProcedures(pages, fallbackTitle) {
    const all = pages.flatMap((p) => p.lines);
    const body = bodySize(all);
    const procs = [];
    let cur = null, buf = [], lastNum = 0, intro = "", parent = "";
    const parts = new Map();

    const newProc = (title) => {
      cur = { title: clean(title).replace(/[:\s]+$/, "").slice(0, 160), intro, items: [], hasNum: false, shots: 0 };
      intro = "";
      procs.push(cur);
      lastNum = 0;
    };
    // "a. Modify Amount" under "Adjust a Single Charge" is its own procedure, named after both.
    const SUB = /^\(?[a-z][.)]\s+/i;
    const headTitle = (t) => {
      if (SUB.test(t)) return parent ? `${parent}: ${t.replace(SUB, "")}` : t.replace(SUB, "");
      parent = clean(t).replace(/[:\s]+$/, "");
      return t;
    };
    const ensure = () => { if (!cur) newProc(fallbackTitle || "Procedure 1"); };

    // Turns the pending lines into items. The screenshot (if any) goes with the LAST chunk: two step texts above one picture
    // are two steps, and the picture belongs to the one right above it.
    const flush = (shot, page) => {
      const chunks = [];
      for (const l of buf) {
        if (l.marker != null || !chunks.length) chunks.push({ n: l.marker, lines: [l] });
        else chunks[chunks.length - 1].lines.push(l);
      }
      buf = [];
      if (!chunks.length && !shot) return;
      ensure();
      if (!chunks.length) chunks.push({ n: null, lines: [] });
      chunks.forEach((c, i) => {
        const text = clean(c.lines.map((l) => l.text).join(" "));
        const it = { text, page: c.lines.length ? c.lines[0].page : page, n: c.n ?? undefined, shot: i === chunks.length - 1 ? shot : null };
        if (c.n != null) cur.hasNum = true;
        if (it.shot) cur.shots++;
        if (text || it.shot) cur.items.push(it);
      });
    };

    for (const p of pages) {
      const ev = [];
      for (const l of p.lines) ev.push({ k: "line", key: l.top, l: { ...l, page: p.n } });
      for (const s of p.shots) ev.push({ k: "shot", key: s.y1 - 0.01, s });
      ev.sort((a, b) => a.key - b.key);
      let prevHeading = null;
      for (const e of ev) {
        if (e.k === "shot") { flush({ page: p.n, box: e.s, W: p.W, H: p.H }, p.n); prevHeading = null; continue; }
        const l = e.l;
        if (isHeading(l, body)) {
          // consecutive heading lines of the same size are one wrapped title
          if (prevHeading && Math.abs(prevHeading.size - l.size) < 0.6 && l.top - prevHeading.bottom < l.size * 1.2 && !buf.length) {
            cur.title = clean(cur.title + " " + l.text).slice(0, 160);
            prevHeading = l;
            continue;
          }
          flush(null, p.n);
          if (cur && !cur.items.length) { cur.title = clean(headTitle(l.text)).replace(/[:\s]+$/, "").slice(0, 160); }
          else {
            if (cur && !cur.shots && !cur.hasNum) { // an introduction, not a procedure: its text rides along with the next one
              intro = clean(cur.items.map((x) => x.text).join(" ")).slice(0, 1500);
              procs.pop();
            }
            newProc(headTitle(l.text));
          }
          prevHeading = l;
          continue;
        }
        prevHeading = null;
        if (l.marker === 1 && cur && lastNum >= 2) {
          flush(null, p.n);
          const base = cur.title.replace(/\s*\(part \d+\)$/, "");
          const k = (parts.get(base) || 1) + 1;
          parts.set(base, k);
          newProc(`${base} (part ${k})`);
        }
        if (l.marker != null) lastNum = l.marker;
        buf.push(l);
      }
    }
    flush(null, pages.length ? pages[pages.length - 1].n : 1);
    return procs.filter((p) => p.items.length);
  }

  /* ---------- drawing helpers (the caller owns the canvas) ---------- */

  // Scale to draw a page at: 2 at most, lower for very large pages so the bitmap stays small (phones).
  function pickScale(W, H, maxPx = MAX_RENDER_PX) {
    return Math.max(0.5, Math.min(RENDER_SCALE, Math.sqrt(maxPx / Math.max(1, W * H))));
  }

  // Pixel rectangle to copy out of a page drawn at `scale`, and the size of the picture (width capped at MAX_W).
  function cropPixels(crop, scale, canvasW, canvasH) {
    const sx = Math.max(0, Math.round(crop.x0 * scale)), sy = Math.max(0, Math.round(crop.y0 * scale));
    const sw = Math.max(1, Math.min(canvasW - sx, Math.round((crop.x1 - crop.x0) * scale)));
    const sh = Math.max(1, Math.min(canvasH - sy, Math.round((crop.y1 - crop.y0) * scale)));
    const k = sw > MAX_W ? MAX_W / sw : 1;
    return { sx, sy, sw, sh, ow: Math.max(1, Math.round(sw * k)), oh: Math.max(1, Math.round(sh * k)) };
  }

  // The crop of one screenshot box with a little padding, so the red highlight boxes come along.
  // The top edge never reaches up into the descenders of step text sitting just above the picture.
  function cropRect(box, W, H, lines) {
    const above = lines.filter((l) => l.bottom > box.y0 - PAD && l.bottom <= box.y0 + 1 && l.x1 > box.x0 && l.x0 < box.x1).map((l) => l.bottom + 0.5);
    return { x0: Math.max(0, box.x0 - PAD), y0: Math.max(0, box.y0 - PAD, ...above), x1: Math.min(W, box.x1 + PAD), y1: Math.min(H, box.y1 + PAD) };
  }

  /* ---------- reading a whole document ---------- */

  // The text of one page the way the plain-text import reads it.
  function pageRawText(tc) {
    let line = "";
    for (const it of tc.items) {
      if (typeof it.str !== "string") continue;
      line += it.str;
      if (it.hasEOL) line += "\n"; else if (it.str && !it.str.endsWith(" ")) line += " ";
    }
    return line.replace(/[ \t]+\n/g, "\n");
  }

  // Plain text of pages from..to (for PDFs that are not step guides).
  async function extraText(doc, pdfjs, from, to, room) {
    const out = [];
    let len = 0;
    for (let p = from; p <= Math.min(to, doc.numPages) && len < room; p++) {
      const page = await doc.getPage(p);
      const t = pageRawText(await page.getTextContent());
      out.push(t); len += t.length;
      page.cleanup();
    }
    return out.join("\n\n");
  }

  // doc: an open pdf.js document. opts: { fallbackTitle, maxShots, maxPages }.
  // onProgress({ phase:"read", page, of }) after each page.
  async function analyze(doc, pdfjs, opts = {}, onProgress) {
    const maxShots = opts.maxShots || MAX_SHOTS, maxPages = opts.maxPages || MAX_PAGES;
    const warnings = [];
    const total = doc.numPages;
    const count = Math.min(total, maxPages);
    if (total > maxPages) warnings.push(`This PDF has ${total} pages. Only the first ${maxPages} were read.`);

    const pages = [];
    const raw = [];
    let rawLen = 0, imageBoxesSeen = 0;
    for (let n = 1; n <= count; n++) {
      if (onProgress) onProgress({ phase: "read", page: n, of: count });
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const ops = await page.getOperatorList();
      const tc = await page.getTextContent();
      const fonts = new Map();
      for (const it of tc.items) {
        if (!it.fontName || fonts.has(it.fontName)) continue;
        let nm = "";
        try { if (page.commonObjs.has(it.fontName)) nm = page.commonObjs.get(it.fontName).name || ""; } catch { /* name stays blank */ }
        fonts.set(it.fontName, nm || String((tc.styles[it.fontName] || {}).fontFamily || ""));
      }
      const lines = groupLines(tc.items, fonts, vp, pdfjs);
      const boxes = imageBoxes(ops, vp, pdfjs);
      imageBoxesSeen += boxes.length;
      pages.push({ n, W: vp.width, H: vp.height, lines, shots: pickShots(mergeBoxes(boxes), vp.width, vp.height) });
      if (rawLen < RAW_TEXT_CAP) { const t = pageRawText(tc); raw.push(t); rawLen += t.length; }
      // Free the page's decoded images now: holding every page's operator list is what runs a small device out of memory.
      page.cleanup();
    }

    // Footers, page numbers and running headers out; text on top of a screenshot out.
    const key = (l) => `${clean(l.text).toLowerCase().replace(/\d+/g, "#")}|${Math.round(l.top / 6)}`;
    const seen = new Map();
    for (const p of pages) for (const k of new Set(p.lines.filter((l) => l.top < p.H * 0.1 || l.bottom > p.H * 0.9).map(key))) seen.set(k, (seen.get(k) || 0) + 1);
    let textChars = 0;
    for (const p of pages) {
      p.lines = p.lines.filter((l) => {
        const edge = l.top < p.H * 0.1 || l.bottom > p.H * 0.9;
        if (edge && (isFooterText(l.text) || (pages.length >= 3 && seen.get(key(l)) >= Math.max(3, pages.length * 0.5)))) return false;
        if (/hilton\s+confidential/i.test(l.text)) return false;
        const cy = (l.top + l.bottom) / 2;
        if (p.shots.some((s) => cy > s.y0 && cy < s.y1 && l.x0 >= s.x0 - 4 && l.x1 <= s.x1 + 4)) return false;
        return true;
      });
      for (const l of p.lines) textChars += l.chars;
    }

    const shotsFound = pages.reduce((n, p) => n + p.shots.length, 0);
    if (textChars < 8) {
      throw new StepsError(imageBoxesSeen
        ? "This PDF looks like a scan or a set of pictures, so there is no text to read. Use a PDF saved from the original document, or type the steps in."
        : "We couldn't find any text in that PDF.");
    }

    // Cut at the screenshot limit: keep reading order, drop everything after the last allowed screenshot.
    let kept = 0, cutAt = null;
    for (const p of pages) {
      if (cutAt) { p.shots = []; continue; }
      if (kept + p.shots.length > maxShots) {
        const room = maxShots - kept;
        const cutY = p.shots[room - 1] ? p.shots[room - 1].y1 : 0;
        p.shots = p.shots.slice(0, room);
        p.lines = p.lines.filter((l) => l.top < cutY);
        cutAt = p.n;
        kept = maxShots;
      } else kept += p.shots.length;
    }
    if (cutAt) {
      warnings.push(`This guide has ${shotsFound} screenshots. Only the first ${maxShots} were used, up to page ${cutAt}.`);
      for (const p of pages) if (p.n > cutAt) p.lines = [];
    }

    const procs = buildProcedures(pages.filter((p) => p.lines.length || p.shots.length), opts.fallbackTitle);

    const byN = new Map(pages.map((p) => [p.n, p]));
    const procedures = procs.map((pr, i) => {
      const items = pr.items.map((it) => {
        let shot = null;
        if (it.shot) { const p = byN.get(it.shot.page); shot = { page: p.n, W: p.W, H: p.H, crop: cropRect(it.shot.box, p.W, p.H, p.lines) }; }
        return { text: it.text, page: it.page, ...(it.n != null ? { n: it.n } : {}), shot };
      });
      const pg = items.map((x) => x.page);
      return { title: (pr.title && !/^(steps?|procedure|overview)$/i.test(pr.title) && pr.title) || (opts.fallbackTitle ? `${opts.fallbackTitle}${procs.length > 1 ? " " + (i + 1) : ""}` : `Procedure ${i + 1}`), ...(pr.intro ? { intro: pr.intro } : {}), pages: [Math.min(...pg), Math.max(...pg)], items };
    });
    const shots = countShots({ procedures });
    return { procedures, textOnly: shots === 0, warnings, pages: total, shots, rawText: raw.join("\n\n") };
  }

  // Items that have a picture. Items carry shot (to be drawn), blob (drawn, in the browser) or img (uploaded: an image id).
  const hasPic = (it) => !!(it.shot || it.blob || it.img);
  const countShots = (res) => res.procedures.reduce((n, p) => n + p.items.filter(hasPic).length, 0);

  // Is this PDF really a screenshot guide (as opposed to a policy document with a few pictures)?
  const isStepGuide = (r) => r.shots >= 2 && r.shots >= Math.min(r.pages, MAX_PAGES) * 0.25;

  // What the writing model reads: procedures, then numbered "step text [img:ID]". idOf(item) -> id string, or falsy for no picture.
  function listing(res, idOf) {
    const out = [];
    res.procedures.forEach((p, i) => {
      out.push(`PROCEDURE ${i + 1}: ${p.title} (pages ${p.pages[0]}${p.pages[1] !== p.pages[0] ? "-" + p.pages[1] : ""})`);
      if (p.intro) out.push(`  Introduction: ${p.intro.slice(0, 600)}`);
      p.items.forEach((it, j) => {
        const id = idOf(it);
        out.push(`  ${j + 1}. ${it.text || "(no text)"}${id ? ` [img:${id}]` : ""}`);
      });
    });
    return out.join("\n");
  }

  return {
    analyze, extraText, isStepGuide, listing, countShots, pickScale, cropPixels, cropRect, StepsError,
    MAX_SHOTS, MAX_PAGES, MAX_TEXT_PAGES, RENDER_SCALE, MAX_W, JPEG_Q, TIME_BUDGET_MS, OPEN_ERROR, RAW_TEXT_CAP,
    // pieces, for tests
    groupLines, imageBoxes, mergeBoxes, pickShots, buildProcedures,
  };
});
