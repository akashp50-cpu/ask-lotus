const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const imp = require("../src/importer");

const ctx = {
  catalog: [
    { id: "CO-04", title: "Late checkout request", category: "Departures and check-out" },
    { id: "KY-01", title: "Lost key or locked out", category: "Keys, access and guest privacy" },
  ],
  categories: ["Departures and check-out", "Keys, access and guest privacy", "Guest requests and amenities"],
  detailKeys: ["Check-out time", "Quiet hours"],
};

test("looseJSON reads fenced, chatty, trailing-comma and smart-quote output", () => {
  assert.deepStrictEqual(imp.looseJSON('Sure!\n```json\n{"a":[1,2,],}\n```\nDone.'), { a: [1, 2] });
  assert.deepStrictEqual(imp.looseJSON('Result: {"a": 1} thanks'), { a: 1 });
  assert.deepStrictEqual(imp.looseJSON("{“a”: 1}"), { a: 1 });
  assert.strictEqual(imp.looseJSON("no json here"), null);
  assert.strictEqual(imp.looseJSON("[1,2]"), null);
  assert.strictEqual(imp.looseJSON(""), null);
});

test("cleanAiResult drops invalid items, fixes ids/categories, caps and dedupes", () => {
  const r = imp.cleanAiResult(
    {
      matches: [
        { sop_id: "co-04", title: "Late", steps: ["1. Look", "- Offer", "  ", 7, { t: "Charge" }], difference: "x".repeat(900) },
        { sop_id: "CO-04", steps: ["only one"] }, // shorter duplicate: ignored
        { sop_id: "ZZ-01", steps: ["x"] }, // unknown id
        { sop_id: "KY-01", steps: [] }, // no steps
        "junk", null,
      ],
      new: [
        { title: "Store luggage", category: "guest requests", steps: "Take bags\nTag them", script: 5, flag: null },
        { title: "No category fits", category: "Cooking", steps: ["a"] },
        { title: "late checkout request", category: "x", steps: ["a", "b"] }, // already in the library -> becomes a match
        { title: "", steps: ["a"] },
        { title: "No steps", steps: [] },
        { title: "Store luggage", steps: ["a"] }, // duplicate title
      ],
      details: [
        { key: "check-out TIME", value: "11 am" },
        { key: "luggage room", value: "Behind the desk" },
        { key: "{Pool hours}", value: " 9 to 9 " },
        { key: "", value: "x" },
        { key: "Empty", value: "" },
        { key: "Check-out time", value: "noon" }, // duplicate key: first wins
      ],
    },
    ctx
  );
  assert.strictEqual(r.matches.length, 1);
  assert.strictEqual(r.matches[0].sop_id, "CO-04");
  assert.deepStrictEqual(r.matches[0].steps, ["Look", "Offer", "Charge"]); // numbering and bullets stripped, junk dropped
  assert.strictEqual(r.matches[0].difference.length, 300);
  // the "already in the library" new item (fewer steps) did not replace the match, and did not stay under "new"
  assert.deepStrictEqual(r.new.map((n) => n.title), ["Store luggage", "No category fits"]);
  assert.strictEqual(r.new[0].category, "Guest requests and amenities");
  assert.deepStrictEqual(r.new[0].steps, ["Take bags", "Tag them"]);
  assert.strictEqual(r.new[0].script, "5");
  assert.strictEqual(r.new[1].category, null);
  assert.deepStrictEqual(r.details.map((d) => [d.key, d.value]), [["Check-out time", "11 am"], ["Luggage Room", "Behind the desk"], ["Pool Hours", "9 to 9"]]);
});

test("cleanAiResult caps list sizes and step counts", () => {
  const big = {
    matches: Array.from({ length: 5 }, () => ({ sop_id: "CO-04", steps: ["a"] })),
    new: Array.from({ length: 300 }, (_, i) => ({ title: "T" + i, category: "Guest requests and amenities", steps: Array.from({ length: 80 }, (_, j) => "s" + j) })),
    details: Array.from({ length: 200 }, (_, i) => ({ key: "K" + i, value: "v" })),
  };
  const r = imp.cleanAiResult(big, ctx);
  assert.strictEqual(r.new.length, 100);
  assert.strictEqual(r.new[0].steps.length, 40);
  assert.strictEqual(r.details.length, 60);
  assert.strictEqual(r.matches.length, 1);
  assert.deepStrictEqual(imp.cleanAiResult(null, ctx), { matches: [], new: [], details: [] });
  assert.deepStrictEqual(imp.cleanAiResult({ matches: "x", new: 3, details: {} }, ctx), { matches: [], new: [], details: [] });
});

test("chunkText splits near the limit at paragraph breaks and loses nothing", () => {
  const para = "word ".repeat(200).trim();
  const text = Array.from({ length: 40 }, () => para).join("\n\n");
  const chunks = imp.chunkText(text, 15000);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.length <= 15000));
  assert.strictEqual(chunks.join(" ").replace(/\s+/g, " ").length, text.replace(/\s+/g, " ").length);
  assert.deepStrictEqual(imp.chunkText("short"), ["short"]);
});

test("analyzeText merges chunks, tolerates a failed chunk, and errors when all fail", async () => {
  const text = Array.from({ length: 30 }, (_, i) => `Section ${i}\n` + "lorem ipsum ".repeat(120)).join("\n\n");
  let n = 0;
  const calls = [];
  const ok = async (sys, user, opts) => {
    calls.push(opts);
    const i = n++;
    if (i === 1) throw new Error("500 from provider");
    return "```json\n" + JSON.stringify({ matches: [{ sop_id: "CO-04", steps: ["a", "b"].slice(0, i >= 2 ? 2 : 1) }], new: [{ title: "T" + i, category: "x", steps: ["s"] }], details: [] }) + "\n```";
  };
  const out = await imp.analyzeText(ok, text, ctx);
  assert.ok(out.parts >= 3);
  assert.strictEqual(out.failedParts, 1);
  assert.strictEqual(out.result.matches.length, 1);
  assert.strictEqual(out.result.matches[0].steps.length, 2); // the fuller one wins
  assert.ok(out.result.new.length >= 2);
  assert.ok(calls.every((o) => o.timeoutMs >= 60000 && o.maxTokens >= 4000));
  await assert.rejects(imp.analyzeText(async () => "total nonsense", "hello", ctx), /couldn't be read/);
  await assert.rejects(imp.analyzeText(async () => { throw new Error("401 from provider: no"); }, "hello", ctx), /rejected the saved key/);
});

test("parseCsv handles quotes, commas, newlines and semicolon files", () => {
  assert.deepStrictEqual(imp.parseCsv('a,b\n"x, y","say ""hi"""\n"two\nlines",z\r\n'), [["a", "b"], ["x, y", 'say "hi"'], ["two\nlines", "z"]]);
  assert.deepStrictEqual(imp.parseCsv("﻿a;b\n1;2"), [["a", "b"], ["1", "2"]]);
});

test("parseSheetRows: examples ignored, matching titles flagged, bad rows skipped", () => {
  const head = ["Title", "Category", "Applies to", "Only if the hotel has", "Step 1", "Step 2", "Step 10", "Say it like this", "Call a manager if"];
  const rows = [
    head,
    ["Example: demo", "Departures and check-out", "Every hotel", "", "x"],
    ["LATE checkout request ", "Departures and check-out", "Every hotel", "", "Look", "Offer"],
    ["Rollaway bed", "guest requests", "Hilton only", "Snack sales", "Check stock", "", "Deliver", "Happy to", "Guest angry"],
    ["Rollaway bed", "", "", "", "again"],
    ["No steps", "Departures and check-out"],
    ["", "", "", "", "orphan"],
    ["Odd one", "Cooking", "Every hotel", "", "A"],
  ];
  const r = imp.parseSheetRows(rows, ctx);
  assert.strictEqual(r.examples, 1);
  assert.deepStrictEqual(r.matches.map((m) => m.sop_id), ["CO-04"]);
  assert.deepStrictEqual(r.new.map((n) => n.title), ["Rollaway bed", "Odd one"]);
  assert.deepStrictEqual(r.new[0].steps, ["Check stock", "Deliver"]);
  assert.strictEqual(r.new[0].category, "Guest requests and amenities");
  assert.strictEqual(r.new[0].applies, "hilton");
  assert.strictEqual(r.new[0].requires, "market");
  assert.strictEqual(r.new[0].script, "Happy to");
  assert.strictEqual(r.new[1].category, null);
  assert.deepStrictEqual(r.skipped.map((s) => s.reason), ["Same title appears twice in this file", "No steps", "No title"]);
  assert.throws(() => imp.parseSheetRows([["Name", "Step 1"]], ctx), /Title column/);
  assert.throws(() => imp.parseSheetRows([["Title", "Category"]], ctx), /Step 1/);
});

test("template workbook has the columns, dropdowns, categories and example rows", async () => {
  const buf = await imp.buildTemplate(ctx.categories);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet("SOPs");
  const head = ws.getRow(1).values.slice(1);
  assert.deepStrictEqual(head.slice(0, 5), ["Title", "Category", "Applies to", "Only if the hotel has", "Step 1"]);
  assert.strictEqual(head[15], "Step 12");
  assert.deepStrictEqual(head.slice(16), ["Say it like this", "Call a manager if"]);
  assert.strictEqual(ws.getCell("B2").dataValidation.type, "list");
  assert.match(ws.getCell("B2").dataValidation.formulae[0], /Categories!/);
  assert.match(ws.getCell("C40").dataValidation.formulae[0], /Every hotel,Hilton only/);
  assert.match(ws.getCell("D40").dataValidation.formulae[0], /Breakfast,Pool,Pets,Laundry,Snack sales/);
  assert.deepStrictEqual(wb.getWorksheet("Categories").getColumn(1).values.slice(2), ctx.categories);
  assert.match(String(ws.getCell("A2").value), /^Example:/);
  // and our own parser reads the template back: only examples, so no rows
  const rows = await imp.sheetRowsFromFile("t.xlsx", buf);
  const r = imp.parseSheetRows(rows, ctx);
  assert.strictEqual(r.examples, 2);
  assert.strictEqual(r.new.length + r.matches.length, 0);
});

test("text extraction: txt, xlsx, docx; rejects wrong types and spoofed files", async () => {
  assert.match(await imp.fileText("a.txt", Buffer.from("Hello\r\n\r\n\r\n\r\nWorld")), /^Hello\n\nWorld$/);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Procs");
  ws.addRow(["Fire alarm", "Call 911"]);
  const x = await imp.fileText("p.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
  assert.match(x, /Sheet: Procs\nFire alarm \| Call 911/);
  const d = await imp.fileText("b.docx", fs.readFileSync(path.join(__dirname, "fixtures", "binder.docx")));
  assert.match(d, /Late checkout/);
  assert.match(d, /Offer checkout until 1 pm/);
  await assert.rejects(imp.fileText("a.exe", Buffer.from("MZ")), /isn't a type/);
  await assert.rejects(imp.fileText("a.pdf", Buffer.from("not a pdf")), /doesn't look like a PDF/);
  await assert.rejects(imp.fileText("a.docx", Buffer.from("not a zip")), /real \.docx/);
  await assert.rejects(imp.fileText("a.txt", Buffer.alloc(0)), /empty/);
  await assert.rejects(imp.fileText("a.txt", Buffer.alloc(11 * 1024 * 1024, 65)), /too large/);
});

test("extractAll caps total text and reports truncation", async () => {
  const big = Buffer.from("x".repeat(40000));
  const r = await imp.extractAll([{ name: "a.txt", buf: big }, { name: "b.txt", buf: big }, { name: "c.txt", buf: Buffer.from("   ") }]);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.text.length, imp.MAX_TEXT);
  assert.deepStrictEqual(r.empty, ["c.txt"]);
  const s = await imp.extractAll([{ name: "a.txt", buf: Buffer.from("short") }]);
  assert.strictEqual(s.truncated, false);
});
