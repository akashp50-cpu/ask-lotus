// Finds a hotel's rooms in the text of a PMS report (the browser reads the PDF, Excel or CSV; nothing here touches the server).
//
//   parse(lines) -> { types: [{ code, count, rooms: [...] }], total, rooms: [{ number, type }], warnings: [], found: "rows"|"counts"|"both"|"" }
//
// `lines` is the report as visual lines (a string each, or an array of cells). Two shapes are recognised and may both be present:
//   - "room number + room type" rows (HotelKey "Room Count Summary": "100  SK1")
//   - a "room type + count" table that follows a "Room Type  Count" header ("QQ  70")
// Report headers and the column headers a PMS repeats at every page break are ignored. Works in the browser (script tag) and in Node (tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RoomReport = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const cellsOf = (line) => (Array.isArray(line) ? line.map((x) => String(x ?? "").trim()).filter(Boolean) : String(line ?? "").trim().split(/\s+/).filter(Boolean));
  const textOf = (cells) => cells.join(" ");
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

  // Column headings, page titles and report stamps: never data.
  const HEADER = /^(room (number|no|nbr|#|num)|rooms?|room type|type|count|total|room count summary|room type count|report run (date|time)|user|page)\b/i;
  const ROOM_HEADER = /^(room (number|no\.?|nbr|#|num)\b.*\b(type|class|code)|room\b.*\broom type)\b/i;
  const COUNT_HEADER = /^(room )?type\b.*\b(count|rooms|total|qty|quantity|number)\b/i;

  const isRoomNo = (t) => /^\d{1,4}[A-Za-z]?$/.test(t);
  const isTypeCode = (t) => /^[A-Za-z0-9][A-Za-z0-9\-/.]{0,11}$/.test(t) && /[A-Za-z]/.test(t);
  const isCount = (t) => /^\d{1,4}$/.test(t);

  function parse(lines) {
    const rooms = [], counts = [], warnings = [];
    let mode = "rows"; // flips to "counts" once a "Room Type / Count" heading is seen
    let seenRows = 0;
    for (const line of lines || []) {
      const cells = cellsOf(line);
      if (!cells.length) continue;
      const text = textOf(cells);
      if (COUNT_HEADER.test(text) && !ROOM_HEADER.test(text)) { mode = "counts"; continue; }
      if (ROOM_HEADER.test(text)) { if (mode === "counts" && seenRows) mode = "counts"; continue; }
      if (/^room type count$/i.test(text)) { mode = "counts"; continue; }
      if (HEADER.test(text) && !(cells.length >= 2 && isRoomNo(cells[0]) && isTypeCode(cells[1]))) continue;
      if (mode === "counts") {
        // "QQ 70" (type then count). A trailing total row ("Total 123") is not a type.
        if (cells.length >= 2 && isTypeCode(cells[0]) && isCount(cells[1]) && !/^total$/i.test(cells[0])) counts.push({ code: cells[0], count: +cells[1] });
        continue;
      }
      if (cells.length >= 2 && cells.length <= 6 && isRoomNo(cells[0]) && isTypeCode(cells[1])) { rooms.push({ number: cells[0], type: cells[1] }); seenRows++; continue; }
      // A count table with no "Count" heading: "QQ 70" lines after the room rows.
      if (seenRows && cells.length === 2 && isTypeCode(cells[0]) && isCount(cells[1]) && !/^total$/i.test(cells[0])) counts.push({ code: cells[0], count: +cells[1] });
    }
    // De-duplicate room numbers (a row repeated at a page break must not count twice).
    const seen = new Map(), uniq = [];
    for (const r of rooms) {
      const prev = seen.get(r.number);
      if (prev === undefined) { seen.set(r.number, r.type); uniq.push(r); }
      else if (prev !== r.type) warnings.push(`Room ${r.number} is listed as both ${prev} and ${r.type}. Kept ${prev}.`);
    }
    const order = [], by = new Map();
    const add = (code) => { const k = code.toLowerCase(); if (!by.has(k)) { by.set(k, { code, count: 0, rooms: [] }); order.push(k); } return by.get(k); };
    for (const c of counts) { const t = add(c.code); t.count = (t.count || 0) + c.count; t.declared = true; }
    for (const r of uniq) add(r.type).rooms.push(r.number);
    const types = order.map((k) => {
      const t = by.get(k);
      if (t.rooms.length && t.declared && t.rooms.length !== t.count) warnings.push(`${t.code}: the room rows show ${t.rooms.length} but the count table says ${t.count}. Used ${t.count}.`);
      const count = t.declared ? t.count : t.rooms.length;
      delete t.declared;
      return { code: t.code, count, rooms: t.rooms.sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0)) };
    });
    const total = types.reduce((n, t) => n + t.count, 0);
    if (uniq.length && counts.length && uniq.length !== counts.reduce((n, c) => n + c.count, 0)) warnings.push(`The room rows (${uniq.length}) and the count table (${counts.reduce((n, c) => n + c.count, 0)}) don't add up to the same number.`);
    return { types, total, rooms: uniq, warnings, found: uniq.length && counts.length ? "both" : uniq.length ? "rows" : counts.length ? "counts" : "" };
  }

  // Spreadsheet rows (arrays of cells) from a CSV or Excel file. A CSV with a header row and extra columns works too.
  function parseRows(rows) {
    const lines = [];
    let numCol = -1, typeCol = -1;
    for (const r of rows || []) {
      const cells = (Array.isArray(r) ? r : [r]).map((x) => String(x ?? "").trim());
      if (numCol < 0) {
        const n = cells.findIndex((c) => /^room\s*(number|no\.?|nbr|#|num)?$/i.test(c) || /^room number$/i.test(c));
        const t = cells.findIndex((c) => /^(room\s*)?(type|class|code)$/i.test(c) || /^room type$/i.test(c));
        if (n >= 0 && t >= 0 && n !== t) { numCol = n; typeCol = t; continue; }
      }
      if (numCol >= 0 && typeCol >= 0 && cells[numCol] && cells[typeCol]) { lines.push([cells[numCol], cells[typeCol]]); continue; }
      lines.push(cells.filter(Boolean));
    }
    return parse(lines);
  }

  // pdf.js text items [{ str, x, y }] of one page -> visual lines (items on the same baseline, left to right).
  function pageLines(items, tol) {
    const t = tol || 3;
    const rows = [];
    for (const it of items) {
      if (!String(it.str || "").trim()) continue;
      const row = rows.find((r) => Math.abs(r.y - it.y) <= t);
      if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
    }
    rows.sort((a, b) => b.y - a.y); // PDF y grows upward
    return rows.map((r) => r.items.sort((a, b) => a.x - b.x).map((i) => String(i.str).trim()).filter(Boolean));
  }

  // Minimal CSV reader: quotes, doubled quotes; comma, semicolon or tab separated.
  function parseCsv(text) {
    const t = String(text || "").replace(/^\uFEFF/, "");
    const first = t.split(/\r?\n/, 1)[0] || "";
    const sep = (first.match(/\t/g) || []).length ? "\t" : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : ",";
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === sep) { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((x) => String(x).trim()));
  }

  return { parse, parseRows, parseCsv, pageLines, isRoomNo, isTypeCode };
});
