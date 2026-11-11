// The merged setup fields: aliases and derived tokens, the wording generated from yes/no answers, room inventory, and the migration.
// Key safety property: rendering every SOP before and after the migration gives the same text for everything a hotel already had.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const D = require("../src/details");
const R = require("../src/rooms");
const { tokKey, forModel, tokenFiller, UNSET } = require("../src/tokens");

// Hampton Inn Overland Park's real details (live today).
const HOP = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "hop-details.json"), "utf8"));
const HOP_ANSWERS = { cash: false, pets: true, pool: true, market: true, laundry: true, breakfast: true, rollaways: false, pack_and_plays: false, connecting_rooms: false };
const SOPS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "db", "seed-data", "hampton-sops.json"), "utf8")).sops.map((s) => ({ id: s.id, title: s.title, steps: s.steps, script: s.script, flag: s.flag }));
const CONTACTS = [{ role: "GM", name: "Akash Patel", phone: "(256) 617-1071" }, { role: "AGM", name: "Huraima Khan", phone: "(913) 555-0101" }, { role: "Engineer", name: "Jerry Thate", phone: "(816) 878-1454" }, { role: "Head Housekeeper", name: "Cindy Thate", phone: "(913) 326-2217" }, { role: "COO", name: "Dhruv Patel", phone: "(903) 522-9972" }];

const get = (d, k) => D.rawGet(d, k);

test("aliases: Hotel short name and Hotel welcome name follow Hotel name unless set", () => {
  const r = D.resolve({ "Hotel name": "the Hampton Inn" }, {});
  assert.strictEqual(get(r, "Hotel short name"), "the Hampton Inn");
  assert.strictEqual(get(r, "Hotel welcome name"), "the Hampton Inn");
  const own = D.resolve({ "Hotel name": "the Hampton Inn Overland Park", "Hotel short name": "the Hampton Inn" }, {});
  assert.strictEqual(get(own, "Hotel short name"), "the Hampton Inn", "an explicit value wins");
  assert.strictEqual(get(own, "Hotel welcome name"), "the Hampton Inn Overland Park");
  const fillIgnored = D.resolve({ "Hotel name": "the Inn", "Hotel short name": "[FILL: short]" }, {});
  assert.strictEqual(get(fillIgnored, "Hotel short name"), "the Inn", "a [FILL] placeholder does not count as a value");
});

test("aliases: Wi-Fi network name, incidental deposit and the spoken breakfast hours, pool hours and pet fee quote derive from the one answer", () => {
  const r = D.resolve({ "Wi-Fi network": "LotusGuest", "Breakfast hours": "6–10 AM", "Pool opening time": "10 AM", "Pool closing time": "10 PM", "Pet fee": "$75 per stay for 1–3 nights, $125 per stay for 4 or more nights", "Debit hold amount": "$50" }, {});
  assert.strictEqual(get(r, "Wi-Fi network name"), "LotusGuest");
  assert.strictEqual(get(r, "Breakfast hours spoken"), "6 to 10");
  assert.strictEqual(get(r, "Pool hours"), "10 AM–10 PM");
  assert.strictEqual(get(r, "Pet fee quote"), "$75");
  assert.strictEqual(get(r, "Incidental deposit amount"), "$50");
  assert.strictEqual(get(D.resolve({ "Breakfast hours": "6:30 AM–9:30 AM" }, {}), "Breakfast hours spoken"), "6:30 to 9:30");
  assert.strictEqual(get(D.resolve({ "Pool opening time": "10 AM" }, {}), "Pool hours"), "", "needs both times");
  assert.strictEqual(get(D.resolve({ "Incidental deposit amount": "$25" }, {}), "Debit hold amount"), "$25", "the alias works both ways");
});

test("aliases: the lost and found hold period defaults to 30 days", () => {
  assert.strictEqual(get(D.resolve({}, {}), "Lost and found hold period"), "30 days");
  assert.strictEqual(get(D.resolve({ "Lost and found hold period": "60 days" }, {}), "Lost and found hold period"), "60 days");
});

test("generated wording: cashless fills all seven cash tokens with the existing cashless wording; nothing is stored", () => {
  const d = {};
  const r = D.resolve(d, { answers: { cash: false } });
  for (const [k, v] of Object.entries(D.CASH_NO)) assert.strictEqual(get(r, k), v, k);
  assert.deepStrictEqual(d, {}, "resolve never writes into the input");
  assert.strictEqual(get(r, "Starting cash note"), "Starting Cash $0, the hotel is cashless");
  assert.strictEqual(get(D.resolve({}, {}), "Cash policy"), "", "no answer, no wording");
});

test("generated wording: cash yes asks for policy, deposit and starting cash and generates the rest", () => {
  const r = D.resolve({ "Cash policy": "Cash for rooms up to $200.", "Cash deposit step": "Deposit is $100 cash.", "Starting cash note": "Starting Cash $200" }, { answers: { cash: true } });
  assert.strictEqual(get(r, "Cash policy"), "Cash for rooms up to $200.");
  assert.strictEqual(get(r, "Cash payment step"), D.CASH_YES["Cash payment step"]);
  assert.strictEqual(get(r, "Cash payment script"), "We can take cash for that.");
  assert.strictEqual(get(r, "Shop payment step"), "Post the item to the room, or take a card or cash.");
  assert.strictEqual(get(r, "Card machine down cash step"), "Cash can be taken while the machine is down.");
  assert.ok(!/\[FILL/.test(JSON.stringify(r)), "no placeholder text in generated wording");
  assert.strictEqual(get(r, "Starting cash note"), "Starting Cash $200");
});

test("generated wording: rollaways, pack-and-plays and connecting rooms from the yes/no (and the one follow-up)", () => {
  const no = D.resolve({}, { answers: { rollaways: false, pack_and_plays: false, connecting_rooms: false } });
  assert.strictEqual(get(no, "Rollaway policy"), "No rollaways are available.");
  assert.strictEqual(get(no, "Rollaway script"), "We don't have rollaways.", "no sofa sleeper type, so no sofa clause");
  assert.strictEqual(get(no, "Rollaway crib script"), "We don't have rollaways, but I can bring a crib up for you at no charge.");
  assert.strictEqual(get(no, "Pack-and-play policy"), "No pack-and-plays are stocked.");
  assert.strictEqual(get(no, "Connecting rooms policy"), "The hotel doesn't offer connecting rooms.");
  assert.strictEqual(get(no, "Connecting rooms script"), "We don't have connecting rooms, but I can put you right next to each other.");
  const sofa = D.resolve({}, { answers: { rollaways: false }, rooms: { types: [{ code: "KXTY", name: "King Study", count: 3, rooms: [], sofa: true }] } });
  assert.strictEqual(get(sofa, "Rollaway script"), "We don't have rollaways, but our King Study rooms have a sofa sleeper.", "the existing wording when a sofa sleeper type exists");
  const yes = D.resolve({ "Rollaway fee": "$15 per night", "Pack-and-play fee": "No charge", "Connecting room pairs": "201–202" }, { answers: { rollaways: true, pack_and_plays: true, connecting_rooms: true } });
  assert.strictEqual(get(yes, "Rollaway policy"), "Rollaways are available. Fee: $15 per night.");
  assert.strictEqual(get(yes, "Rollaway script"), "We can bring a rollaway up for you. The fee is $15 per night.");
  assert.strictEqual(get(yes, "Pack-and-play policy"), "Pack-and-plays are available. Fee: No charge.");
  assert.strictEqual(get(yes, "Connecting rooms policy"), "Connecting rooms are available on request. Connecting rooms: 201–202.");
  assert.strictEqual(get(yes, "Connecting rooms script"), "We can try to connect your rooms.");
  const bare = D.resolve({}, { answers: { rollaways: true } });
  assert.strictEqual(get(bare, "Rollaway policy"), "Rollaways are available.", "no fee typed yet, no fee clause");
});

test("changing an answer drops the stored wording the old answer generated, and keeps what the GM typed", () => {
  const d = { "Cash policy": D.CASH_NO["Cash policy"], "Cash payment step": "Take a card, or cash from the owner.", "Cash payment script": D.CASH_NO["Cash payment script"] };
  const out = D.dropStaleGenerated(d, "cash", { cash: false }, { cash: true }, null);
  assert.ok(!("Cash policy" in out) && !("Cash payment script" in out));
  assert.strictEqual(out["Cash payment step"], "Take a card, or cash from the owner.", "typed text stays");
  assert.deepStrictEqual(D.dropStaleGenerated(d, "cash", {}, { cash: true }, null), d, "a first answer drops nothing");
});

test("syncAfterSave: an alias that still equals what it derived follows the edit; a customised one stays", () => {
  const before = { "Hotel name": "the Hampton Inn", "Hotel short name": "the Hampton Inn", "Hotel welcome name": "the Hampton", "Pool opening time": "10 AM", "Pool closing time": "10 PM", "Pool hours": "10 AM–10 PM" };
  const after = D.syncAfterSave(before, { ...before, "Hotel name": "the Hampton Inn Overland Park", "Pool closing time": "11 PM" });
  assert.strictEqual(after["Hotel short name"], "the Hampton Inn Overland Park", "followed");
  assert.strictEqual(after["Hotel welcome name"], "the Hampton", "customised, left alone");
  assert.strictEqual(after["Pool hours"], "10 AM–11 PM");
  const blank = D.syncAfterSave({ "Hotel name": "A" }, { "Hotel name": "B" });
  assert.deepStrictEqual(blank, { "Hotel name": "B" }, "a blank alias is not written; it resolves live");
});

test("percent validation: a number is a percentage, prose is not", () => {
  const f = D.fieldOf("Early check-in occupancy limit");
  assert.strictEqual(f.label, "Early check-in fee applies when occupancy is above ___%");
  for (const ok of ["70", "70%", " 70 % ", "0", "100", "62.5%"]) assert.ok(D.valueFilled(f, ok), ok);
  for (const bad of ["2 people per bed in a room.", "", "[FILL: occupancy percentage]", "101", "seventy"]) assert.ok(!D.valueFilled(f, bad), bad);
});

/* ---------- rooms ---------- */
const HLS_INV = () => R.normalize({ types: [
  { code: "KG", name: "Standard King", count: 4, rooms: ["301", "302", "303", "304"] },
  { code: "HRK", name: "Accessible King", count: 1, rooms: ["210"], accessible: true },
  { code: "HQ", name: "Accessible Queen", count: 3, rooms: ["219", "319", "419"], accessible: true },
  { code: "QQ", name: "Two Queens", count: 2, rooms: ["305", "306"], fridge: true, sofa: true },
] });

test("room inventory derives Room type N, totals, floors, lists and the flagged-type lists", () => {
  const dv = R.derive(HLS_INV());
  assert.strictEqual(dv["Total rooms"], "10");
  assert.strictEqual(dv["Room Type Count"], "4");
  assert.strictEqual(dv["Room type 1"], "KG: Standard King (4 rooms)");
  assert.strictEqual(dv["Room type 2"], "HRK: Accessible King (1 room)");
  assert.strictEqual(dv["Rooms per floor"], "Floor 2: 2, Floor 3: 7, Floor 4: 1");
  assert.strictEqual(dv["Room list by type"].split("\n")[0], "KG: Standard King: 301–304");
  assert.strictEqual(dv["Accessible room list"], "210 (HRK), 219, 319, 419 (HQ)", "the short form hls uses today");
  assert.strictEqual(dv["Accessible rooms"], "210 (Accessible King), 219, 319, 419 (Accessible Queen)");
  assert.strictEqual(dv["Fridge and microwave rooms"], "QQ Two Queens rooms");
  assert.strictEqual(dv["Sofa sleeper rooms"], "QQ Two Queens rooms");
  const more = R.normalize({ types: Array.from({ length: 9 }, (_, i) => ({ code: "T" + i, count: 1 })) });
  assert.strictEqual(R.derive(more)["Room type 9"], "T8 (1 room)", "any number of types");
  assert.ok(!("Rooms per floor" in R.derive(more)), "no floors without room numbers");
  assert.deepStrictEqual(R.derive({ types: [] }), {});
});

test("room inventory resolves through the token resolver and an explicit old value still wins", () => {
  const inv = HLS_INV();
  const r = D.resolve({ "Room type 1": "KXTD: King Standard (32 rooms)." }, { rooms: inv });
  assert.strictEqual(get(r, "Room type 1"), "KXTD: King Standard (32 rooms).");
  assert.strictEqual(get(r, "Room type 2"), "HRK: Accessible King (1 room)");
  assert.strictEqual(get(r, "Accessible room list"), "210 (HRK), 219, 319, 419 (HQ)");
});

test("normalize: de-duplicates codes, keeps flags, derives a missing count from the rooms and caps the list", () => {
  const n = R.normalize({ types: [{ code: " kg ", count: "", rooms: ["102", "101", "101"] }, { code: "KG", count: 5 }, { code: "" }, null, { code: "A", count: -3, accessible: true }] });
  assert.deepStrictEqual(n.types.map((t) => [t.code, t.count, t.rooms.join(","), t.accessible]), [["kg", 2, "101,102", false], ["A", 0, "", true]]);
  assert.strictEqual(R.normalize({ types: Array.from({ length: 200 }, (_, i) => ({ code: "C" + i })) }).types.length, R.MAX_TYPES);
});

test("fromLegacy: builds the hls inventory from Room list by type and marks HQ and HRK accessible", () => {
  const hls = {
    "Room Type Count": "4", "Total rooms": "10", "Rooms per floor": "2nd: 2, 3rd: 7, 4th: 1",
    "Room list by type": "KG (Standard King): 301–304\nHRK: 210\nHQ: 219, 319, 419\nQQ: 305, 306",
    "Room type 1": "KG: Standard King (4 rooms)", "Room type 2": "HRK: Accessible King (1 room)", "Room type 3": "HQ: Accessible Queen (3 rooms)", "Room type 4": "QQ: Two Queens (2 rooms)",
    "Accessible room list": "210 (HRK), 219, 319, 419 (HQ)",
  };
  const { inventory, notes } = R.fromLegacy(hls);
  assert.deepStrictEqual(notes, []);
  assert.deepStrictEqual(inventory.types.map((t) => [t.code, t.count, t.accessible]), [["KG", 4, false], ["HRK", 1, true], ["HQ", 3, true], ["QQ", 2, false]]);
  assert.strictEqual(inventory.types.find((t) => t.code === "HQ").name, "Accessible Queen", "the name comes from the Room type line");
  assert.strictEqual(R.total(inventory), 10);
});

test("fromLegacy: Hampton's Room type 1..7 become a 7-type, 133-room inventory; unreadable text yields no inventory, never a wrong one", () => {
  const { inventory } = R.fromLegacy(HOP);
  assert.strictEqual(inventory.types.length, 7);
  assert.strictEqual(R.total(inventory), 133);
  assert.deepStrictEqual(inventory.types.filter((t) => t.accessible).map((t) => t.code), ["NKXQA", "NERQA", "NDRQB"]);
  assert.ok(inventory.types.find((t) => t.code === "KXTY").sofa);
  assert.ok(inventory.types.find((t) => t.code === "KXLX").fridge);
  const bad = R.fromLegacy({ "Room type 1": "mostly king rooms", "Room type 2": "KG: King (4 rooms)" });
  assert.strictEqual(bad.inventory, null);
  assert.ok(bad.notes.length);
  assert.strictEqual(R.fromLegacy({}).inventory, null);
});

/* ---------- migration ---------- */
test("migrateHotel carries values into the merged fields, never removes or changes a key, and is idempotent", () => {
  const before = { details: { "Hotel short name": "the Lotus", "Wi-Fi network name": "LotusGuest", "Pool hours": "9 AM–9 PM", "Cash policy": "The hotel is completely cashless.", "Rollaway policy": "No rollaways are available.", "Pack-and-play policy": "Pack-and-plays are available.", "Connecting rooms policy": "The hotel doesn't offer connecting rooms.", "Early check-in occupancy limit": "2 people per bed in a room." }, answers: {}, rooms: null };
  const m = D.migrateHotel(before);
  assert.strictEqual(m.details["Hotel name"], "the Lotus");
  assert.strictEqual(m.details["Wi-Fi network"], "LotusGuest");
  assert.strictEqual(m.details["Pool opening time"], "9 AM");
  assert.strictEqual(m.details["Pool closing time"], "9 PM");
  assert.deepStrictEqual([m.answers.cash, m.answers.rollaways, m.answers.pack_and_plays, m.answers.connecting_rooms], [false, false, true, false]);
  for (const k of Object.keys(before.details)) assert.strictEqual(m.details[k], before.details[k], k + " unchanged");
  assert.strictEqual(m.details["Early check-in occupancy limit"], "2 people per bed in a room.", "kept, not erased");
  const again = D.migrateHotel({ details: m.details, answers: m.answers, rooms: m.rooms });
  assert.deepStrictEqual(again.changes, [], "second run changes nothing");
  assert.deepStrictEqual(again.details, m.details);
});

// Render every SOP before and after through the same token resolver and compare the strings.
function renderAll(details, ctx) {
  const resolved = ctx ? D.resolve(details, ctx) : details;
  return SOPS.map((s) => JSON.stringify(forModel(s, CONTACTS, resolved)));
}
test("render-diff: Hampton renders identically before and after the migration for all 238 SOPs", () => {
  assert.ok(SOPS.length >= 230);
  const before = renderAll(HOP);
  const m = D.migrateHotel({ details: HOP, answers: HOP_ANSWERS, rooms: null });
  const after = renderAll(m.details, { answers: m.answers, rooms: m.rooms });
  assert.deepStrictEqual(after, before);
  // and no token reads differently where a value existed
  const fb = tokenFiller(CONTACTS, HOP), fa = tokenFiller(CONTACTS, D.resolve(m.details, { answers: m.answers, rooms: m.rooms }));
  for (const k of Object.keys(HOP)) if (D.filled(HOP[k])) assert.strictEqual(fa(`{${k}}`), fb(`{${k}}`), k);
});

test("render-diff: a hotel with the old doubled fields (hls-like) keeps every rendered value; blanks may only become values", () => {
  const hls = {
    "Hotel name": "the Hotel Lotus Stadium", "Hotel short name": "the Lotus Stadium", "Wi-Fi network": "LotusStadium / pw: Stad1um", "Wi-Fi network name": "LotusStadium",
    "Check-in time": "3 PM", "Check-out time": "11 AM", "Breakfast hours": "6–9 AM", "Breakfast hours spoken": "6 to 9", "Pool hours": "9 AM–9 PM", "Pool opening time": "9 AM", "Pool closing time": "9 PM",
    "Cash policy": D.CASH_NO["Cash policy"], "Cash payment step": D.CASH_NO["Cash payment step"], "Cash payment script": D.CASH_NO["Cash payment script"], "Cash deposit step": D.CASH_NO["Cash deposit step"],
    "Starting cash note": D.CASH_NO["Starting cash note"], "Card machine down cash step": D.CASH_NO["Card machine down cash step"],
    "Rollaway policy": "No rollaways are available.", "Rollaway script": "We don't have rollaways.", "Connecting rooms policy": "The hotel doesn't offer connecting rooms.",
    "Early check-in occupancy limit": "2 people per bed in a room.",
    "Room Type Count": "4", "Total rooms": "10", "Room list by type": "KG (Standard King): 301–304\nHRK: 210\nHQ: 219, 319, 419\nQQ: 305, 306",
    "Room type 1": "KG: Standard King (4 rooms)", "Room type 2": "HRK: Accessible King (1 room)", "Room type 3": "HQ: Accessible Queen (3 rooms)", "Room type 4": "QQ: Two Queens (2 rooms)",
    "Accessible room list": "210 (HRK), 219, 319, 419 (HQ)", "Accessible rooms": "210 HRK, 219, 319, 419 HQ",
  };
  const answers = { cash: false, rollaways: false };
  const m = D.migrateHotel({ details: hls, answers, rooms: null });
  assert.strictEqual(m.rooms.types.length, 4, "inventory built");
  assert.deepStrictEqual(m.rooms.types.filter((t) => t.accessible).map((t) => t.code), ["HRK", "HQ"]);
  const fb = tokenFiller(CONTACTS, hls), fa = tokenFiller(CONTACTS, D.resolve(m.details, { answers: m.answers, rooms: m.rooms }));
  for (const sop of SOPS) {
    const text = [sop.title, ...sop.steps.map((x) => x.t), sop.script, sop.flag].join("\n");
    for (const t of new Set([...text.matchAll(/\{([^{}]+)\}/g)].map((x) => x[1]))) {
      const b = fb(`{${t}}`), a = fa(`{${t}}`);
      if (b !== UNSET && !/\[FILL/.test(b)) assert.strictEqual(a, b, `${sop.id} {${t}}`);
    }
  }
  assert.strictEqual(get(D.resolve(m.details, { answers: m.answers, rooms: m.rooms }), "Rooms per floor"), "Floor 2: 2, Floor 3: 7, Floor 4: 1");
});

test("every detail in the old master list is either asked by the wizard or generated/retired: nothing is orphaned", () => {
  const master = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "db", "seed-data", "master-sops.json"), "utf8"));
  for (const d of master.details) assert.ok(D.fieldOf(d.key) || D.isGenerated(d.key), `${d.key} is neither asked nor generated`);
  for (const f of D.FIELDS) assert.ok(!D.isGenerated(f.key), `${f.key} is both asked and generated`);
});
