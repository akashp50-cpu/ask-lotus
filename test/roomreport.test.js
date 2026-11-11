// The room report reader (public/pdf/rooms.js): finds "room number + room type" rows and a "room type + count" table in the text of a PMS report.
// The fixture is built here, shaped like HotelKey's "Room Count Summary" (a title block, repeated column headings at each page break, then the count table).
const test = require("node:test");
const assert = require("node:assert");
const RR = require("../public/pdf/rooms.js");

// 123 rooms, nine types, like the report the app was designed against.
const COUNTS = [["SK1", 1], ["SQQ1", 4], ["SHQQ1", 1], ["HRK", 1], ["1Q", 4], ["HQ", 3], ["QQ", 70], ["KG", 35], ["SQ1", 4]];
function buildRooms() {
  const rooms = [];
  let n = 100;
  for (const [type, count] of COUNTS) for (let i = 0; i < count; i++) { rooms.push([String(100 + Math.floor(n / 40) * 100 + (n % 40) + 1 + Math.floor(rooms.length / 80)), type]); n++; }
  // unique, ascending room numbers: floor 1 = 101..., floor 2 = 201..., ...
  const seen = new Set();
  return rooms.map(([, t], i) => { let num = 100 * (1 + Math.floor(i / 41)) + (i % 41) + 1; while (seen.has(num)) num++; seen.add(num); return [String(num), t]; });
}
function report(rooms, perPage = 45) {
  const lines = [
    "HOTEL LOTUS - KANSAS CITY", "0689", "Report Run Date: Nov 11 2026", "Report Run Time: 02:26:24 PM", "User: Test User", "", "Room Count Summary", "", "Room Count Summary",
    "Room Number Room Type",
  ];
  rooms.forEach(([num, type], i) => {
    if (i && i % perPage === 0) lines.push("", "Room Number Room Type", ""); // the column heading repeats at every page break
    lines.push(`${num}   ${type}`);
  });
  lines.push("", "Room Type Count", "Room Type Count");
  for (const [t, c] of COUNTS) lines.push(`${t}   ${c}`);
  return lines;
}

test("reads a HotelKey-style room count summary: 9 types, 123 rooms, page-break headings ignored", () => {
  const rooms = buildRooms();
  assert.strictEqual(rooms.length, 123);
  const r = RR.parse(report(rooms));
  assert.strictEqual(r.found, "both");
  assert.strictEqual(r.total, 123);
  assert.strictEqual(r.types.length, 9);
  assert.deepStrictEqual(r.types.map((t) => [t.code, t.count, t.rooms.length]), COUNTS.map(([c, n]) => [c, n, n]));
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(r.rooms.length, 123, "header lines and the report stamp were not read as rooms");
  assert.ok(!r.rooms.some((x) => /^(room|report|user|hotel)/i.test(x.type)));
});

test("a type code that looks like a number (1Q) is a type, not a room number, and 4-digit rooms work", () => {
  const r = RR.parse(["Room Number Room Type", "1201 1Q", "1202 1Q", "1203 KG", "Room Type Count", "1Q 2", "KG 1"]);
  assert.deepStrictEqual(r.types.map((t) => [t.code, t.count, t.rooms.join()]), [["1Q", 2, "1201,1202"], ["KG", 1, "1203"]]);
  assert.strictEqual(r.total, 3);
});

test("only room rows (no count table): counts come from the rows; a repeated row is not counted twice", () => {
  const r = RR.parse(["Room Number Room Type", "101 KG", "102 KG", "103 QQ", "Room Number Room Type", "102 KG", "104 QQ"]);
  assert.strictEqual(r.found, "rows");
  assert.deepStrictEqual(r.types.map((t) => [t.code, t.count]), [["KG", 2], ["QQ", 2]]);
});

test("only a count table: types and counts with no room numbers", () => {
  const r = RR.parse(["Room Count Summary", "Room Type   Count", "KG  35", "QQ  70", "Total 105"]);
  assert.strictEqual(r.found, "counts");
  assert.deepStrictEqual(r.types.map((t) => [t.code, t.count, t.rooms.length]), [["KG", 35, 0], ["QQ", 70, 0]]);
  assert.strictEqual(r.total, 105);
});

test("rows and count table that disagree warn, and the count table wins", () => {
  const r = RR.parse(["101 KG", "102 KG", "Room Type Count", "KG 3"]);
  assert.strictEqual(r.types[0].count, 3);
  assert.ok(r.warnings.some((w) => /KG/.test(w)));
});

test("a room listed under two types keeps the first and warns", () => {
  const r = RR.parse(["101 KG", "101 QQ", "102 QQ"]);
  assert.deepStrictEqual(r.rooms.map((x) => x.type), ["KG", "QQ"]);
  assert.ok(r.warnings.some((w) => /101/.test(w)));
});

test("junk gives nothing", () => {
  const r = RR.parse(["Welcome to the hotel", "11 2026", "Page 1 of 3", ""]);
  assert.strictEqual(r.found, "");
  assert.deepStrictEqual(r.types, []);
});

test("pdf.js text items on one baseline become one line, top to bottom", () => {
  const items = [{ str: "SK1", x: 300, y: 700 }, { str: "100", x: 100, y: 700.4 }, { str: "QQ", x: 300, y: 680 }, { str: "104", x: 100, y: 680 }, { str: " ", x: 5, y: 1 }];
  assert.deepStrictEqual(RR.pageLines(items), [["100", "SK1"], ["104", "QQ"]]);
});

test("CSV and Excel rows: a header with extra columns, semicolons, and quoted cells", () => {
  const csv = 'Room;Type;Floor;Status\n"101";"KG";1;Clean\n102;KG;1;Dirty\n201;QQ;2;Clean\n';
  const rows = RR.parseCsv(csv);
  assert.deepStrictEqual(rows[1], ["101", "KG", "1", "Clean"]);
  const r = RR.parseRows(rows);
  assert.deepStrictEqual(r.types.map((t) => [t.code, t.count]), [["KG", 2], ["QQ", 1]]);
  const counts = RR.parseRows([["Room Type", "Count"], ["KG", "35"], ["QQ", "70"]]);
  assert.strictEqual(counts.total, 105);
  const numeric = RR.parseRows([["Room Number", "Room Type"], [101, "KG"], [102, "KG"]]);
  assert.strictEqual(numeric.total, 2);
});
