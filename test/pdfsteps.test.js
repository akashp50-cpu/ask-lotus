const test = require("node:test");
const assert = require("node:assert");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { createCanvas } = require("@napi-rs/canvas");
const { extractSteps, isStepGuide, listing } = require("../src/pdfsteps");

// A synthetic guide. spec = pages: [ [ {h:"heading"} | {step:n|null, text, img:true|false} ] ]
// Layout like a quick-reference guide: a step number badge at the left, the text, then the screenshot under it.
async function makePdf(pages, { footer = true } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let k = 0;
  const png = () => {
    const c = createCanvas(400, 200), x = c.getContext("2d");
    x.fillStyle = `hsl(${(k++ * 67) % 360},60%,80%)`; x.fillRect(0, 0, 400, 200);
    x.strokeStyle = "red"; x.lineWidth = 6; x.strokeRect(100, 60, 150, 60);
    return c.toBuffer("image/png");
  };
  for (const [pi, items] of pages.entries()) {
    const page = doc.addPage([612, 792]);
    let y = 740;
    for (const it of items) {
      if (it.h) { page.drawText(it.h, { x: 50, y, size: 18, font: bold }); y -= 36; continue; }
      if (it.step != null) page.drawText(String(it.step), { x: 52, y, size: 11, font });
      page.drawText(it.text, { x: 80, y, size: 11, font });
      y -= 18;
      if (it.img) {
        const im = await doc.embedPng(png());
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

const flat = (r) => r.procedures.flatMap((p) => p.items);

test("pairs each step with the screenshot under it, and strips footers and page numbers", async () => {
  const pdf = await makePdf([[
    { h: "Steps to Print a Card" },
    { step: 1, text: "Open the reservation.", img: true },
    { step: 2, text: "Select Actions.", img: true },
  ], [
    { step: 3, text: "Select Print.", img: true },
  ]]);
  const r = await extractSteps(pdf);
  assert.strictEqual(r.procedures.length, 1);
  assert.strictEqual(r.procedures[0].title, "Steps to Print a Card");
  assert.deepStrictEqual(r.procedures[0].items.map((i) => [i.n, i.text, i.page, !!i.image]), [
    [1, "Open the reservation.", 1, true], [2, "Select Actions.", 1, true], [3, "Select Print.", 2, true],
  ]);
  const im = r.procedures[0].items[0].image;
  assert.strictEqual(im.mime, "image/jpeg");
  assert.strictEqual(im.buf[0], 0xff); assert.strictEqual(im.buf[1], 0xd8); // JPEG
  assert.ok(im.w > 500 && im.w <= 1600 && im.h > 250, `crop size ${im.w}x${im.h}`);
  assert.ok(!flat(r).some((i) => /Confidential|Proprietary/.test(i.text)));
  assert.strictEqual(r.shots, 3); assert.strictEqual(r.textOnly, false); assert.strictEqual(r.pages, 2);
  assert.ok(isStepGuide(r));
});

test("the crop includes the red highlight box (red pixels survive)", async () => {
  const { loadImage } = require("@napi-rs/canvas");
  const r = await extractSteps(await makePdf([[{ step: 1, text: "Click it.", img: true }]]));
  const img = await loadImage(r.procedures[0].items[0].image.buf);
  const c = createCanvas(img.width, img.height), x = c.getContext("2d");
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, img.width, img.height).data;
  let red = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90) red++;
  assert.ok(red > 200, `red pixels: ${red}`);
});

test("two procedures in one PDF: a new heading, and a restart at 1", async () => {
  const pdf = await makePdf([[
    { h: "Print one guest's card" },
    { step: 1, text: "Open the reservation.", img: true },
    { step: 2, text: "Select Print.", img: true },
    { h: "Print all arrivals' cards" },
    { step: 1, text: "Open Arrivals.", img: true },
    { step: 2, text: "Select Print All.", img: true },
  ]]);
  const r = await extractSteps(pdf);
  assert.deepStrictEqual(r.procedures.map((p) => p.title), ["Print one guest's card", "Print all arrivals' cards"]);
  assert.deepStrictEqual(r.procedures.map((p) => p.items.length), [2, 2]);

  // no headings at all: numbering that restarts at 1 still splits
  const r2 = await extractSteps(await makePdf([[
    { step: 1, text: "First thing.", img: true }, { step: 2, text: "Second thing.", img: true },
    { step: 1, text: "Another start.", img: true }, { step: 2, text: "Another end.", img: true },
  ]]), { fallbackTitle: "Guide" });
  assert.strictEqual(r2.procedures.length, 2);
  assert.strictEqual(r2.procedures[1].items[0].text, "Another start.");
});

test("a step without a screenshot keeps image null; two step texts above one screenshot give the picture to the last", async () => {
  const r = await extractSteps(await makePdf([[
    { h: "Steps to do it" },
    { step: 1, text: "Plain step with no picture.", img: false },
    { step: 2, text: "Step two text.", img: false },
    { step: 3, text: "Step three has the picture.", img: true },
    { step: 4, text: "Last step, no picture.", img: false },
  ]]));
  const it = flat(r);
  assert.deepStrictEqual(it.map((i) => [i.n, !!i.image]), [[1, false], [2, false], [3, true], [4, false]]);
  assert.strictEqual(it[0].image, null);
});

test("a screenshot split into several image objects is one crop", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("1", { x: 52, y: 700, size: 11, font }); page.drawText("Look at the screen.", { x: 80, y: 700, size: 11, font });
  for (let i = 0; i < 3; i++) {
    const c = createCanvas(300, 40), x = c.getContext("2d");
    x.fillStyle = ["#9cf", "#fc9", "#9fc"][i]; x.fillRect(0, 0, 300, 40);
    page.drawImage(await doc.embedPng(c.toBuffer("image/png")), { x: 80, y: 650 - i * 40, width: 300, height: 40 });
  }
  page.drawText("2", { x: 52, y: 480, size: 11, font }); page.drawText("Now the next step.", { x: 80, y: 480, size: 11, font });
  const r = await extractSteps(Buffer.from(await doc.save()));
  const it = flat(r);
  assert.strictEqual(r.shots, 1);
  assert.strictEqual(it[0].text, "Look at the screen.");
  assert.ok(it[0].image && it[0].image.h > 200); // three 40pt strips = 120pt, at 2x
  assert.strictEqual(it[1].image, null);
});

test("limits: at most N screenshots and N pages, each with a clear warning", async () => {
  const pages = [];
  for (let p = 0; p < 4; p++) pages.push([{ step: p + 1, text: `Step on page ${p + 1}.`, img: true }, { step: p + 11, text: `Second on page ${p + 1}.`, img: true }]);
  const pdf = await makePdf(pages);
  const a = await extractSteps(pdf, { maxShots: 5 });
  assert.strictEqual(a.shots, 5);
  assert.ok(a.warnings.some((w) => /8 screenshots.*first 5/.test(w)), a.warnings.join("|"));
  const b = await extractSteps(pdf, { maxPages: 2 });
  assert.strictEqual(b.shots, 4);
  assert.ok(b.warnings.some((w) => /4 pages.*first 2/.test(w)));
  assert.ok(flat(b).every((i) => i.page <= 2));
});

test("text-only PDFs report textOnly; picture-only PDFs and junk give a friendly error", async () => {
  const t = await extractSteps(await makePdf([[{ h: "Policy" }, { step: null, text: "This is a long policy paragraph with plenty of words in it to count as text.", img: false }]]));
  assert.strictEqual(t.textOnly, true); assert.strictEqual(t.shots, 0);
  const doc = await PDFDocument.create();
  const c = createCanvas(400, 400); c.getContext("2d").fillRect(0, 0, 400, 400);
  const pg = doc.addPage([612, 792]);
  pg.drawImage(await doc.embedPng(c.toBuffer("image/png")), { x: 0, y: 0, width: 612, height: 792 });
  await assert.rejects(extractSteps(Buffer.from(await doc.save())), /scan/i);
  await assert.rejects(extractSteps(Buffer.from("%PDF-1.4 not really")), /couldn't be opened/);
});

test("listing: procedures with numbered steps and [img:ID] tags", async () => {
  const r = await extractSteps(await makePdf([[{ h: "Steps to X" }, { step: 1, text: "Do A.", img: true }, { step: 2, text: "Do B.", img: false }]]));
  const out = listing(r, () => "ID1");
  assert.match(out, /PROCEDURE 1: Steps to X \(pages 1\)/);
  assert.match(out, /1\. Do A\. \[img:ID1\]/);
  assert.match(out, /2\. Do B\.$/m);
});

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
