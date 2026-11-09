const test = require("node:test");
const assert = require("node:assert");
const ob = require("../src/onboard");

// A trimmed copy of the hotel detail definitions (key + amenity group) the server hands to these helpers.
const DEFS = [
  ["Check-in time"], ["Check-out time"], ["Hotel name"], ["Wi-Fi network"], ["Wi-Fi network name"],
  ["Late check-out cutoff"], ["Smoking fee"], ["Quiet hours"], ["Visitor policy"], ["Occupancy limit"], ["Weapons policy"], ["Debit hold amount"], ["Parking pass days"],
  ["Early check-in fee"], ["Early check-in cutoff"], ["Cash policy"], ["Cash payment step"],
  ["Breakfast hours", "breakfast"], ["Pet fee", "pets"], ["Pet fee quote", "pets"], ["Laundry cost", "laundry"], ["Pool hours", "pool"],
  ["Accessible rooms"], ["Hearing kit location"], ["Room type 1"], ["Crib storage"], ["Rollaway policy"],
  ["ID scanner"], ["Log book app"], ["Key system"],
].map(([key, group]) => ({ key, group: group || null }));

test("classify: every known detail lands on a screen with a kind; amenity groups win", () => {
  assert.deepStrictEqual(ob.classify("Check-out time"), { screen: "hotel", kind: "identity", sec: "Name and times", more: false, ml: false });
  assert.strictEqual(ob.classify("Quiet hours").kind, "policy");
  assert.strictEqual(ob.classify("Quiet hours").screen, "policies");
  assert.strictEqual(ob.classify("Pet fee", "pets").kind, "amenity"); // "fee" must not make an amenity detail a policy
  assert.strictEqual(ob.classify("Pet fee", "pets").screen, "amenities");
  assert.strictEqual(ob.classify("Room type 3").screen, "rooms");
  assert.strictEqual(ob.classify("Key system").screen, "systems");
  assert.strictEqual(ob.classify("Wi-Fi network name").more, true);
  // a name the table doesn't know: policy-sounding goes to Policies, anything else to More details on the first screen
  assert.deepStrictEqual([ob.classify("Minimum age to check in").screen, ob.classify("Minimum age to check in").kind], ["policies", "policy"]);
  assert.deepStrictEqual([ob.classify("Pool towel color").screen, ob.classify("Pool towel color").more], ["hotel", true]);
});

test("classify: no detail is lost - every table key resolves and layout keys are unique", () => {
  const seen = new Set();
  for (const [, , , primary, more] of ob.LAYOUT) for (const k of [...primary, ...more]) { assert.ok(!seen.has(k), "duplicate " + k); seen.add(k); }
  const fs = require("fs"), path = require("path");
  const master = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "db", "seed-data", "master-sops.json"), "utf8"));
  for (const d of master.details) {
    const c = ob.classify(d.key, ["breakfast", "pool", "pets", "laundry", "market"].includes(d.group) ? d.group : null);
    assert.ok(ob.SCREENS.includes(c.screen), `${d.key} -> ${c.screen}`);
    assert.ok(["identity", "amenity", "policy", "rooms", "systems", "other"].includes(c.kind), `${d.key} kind`);
  }
});

test("templatePatch copies only policy-type keys, never identity, Wi-Fi, rooms, storage, systems or amenities", () => {
  const src = {
    id: "hop",
    answers: {},
    details: {
      "Hotel name": "the Hampton", "Wi-Fi network": "HamptonGuest", "Check-out time": "11 AM", "Room type 1": "KXTD", "Crib storage": "317 Storage",
      "ID scanner": "IDGuru", "Log book app": "Quore", "Breakfast hours": "6-10 AM", "Pet fee": "$75", "Pet fee quote": "$75", "Accessible rooms": "119",
      "Smoking fee": "$450", "Quiet hours": "[FILL]", "Late check-out cutoff": "12 PM", "Early check-in fee": "$50", "Cash policy": "The hotel is completely cashless.", "Weapons policy": "No weapons.",
    },
  };
  const out = ob.templatePatch(src, { details: {}, answers: {} }, DEFS);
  assert.deepStrictEqual(Object.keys(out.details).sort(), ["Cash policy", "Early check-in fee", "Late check-out cutoff", "Smoking fee", "Weapons policy"]);
  for (const bad of ["Hotel name", "Wi-Fi network", "Check-out time", "Room type 1", "Crib storage", "ID scanner", "Log book app", "Breakfast hours", "Pet fee", "Pet fee quote", "Accessible rooms"]) assert.ok(!(bad in out.details), bad + " must not be copied");
  assert.ok(!("Quiet hours" in out.details), "a [FILL] placeholder is not worth copying");
  assert.strictEqual(out.prefilled["Smoking fee"], "hop");
  assert.strictEqual(out.answers.cash, false, "cash answer read from the cashless policy text");
  assert.strictEqual(out.prefilled.cash, "hop");
});

test("templatePatch never overwrites what the GM typed, but replaces a [FILL] placeholder", () => {
  const src = { id: "hop", answers: { cash: true }, details: { "Smoking fee": "$450", "Quiet hours": "10 PM to 7 AM", "Visitor policy": "No visitors after 10." } };
  const cur = { details: { "Smoking fee": "$300", "Visitor policy": "[FILL: visitors]" }, answers: { cash: false } };
  const out = ob.templatePatch(src, cur, DEFS);
  assert.ok(!("Smoking fee" in out.details), "typed value kept");
  assert.strictEqual(out.details["Visitor policy"], "No visitors after 10.");
  assert.strictEqual(out.details["Quiet hours"], "10 PM to 7 AM");
  assert.ok(!("cash" in out.answers), "an existing cash answer is kept");
});

const READY = () => ({
  answers: { breakfast: true, pool: false, pets: false, laundry: true, market: false, cash: false, rollaways: false, pack_and_plays: false, connecting_rooms: false, chats_confirmed: true },
  details: {
    "Wi-Fi network": "LotusGuest", "Check-out time": "11 AM", "Late check-out cutoff": "12 PM", "Smoking fee": "$450", "Quiet hours": "10 PM to 7 AM", "Visitor policy": "x", "Occupancy limit": "4", "Weapons policy": "x",
    "Debit hold amount": "$50", "Parking pass days": "1 day", "Early check-in fee": "$50", "Early check-in cutoff": "12 PM", "Cash policy": "cashless", "Cash payment step": "card",
    "Accessible rooms": "119", "Hearing kit location": "desk", "Room type 1": "KXTD",
  },
  contacts: [{ role: "GM", name: "Priya Shah", phone: "(913) 555-0142" }],
  frontDesk: 1, used: ["Wi-Fi network", "Check-out time"], defs: DEFS, chatCustom: false,
});

test("readiness: all done scores 100 and may go live", () => {
  const r = ob.readiness(READY());
  assert.strictEqual(r.score, 100);
  assert.strictEqual(r.essentialsDone, true);
  assert.deepStrictEqual(r.missing, []);
  assert.strictEqual(r.items.reduce((n, i) => n + i.weight, 0), 100);
});

test("readiness: an empty hotel scores low, lists essentials first and points Fix links at fields", () => {
  const r = ob.readiness({ answers: {}, details: {}, contacts: [], frontDesk: 0, used: ["Wi-Fi network"], defs: DEFS });
  assert.ok(r.score < 15);
  assert.strictEqual(r.essentialsDone, false);
  const ids = r.missing.map((i) => i.id);
  assert.deepStrictEqual(ids.slice(0, 5), ["contact", "wifi", "checkout", "staff", "amenities"]);
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.deepStrictEqual([by.wifi.screen, by.wifi.field], ["hotel", "Wi-Fi network"]);
  assert.deepStrictEqual([by.checkout.screen, by.checkout.field], ["hotel", "Check-out time"]);
  assert.deepStrictEqual([by.staff.screen, by.staff.field], ["team", "team-add"]);
  assert.strictEqual(by.amenities.field, "amen-breakfast");
  assert.ok(by.policies.field && by.policies.screen === "policies");
});

test("readiness: essentials are each required", () => {
  const without = (fn) => { const i = READY(); fn(i); return ob.readiness(i); };
  assert.strictEqual(without((i) => (i.contacts = [{ role: "Engineer", name: "Luis", phone: "9135550177" }])).essentialsDone, false, "engineer alone is not enough");
  assert.strictEqual(without((i) => (i.contacts = [{ role: "AGM", name: "Tom", phone: "" }])).essentialsDone, false, "a GM/AGM needs a phone");
  assert.strictEqual(without((i) => (i.contacts = [{ role: "agm", name: "Tom", phone: "913-555-0111" }])).essentialsDone, true, "AGM with a phone counts");
  assert.strictEqual(without((i) => { i.details["Wi-Fi network"] = "[FILL: network name]"; }).essentialsDone, false, "a [FILL] Wi-Fi is not filled");
  assert.strictEqual(without((i) => { delete i.details["Wi-Fi network"]; i.details["Wi-Fi network name"] = "Guest"; }).essentialsDone, true, "either Wi-Fi detail counts");
  assert.strictEqual(without((i) => delete i.details["Check-out time"]).essentialsDone, false);
  assert.strictEqual(without((i) => (i.frontDesk = 0)).essentialsDone, false);
  assert.strictEqual(without((i) => { i.frontDesk = 0; i.answers.staff_later = true; }).essentialsDone, true, "'staff later' satisfies the staff item");
  assert.strictEqual(without((i) => delete i.answers.market).essentialsDone, false, "all five amenity answers are needed");
  const r = without((i) => delete i.answers.market);
  assert.strictEqual(r.items.find((i) => i.id === "amenities").label, "Answer the amenity question");
});

test("readiness: recommended items lower the score but never block go-live", () => {
  const i = READY(); delete i.details["Quiet hours"]; delete i.details["Room type 1"]; i.answers.chats_confirmed = false; i.used.push("Hearing kit location", "Laundry cost");
  const r = ob.readiness(i);
  assert.strictEqual(r.essentialsDone, true);
  assert.ok(r.score < 100 && r.score > 80, "score " + r.score);
  assert.deepStrictEqual(r.missing.map((x) => x.id).sort(), ["blanks", "chats", "policies", "rooms"]);
  const chats = ob.readiness({ ...i, chatCustom: true }).items.find((x) => x.id === "chats");
  assert.strictEqual(chats.done, true, "custom chat names count as confirmed");
});

test("fmtPhone formats US numbers and leaves the rest alone", () => {
  assert.strictEqual(ob.fmtPhone("913-341-1551"), "(913) 341-1551");
  assert.strictEqual(ob.fmtPhone("+1 (913) 341 1551"), "(913) 341-1551");
  assert.strictEqual(ob.fmtPhone("19133411551"), "(913) 341-1551");
  assert.strictEqual(ob.fmtPhone("341-1551"), "341-1551");
  assert.strictEqual(ob.fmtPhone(null), "");
});

const DOC = [
  "Hotel Lotus Merriam Guest Handbook",
  "Check-in is at 3 PM. Check-out is 11 AM.",
  "Wi-Fi network: LotusMerriam-Guest",
  "Quiet hours are 10 PM to 7 AM.",
  "We serve a free hot breakfast from 6 to 10 AM daily.",
  "We do not have a pool.",
  "General Manager: Priya Shah 913-555-0142",
  "Assistant General Manager: Tom Becker",
  "Engineer: Luis Ortega (913) 555-0177",
].join("\n");
const KEYS = DEFS.map((d) => d.key);

test("coerceExtraction keeps grounded values, canonical keys and formatted phones", () => {
  const out = ob.coerceExtraction({
    details: [{ key: "check-in time", value: "3 PM" }, { key: "Wi-Fi network", value: " LotusMerriam-Guest " }, { key: "Quiet hours", value: "10 PM to 7 AM" }, { key: "Breakfast hours", value: "6 to 10 AM" }],
    answers: [{ key: "breakfast", value: "yes", quote: "We serve a free hot breakfast" }, { key: "pool", value: false, quote: "we do not have a pool" }],
    contacts: [
      { role: "General Manager", name: "Priya Shah", phone: "913-555-0142" },
      { role: "assistant general manager", name: "Tom Becker", phone: "" },
      { role: "Chief Engineer", name: "Luis Ortega", phone: "1 (913) 555-0177" },
    ],
  }, { keys: KEYS, text: DOC });
  assert.deepStrictEqual(out.details.map((d) => [d.key, d.value]), [["Check-in time", "3 PM"], ["Wi-Fi network", "LotusMerriam-Guest"], ["Quiet hours", "10 PM to 7 AM"], ["Breakfast hours", "6 to 10 AM"]]);
  assert.deepStrictEqual(out.answers, [{ key: "breakfast", value: true }, { key: "pool", value: false }]);
  assert.deepStrictEqual(out.contacts, [
    { role: "GM", name: "Priya Shah", phone: "(913) 555-0142" },
    { role: "AGM", name: "Tom Becker", phone: "" },
    { role: "Engineer", name: "Luis Ortega", phone: "(913) 555-0177" },
  ]);
});

test("coerceExtraction never invents: ungrounded, unknown, placeholder and malformed items are dropped", () => {
  const out = ob.coerceExtraction({
    details: [
      { key: "Smoking fee", value: "$450" }, // not in the document
      { key: "Check-out time", value: "noon" }, // not in the document
      { key: "Made Up Key", value: "3 PM" }, // not a field of the form
      { key: "Quiet hours", value: "n/a" }, { key: "Visitor policy", value: "[FILL: visitors]" }, { key: "Occupancy limit", value: "" },
      { key: "Quiet hours", value: "10 PM to 7 AM" }, { key: "Quiet hours", value: "11 PM to 6 AM" }, // first one wins
      null, "junk", { key: 5, value: {} },
    ],
    answers: [
      { key: "pets", value: true, quote: "pets are welcome" }, // quote not in the document
      { key: "pool", value: true }, // no quote at all
      { key: "pool", value: "maybe", quote: "We do not have a pool" }, // not a yes/no
      { key: "market", value: true, quote: "We do not have a pool" }, // unknown key can't borrow another's quote? (market is valid, quote is real) -> kept
      { key: "gym", value: true, quote: "We do not have a pool" },
    ],
    contacts: [
      { role: "GM", name: "Made Up Person", phone: "913-555-9999" }, // name not in the document
      { role: "Engineer", name: "Luis Ortega", phone: "913-555-8888" }, // real person, phone not in the document: keep the person, drop the phone
      { role: "", name: "Tom Becker" }, { role: "AGM", name: "" }, { role: "AGM", name: "n/a" },
    ],
  }, { keys: KEYS, text: DOC });
  assert.deepStrictEqual(out.details, [{ key: "Quiet hours", value: "10 PM to 7 AM" }]);
  assert.deepStrictEqual(out.answers.map((a) => a.key), ["market"]);
  assert.deepStrictEqual(out.contacts, [{ role: "Engineer", name: "Luis Ortega", phone: "" }]);
  assert.deepStrictEqual(ob.coerceExtraction(null, { keys: KEYS, text: DOC }), { details: [], answers: [], contacts: [] });
  assert.deepStrictEqual(ob.coerceExtraction({ details: "x", answers: 4, contacts: {} }, { keys: KEYS, text: DOC }), { details: [], answers: [], contacts: [] });
});

test("coerceExtraction caps and dedupes contacts by role", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ role: "Role " + i, name: "Person " + i }));
  const text = many.map((m) => `Role ${m.role.split(" ")[1]} Person ${m.name.split(" ")[1]}`).join("\n") + " Priya Shah";
  const out = ob.coerceExtraction({ contacts: [...many, { role: "GM", name: "Priya Shah" }, { role: "general manager", name: "Priya Shah" }] }, { keys: KEYS, text });
  assert.strictEqual(out.contacts.length, 12);
  const out2 = ob.coerceExtraction({ contacts: [{ role: "GM", name: "Priya Shah" }, { role: "general manager", name: "Priya Shah" }] }, { keys: KEYS, text: DOC });
  assert.strictEqual(out2.contacts.length, 1);
});

test("grounded: numbers must appear, words mostly appear, punctuation is ignored", () => {
  const t = ob.normText("Breakfast is served 6-10 AM in the lobby.");
  assert.ok(ob.grounded("6–10 AM", t));
  assert.ok(!ob.grounded("7–10 AM", t));
  assert.ok(ob.grounded("served in the lobby", t));
  assert.ok(!ob.grounded("served on the roof terrace", t));
  assert.ok(!ob.grounded("", t));
});

test("mergeExtractions keeps the first mention and tags each item with its file", () => {
  const a = { details: [{ key: "Check-in time", value: "3 PM" }], answers: [{ key: "pool", value: false }], contacts: [{ role: "GM", name: "A", phone: "" }] };
  const b = { details: [{ key: "check in time", value: "4 PM" }, { key: "Quiet hours", value: "10 PM" }], answers: [], contacts: [{ role: "GM", name: "B", phone: "" }, { role: "AGM", name: "C", phone: "" }] };
  const m = ob.mergeExtractions([{ file: "a.pdf", result: a }, { file: "b.docx", result: b }]);
  assert.deepStrictEqual(m.details.map((d) => [d.key, d.value, d.file]), [["Check-in time", "3 PM", "a.pdf"], ["Quiet hours", "10 PM", "b.docx"]]);
  assert.deepStrictEqual(m.contacts.map((c) => [c.role, c.name, c.file]), [["GM", "A", "a.pdf"], ["AGM", "C", "b.docx"]]);
});
