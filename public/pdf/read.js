// Reads a PDF in the browser so the server never has to: pdf.js (served from this app, loaded only when a PDF is attached) finds the
// steps and screenshots (shared logic in layout.js), then draws ONE page at a time to a canvas, crops each screenshot to a JPEG blob
// and lets go of the canvas before the next page. Nothing here talks to the server.
//
//   readPdf(file, { version, fallbackTitle, steps, onProgress }) -> {
//     name, pages, warnings, isGuide, shots, procedures:[{ title, intro?, pages, items:[{ text, page, n?, blob|null, w?, h? }] }], text }
//   isGuide false (and steps not forced): procedures is [] and text holds the plain text, for the ordinary text import.
//   onProgress({ phase:"read"|"draw", page, of })

const L = () => globalThis.PdfLayout;
let libP = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("Couldn't load the PDF reader. Check your connection and try again."));
    document.head.appendChild(s);
  });
}

// Newer browsers get the standard pdf.js build; older phones the legacy one.
const modern = () => typeof Promise.withResolvers === "function" && !globalThis.__PDFJS_LEGACY;

function load(version, v) {
  return (libP ||= (async () => {
    const base = `/vendor/pdfjs/${version}/`, build = modern() ? base : base + "legacy/";
    const [pdfjs] = await Promise.all([import(build + "pdf.min.mjs"), loadScript(`/pdf/layout.js?v=${v || version}`)]);
    pdfjs.GlobalWorkerOptions.workerSrc = build + "pdf.worker.min.mjs";
    return { pdfjs, base };
  })().catch((e) => { libP = null; throw e; }));
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const toBlob = (canvas, q) => new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", q));

// Draws each page that has a placed screenshot, once, and cuts the screenshots out. Fills item.blob/w/h and clears item.shot.
async function drawShots(doc, procs, warnings, deadline, onProgress) {
  const byPage = new Map();
  for (const pr of procs) for (const it of pr.items) if (it.shot) (byPage.get(it.shot.page) || byPage.set(it.shot.page, []).get(it.shot.page)).push(it);
  const pageNums = [...byPage.keys()].sort((a, b) => a - b);
  let timedOut = 0, done = 0;
  for (const n of pageNums) {
    const items = byPage.get(n);
    if (onProgress) onProgress({ phase: "draw", page: ++done, of: pageNums.length });
    if (Date.now() > deadline) { timedOut += items.length; for (const it of items) it.shot = null; continue; }
    await tick();
    let pg = null, canvas = null;
    try {
      pg = await doc.getPage(n);
      const { W, H } = items[0].shot;
      const scale = L().pickScale(W, H);
      const vp = pg.getViewport({ scale });
      canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pg.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
      for (const it of items) {
        let out = null;
        try {
          const r = L().cropPixels(it.shot.crop, scale, canvas.width, canvas.height);
          out = document.createElement("canvas");
          out.width = r.ow; out.height = r.oh;
          const c = out.getContext("2d");
          c.fillStyle = "#fff"; c.fillRect(0, 0, r.ow, r.oh);
          c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
          c.drawImage(canvas, r.sx, r.sy, r.sw, r.sh, 0, 0, r.ow, r.oh);
          const blob = await toBlob(out, L().JPEG_Q);
          if (!blob) throw new Error("no blob");
          it.blob = blob; it.w = r.ow; it.h = r.oh;
        } catch { warnings.push(`A screenshot on page ${n} couldn't be cropped.`); }
        if (out) out.width = out.height = 0; // release the crop bitmap at once
        it.shot = null;
      }
    } catch {
      warnings.push(`Page ${n} couldn't be drawn, so its screenshots were left out.`);
      for (const it of items) it.shot = null;
    }
    if (canvas) canvas.width = canvas.height = 0; // release the page bitmap before drawing the next page
    if (pg) pg.cleanup();
  }
  if (timedOut) warnings.push(`This PDF took too long to draw, so ${timedOut} screenshot${timedOut === 1 ? " was" : "s were"} left out.`);
}

export async function readPdf(file, opts = {}) {
  const { pdfjs, base } = await load(opts.version, opts.v);
  const deadline = Date.now() + (opts.timeBudgetMs || L().TIME_BUDGET_MS);
  let doc;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    doc = await pdfjs.getDocument({
      data, isEvalSupported: false, disableFontFace: true, verbosity: 0,
      standardFontDataUrl: base + "standard_fonts/", cMapUrl: base + "cmaps/", cMapPacked: true, wasmUrl: base + "wasm/", iccUrl: base + "iccs/",
    }).promise;
  } catch (e) {
    throw new (L().StepsError)(L().OPEN_ERROR);
  }
  try {
    const res = await L().analyze(doc, pdfjs, { fallbackTitle: opts.fallbackTitle }, opts.onProgress);
    const out = { name: file.name, pages: res.pages, warnings: res.warnings, isGuide: false, shots: 0, procedures: [], text: "" };
    // A PDF without enough screenshots is read as plain text (the same text import every other document uses).
    const guide = L().isStepGuide(res);
    if (!guide && !opts.steps) {
      let text = res.rawText;
      if (text.length < L().RAW_TEXT_CAP && doc.numPages > L().MAX_PAGES) text += "\n\n" + await L().extraText(doc, pdfjs, L().MAX_PAGES + 1, L().MAX_TEXT_PAGES, L().RAW_TEXT_CAP - text.length);
      out.text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      out.warnings = [];
      return out;
    }
    await drawShots(doc, res.procedures, out.warnings, deadline, opts.onProgress);
    out.procedures = res.procedures;
    out.shots = L().countShots(res);
    out.isGuide = guide;
    return out;
  } finally {
    await doc.destroy().catch(() => {});
  }
}
