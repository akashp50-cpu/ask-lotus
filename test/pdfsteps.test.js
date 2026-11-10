// The shared layout logic (public/pdf/layout.js) driven in node by pdfjs-dist for PARSING only: nothing is drawn here.
// Drawing and cropping happen in the browser (public/pdf/read.js) and are covered by the Playwright run, not by npm test.
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const L = require("../public/pdf/layout.js");
const ps = require("../src/pdfsteps");

/* ---------- helpers ---------- */

// A small solid PNG (no canvas needed): colour fill with a red frame.
function png(w, h, rgb) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(t)); return Buffer.concat([len, t, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3, frame = (x > w / 4 && x < w / 2 && (Math.abs(y - h * 0.3) < 3 || Math.abs(y - h * 0.6) < 3));
    const c = frame ? [255, 0, 0] : rgb;
    raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// A synthetic guide. spec = pages: [ [ {h:"heading"} | {step:n|null, text, img:true|false} ] ]
// Layout like a quick-reference guide: a step number badge at the left, the text, then the screenshot under it.
async function makePdf(pages, { footer = true } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let k = 0;
  for (const [pi, items] of pages.entries()) {
    const page = doc.addPage([612, 792]);
    let y = 740;
    for (const it of items) {
      if (it.h) { page.drawText(it.h, { x: 50, y, size: 18, font: bold }); y -= 36; continue; }
      if (it.step != null) page.drawText(String(it.step), { x: 52, y, size: 11, font });
      page.drawText(it.text, { x: 80, y, size: 11, font });
      y -= 18;
      if (it.img) {
        const im = await doc.embedPng(png(400, 200, [150 + (k++ * 20) % 90, 200, 230]));
        page.drawImage(im, { x: 80, y: y - 150, width: 300, height: 150 });
        y -= 170;
      } else y -= 10;
    }
    if (footer) {
      page.drawText("Acme Confidential and Proprietary", { x: 50, y: 30, size: 9, font });
      page.drawText(String(pi + 1), { x: 560, y: 30, size: 9, font });
    }
  }
  return Buffer.from(await doc.save());
}

let pdfjsP = null;
const pdfjs = () => (pdfjsP ||= import("pdfjs-dist/legacy/build/pdf.mjs"));
// What the browser does, minus drawing: open, analyze.
async function analyze(buf, opts) {
  const lib = await pdfjs();
  let doc;
  try { doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise; }
  catch { throw new L.StepsError(L.OPEN_ERROR); }
  try { return await L.analyze(doc, lib, opts); } finally { await doc.destroy().catch(() => {}); }
}
const flat = (r) => r.procedures.flatMap((p) => p.items);

/* ---------- layout ---------- */

test("pairs each step with the screenshot under it, and strips footers and page numbers", async () => {
  const r = await analyze(await makePdf([[
    { h: "Steps to Print a Card" },
    { step: 1, text: "Open the reservation.", img: true },
    { step: 2, text: "Select Actions.", img: true },
  ], [
    { step: 3, text: "Select Print.", img: true },
  ]]));
  assert.strictEqual(r.procedures.length, 1);
  assert.strictEqual(r.procedures[0].title, "Steps to Print a Card");
  assert.deepStrictEqual(r.procedures[0].items.map((i) => [i.n, i.text, i.page, !!i.shot]), [
    [1, "Open the reservation.", 1, true], [2, "Select Actions.", 1, true], [3, "Select Print.", 2, true],
  ]);
  assert.ok(!flat(r).some((i) => /Confidential|Proprietary/.test(i.text)));
  assert.strictEqual(r.shots, 3); assert.strictEqual(r.textOnly, false); assert.strictEqual(r.pages, 2);
  assert.ok(L.isStepGuide(r));
});

test("the crop rectangle covers the picture with a little padding, and stays on the page", async () => {
  const r = await analyze(await makePdf([[{ step: 1, text: "Click it.", img: true }]]));
  const s = flat(r)[0].shot;
  assert.deepStrictEqual([s.page, s.W, s.H], [1, 612, 792]);
  const c = s.crop;
  // the picture is 300 x 150 pt at x=80; the padding is 5 pt each side
  assert.ok(Math.abs(c.x0 - 75) < 1 && Math.abs(c.x1 - 385) < 1, JSON.stringify(c));
  assert.ok(Math.abs(c.y1 - c.y0 - 160) < 2, JSON.stringify(c));
  assert.ok(c.x0 >= 0 && c.y0 >= 0 && c.x1 <= 612 && c.y1 <= 792);
  // the top never reaches into the step text just above the picture
  const px = L.cropPixels(c, 2, 1224, 1584);
  assert.ok(px.sw > 600 && px.ow === px.sw && px.oh === px.sh);
});

test("cropPixels: width capped at 1600, never past the canvas; pickScale lowers the scale for huge pages", () => {
  const crop = { x0: 0, y0: 0, x1: 1200, y1: 600 };
  const px = L.cropPixels(crop, 2, 2400, 1200);
  assert.strictEqual(px.sw, 2400); assert.strictEqual(px.ow, 1600); assert.strictEqual(px.oh, 800);
  const edge = L.cropPixels({ x0: 600, y0: 700, x1: 700, y1: 800 }, 2, 1224, 1584);
  assert.ok(edge.sx + edge.sw <= 1224 && edge.sy + edge.sh <= 1584);
  assert.strictEqual(L.pickScale(612, 792), 2);
  const big = L.pickScale(3000, 4000);
  assert.ok(big < 1 && big >= 0.5 && 3000 * 4000 * big * big <= 6.01e6, String(big));
});

test("two procedures in one PDF: a new heading, and a restart at 1", async () => {
  const r = await analyze(await makePdf([[
    { h: "Print one guest's card" },
    { step: 1, text: "Open the reservation.", img: true },
    { step: 2, text: "Select Print.", img: true },
    { h: "Print all arrivals' cards" },
    { step: 1, text: "Open Arrivals.", img: true },
    { step: 2, text: "Select Print All.", img: true },
  ]]));
  assert.deepStrictEqual(r.procedures.map((p) => p.title), ["Print one guest's card", "Print all arrivals' cards"]);
  assert.deepStrictEqual(r.procedures.map((p) => p.items.length), [2, 2]);

  // no headings at all: numbering that restarts at 1 still splits
  const r2 = await analyze(await makePdf([[
    { step: 1, text: "First thing.", img: true }, { step: 2, text: "Second thing.", img: true },
    { step: 1, text: "Another start.", img: true }, { step: 2, text: "Another end.", img: true },
  ]]), { fallbackTitle: "Guide" });
  assert.strictEqual(r2.procedures.length, 2);
  assert.strictEqual(r2.procedures[1].items[0].text, "Another start.");
});

test("a step without a screenshot keeps shot null; two step texts above one screenshot give the picture to the last", async () => {
  const r = await analyze(await makePdf([[
    { h: "Steps to do it" },
    { step: 1, text: "Plain step with no picture.", img: false },
    { step: 2, text: "Step two text.", img: false },
    { step: 3, text: "Step three has the picture.", img: true },
    { step: 4, text: "Last step, no picture.", img: false },
  ]]));
  const it = flat(r);
  assert.deepStrictEqual(it.map((i) => [i.n, !!i.shot]), [[1, false], [2, false], [3, true], [4, false]]);
  assert.strictEqual(it[0].shot, null);
});

test("a screenshot split into several image objects is one crop", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("1", { x: 52, y: 700, size: 11, font }); page.drawText("Look at the screen.", { x: 80, y: 700, size: 11, font });
  for (let i = 0; i < 3; i++) page.drawImage(await doc.embedPng(png(300, 40, [[150, 200, 255], [255, 200, 150], [150, 255, 200]][i])), { x: 80, y: 650 - i * 40, width: 300, height: 40 });
  page.drawText("2", { x: 52, y: 480, size: 11, font }); page.drawText("Now the next step.", { x: 80, y: 480, size: 11, font });
  const r = await analyze(Buffer.from(await doc.save()));
  const it = flat(r);
  assert.strictEqual(r.shots, 1);
  assert.strictEqual(it[0].text, "Look at the screen.");
  assert.ok(it[0].shot && it[0].shot.crop.y1 - it[0].shot.crop.y0 > 120); // three 40pt strips
  assert.strictEqual(it[1].shot, null);
});

test("limits: at most N screenshots and N pages, each with a clear warning", async () => {
  const pages = [];
  for (let p = 0; p < 4; p++) pages.push([{ step: p + 1, text: `Step on page ${p + 1}.`, img: true }, { step: p + 11, text: `Second on page ${p + 1}.`, img: true }]);
  const pdf = await makePdf(pages);
  const a = await analyze(pdf, { maxShots: 5 });
  assert.strictEqual(a.shots, 5);
  assert.ok(a.warnings.some((w) => /8 screenshots.*first 5/.test(w)), a.warnings.join("|"));
  const b = await analyze(pdf, { maxPages: 2 });
  assert.strictEqual(b.shots, 4);
  assert.ok(b.warnings.some((w) => /4 pages.*first 2/.test(w)));
  assert.ok(flat(b).every((i) => i.page <= 2));
});

test("text-only PDFs report textOnly and hand back raw text; picture-only PDFs and junk give a friendly error", async () => {
  const t = await analyze(await makePdf([[{ h: "Policy" }, { step: null, text: "This is a long policy paragraph with plenty of words in it to count as text.", img: false }]]));
  assert.strictEqual(t.textOnly, true); assert.strictEqual(t.shots, 0);
  assert.match(t.rawText, /long policy paragraph/);
  assert.ok(!L.isStepGuide(t));
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawImage(await doc.embedPng(png(400, 400, [20, 20, 20])), { x: 0, y: 0, width: 612, height: 792 });
  await assert.rejects(analyze(Buffer.from(await doc.save())), /scan/i);
  await assert.rejects(analyze(Buffer.from("%PDF-1.4 not really")), /couldn't be opened/);
});

test("isStepGuide: needs 2+ screenshots and about one per four pages", () => {
  assert.ok(L.isStepGuide({ shots: 2, pages: 8 }));
  assert.ok(!L.isStepGuide({ shots: 1, pages: 1 }));
  assert.ok(!L.isStepGuide({ shots: 3, pages: 40 }));
  assert.ok(L.isStepGuide({ shots: 15, pages: 200 })); // pages count up to the read limit only
});

test("listing: procedures with numbered steps and [img:ID] tags", async () => {
  const r = await analyze(await makePdf([[{ h: "Steps to X" }, { step: 1, text: "Do A.", img: true }, { step: 2, text: "Do B.", img: false }]]));
  const out = L.listing(r, (it) => it.shot && "ID1");
  assert.match(out, /PROCEDURE 1: Steps to X \(pages 1\)/);
  assert.match(out, /1\. Do A\. \[img:ID1\]/);
  assert.match(out, /2\. Do B\.$/m);
});

/* ---------- what the server accepts ---------- */

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sub = (procs, extra) => ({ name: "g.pdf", pages: 3, warnings: [], procedures: procs, ...extra });

test("cleanSubmission: text cleaned, shapes enforced, bad ids and duplicate pictures dropped", () => {
  const out = ps.cleanSubmission(sub([
    { title: "  Print\u0000 a   card:  ", intro: "x".repeat(2000), items: [
      { text: "  Open\tthe\n reservation​.  ", page: 1, n: 1, img: U(1) },
      { text: "Same picture again", page: 1, img: U(1) },
      { text: "Bad id", page: "2", img: "not-a-uuid; DROP TABLE images" },
      { text: "", page: 1, img: U(2) },
      { text: "", page: 1, img: null },
      { text: "Weird n", page: 9999, n: "7", img: null },
      null, "str", { text: 5 },
    ] },
    { title: "", items: [] },
    "junk",
  ]));
  assert.strictEqual(out.procedures.length, 1);
  const p = out.procedures[0];
  assert.strictEqual(p.title, "Print a card:");
  assert.strictEqual(p.intro.length, 1500);
  assert.deepStrictEqual(p.items.map((i) => [i.text, i.page, i.n, i.img]), [
    ["Open the reservation .", 1, 1, U(1)], ["Same picture again", 1, undefined, null], ["Bad id", 2, undefined, null], ["", 1, undefined, U(2)], ["5", 1, undefined, null],
  ]);
  assert.deepStrictEqual(p.pages, [1, 2]);
  assert.deepStrictEqual(out.imgIds, [U(1), U(2)]);
});

test("cleanSubmission: same limits as the reader (pages, screenshots) and strict counts", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ text: `Step ${i}`, page: 1, img: U(i + 1) }));
  const out = ps.cleanSubmission(sub([{ title: "T", items }]));
  assert.strictEqual(out.imgIds.length, ps.MAX_SHOTS);
  assert.strictEqual(out.procedures[0].items.length, 100);
  assert.ok(out.warnings.some((w) => new RegExp(`more than ${ps.MAX_SHOTS} screenshots`).test(w)));
  // pages beyond what the reader reads are dropped
  const late = ps.cleanSubmission(sub([{ title: "T", items: [{ text: "ok", page: 3 }, { text: "late", page: ps.MAX_PAGES + 1 }] }], { pages: 200 }));
  assert.deepStrictEqual(late.procedures[0].items.map((i) => i.text), ["ok"]);
  assert.ok(late.warnings.some((w) => /first 60 pages/.test(w)));
  // counts: procedures, items per procedure, total items
  const many = ps.cleanSubmission(sub(Array.from({ length: 100 }, (_, i) => ({ title: `P${i}`, items: [{ text: "a" }] }))));
  assert.strictEqual(many.procedures.length, ps.MAX_PROCS);
  const big = ps.cleanSubmission(sub(Array.from({ length: 5 }, (_, i) => ({ title: `P${i}`, items: Array.from({ length: 300 }, (_, j) => ({ text: `s${j}` })) }))));
  assert.strictEqual(big.procedures.reduce((n, p) => n + p.items.length, 0), ps.MAX_ITEMS);
  // lengths
  const long = ps.cleanSubmission(sub([{ title: "t".repeat(500), items: [{ text: "w ".repeat(2000) }] }], { name: "n".repeat(500) + "/x.pdf", warnings: Array(30).fill("w".repeat(900)) }));
  assert.strictEqual(long.procedures[0].title.length, 160); assert.ok(long.procedures[0].items[0].text.length <= 1000);
  assert.strictEqual(long.name.length, 120); assert.ok(long.warnings.length <= 12 && long.warnings.every((w) => w.length <= 300));
});

test("cleanSubmission: nothing to read is an error; text alone is fine; page count is clamped", () => {
  assert.throws(() => ps.cleanSubmission({}), /couldn't find/);
  assert.throws(() => ps.cleanSubmission(sub([{ title: "T", items: [{ text: "" }] }])), /couldn't find/);
  const t = ps.cleanSubmission({ name: "p.pdf", pages: -5, text: "Policy text\u0000 here" });
  assert.strictEqual(t.procedures.length, 0); assert.strictEqual(t.text, "Policy text here"); assert.strictEqual(t.pages, 1);
  assert.strictEqual(ps.cleanSubmission(sub([{ title: "T", items: [{ text: "a" }] }], { pages: 1e9 })).pages, 10000);
});

test("applyOwned: pictures that are not the user's own recent uploads are dropped, steps keep their text", () => {
  const s = ps.cleanSubmission(sub([{ title: "T", items: [{ text: "a", img: U(1) }, { text: "b", img: U(2) }, { text: "", img: U(3) }, { text: "d", img: null }] }]));
  const out = ps.applyOwned(s, new Set([U(1)]));
  assert.deepStrictEqual(out.procedures[0].items.map((i) => [i.text, i.img]), [["a", U(1)], ["b", null], ["d", null]]);
  assert.strictEqual(out.shots, 1); assert.deepStrictEqual(out.imgIds, [U(1)]);
  assert.ok(!ps.isStepGuide({ shots: out.shots, pages: out.pages }));
  assert.match(ps.listing(out), /1\. a \[img:00000000-0000-4000-8000-000000000001\]/);
  assert.doesNotMatch(ps.listing(out), /2\. b \[img/);
});

/* ---------- the AI step and its picture ids ---------- */

test("importer keeps picture ids per step, drops unknown or repeated ones", () => {
  const imp = require("../src/importer");
  const ctx = { catalog: [{ id: "CO-01", title: "Standard check-out", category: "C" }], categories: ["C"], detailKeys: [] };
  const raw = {
    matches: [{ sop_id: "CO-01", steps: [{ t: "Open it [CHECK: x]", img: "img:aaa" }, { t: "Next", img: "aaa" }, { t: "Last", img: "zzz" }] }],
    new: [{ title: "New one", category: "C", steps: [{ t: "A", img: "bbb" }, "B"] }],
  };
  const r = imp.keepValidImgs(imp.cleanAiResult(raw, ctx), new Set(["aaa", "bbb"]));
  assert.deepStrictEqual(r.matches[0].steps, ["Open it", "Next", "Last"]);
  assert.deepStrictEqual(r.matches[0].imgs, ["aaa", null, null]);
  assert.deepStrictEqual(r.new[0].imgs, ["bbb", null]);
  // a plain text result has no imgs at all
  assert.strictEqual(imp.cleanAiResult({ new: [{ title: "T", category: "C", steps: ["a"] }] }, ctx).new[0].imgs, undefined);
});

test("text already read by the browser goes through the same clean-up and cap as other documents", async () => {
  const imp = require("../src/importer");
  const r = await imp.extractAll([{ name: "a.pdf", text: "Hello\r\n\r\n\r\n\r\nWorld  \t x" }, { name: "b.pdf", text: "   " }]);
  assert.strictEqual(r.text, "=== File: a.pdf ===\nHello\n\nWorld x");
  assert.deepStrictEqual(r.empty, ["b.pdf"]);
  const big = await imp.extractAll([{ name: "c.pdf", text: "x".repeat(imp.MAX_TEXT + 500) }]);
  assert.ok(big.truncated && big.text.length === imp.MAX_TEXT);
});

test("author coercion: multi-choice asks and update_sop_id only with a PDF, and only for ids in the catalog", () => {
  const ai = require("../src/ai");
  const base = { categories: ["C"], validImages: [], catalogIds: ["CO-01"] };
  const ask = { action: "ask", question: "Q?", options: ["A", "B"], multi: true };
  assert.strictEqual(ai.coerceAuthor(ask, { ...base, pdf: true }).multi, true);
  assert.strictEqual(ai.coerceAuthor(ask, base).multi, undefined);
  const d = { action: "draft", sop: { title: "T", category: "C", steps: ["a"] }, update_sop_id: "co-01" };
  assert.strictEqual(ai.coerceAuthor(d, { ...base, pdf: true }).updateId, "CO-01");
  assert.strictEqual(ai.coerceAuthor({ ...d, update_sop_id: "XX-9" }, { ...base, pdf: true }).updateId, null);
  assert.ok(ai.authorSystem({ categories: ["C"], detailKeys: [], roles: [], pdf: true }).includes("PDF SPLIT OR UPDATE"));
  assert.ok(!ai.authorSystem({ categories: ["C"], detailKeys: [], roles: [] }).includes("PDF SPLIT"));
});

test("the server never loads a PDF library or a canvas for PDF guides", () => {
  const src = require("fs").readFileSync(require.resolve("../src/pdfsteps.js"), "utf8");
  assert.doesNotMatch(src, /require\(["'](?:pdfjs|@napi)/);
  assert.doesNotMatch(src, /import\(["']pdfjs/);
});
