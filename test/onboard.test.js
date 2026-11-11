const test = require("node:test");
const assert = require("node:assert");
const ob = require("../src/onboard");

const D = require("../src/details");

test("classify: every asked detail lands on a screen with a kind; retired ones are marked derived", () => {
  assert.deepStrictEqual(ob.classify("Check-out time"), { screen: "hotel", kind: "identity", sec: "Name and times", more: false, ml: false });
  assert.strictEqual(ob.classify("Quiet hours").kind, "policy");
  assert.strictEqual(ob.classify("Quiet hours").screen, "policies");
  assert.strictEqual(ob.classify("Pet fee", "pets").kind, "amenity"); // "fee" must not make an amenity detail a policy
  assert.strictEqual(ob.classify("Pet fee", "pets").screen, "amenities");
  assert.strictEqual(ob.classify("Key system").screen, "systems");
  assert.strictEqual(ob.classify("AED location").screen, "basics");
  assert.strictEqual(ob.classify("Room type 3").derived, true, "Room type N comes from the room list now");
  assert.strictEqual(ob.classify("Wi-Fi network name").derived, true);
  // a name the table doesn't know: policy-sounding goes to Policies, anything else to More details on the first screen
  assert.deepStrictEqual([ob.classify("Minimum age to check in").screen, ob.classify("Minimum age to check in").kind], ["policies", "policy"]);
  assert.deepStrictEqual([ob.classify("Pool towel color").screen, ob.classify("Pool towel color").more], ["hotel", true]);
});

test("classify: no detail is lost - every old master detail resolves and layout keys are unique", () => {
  const seen = new Set();
  for (const [, , , primary, more] of ob.LAYOUT) for (const k of [...primary, ...more]) { assert.ok(!seen.has(k), "duplicate " + k); seen.add(k); }
  const fs = require("fs"), path = require("path");
  const master = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "db", "seed-data", "master-sops.json"), "utf8"));
  for (const d of master.details) {
    const c = ob.classify(d.key, ["breakfast", "pool", "pets", "laundry", "market"].includes(d.group) ? d.group : null);
    assert.ok(ob.SCREENS.includes(c.screen), `${d.key} -> ${c.screen}`);
    assert.ok(["identity", "amenity", "policy", "rooms", "systems", "basics", "other"].includes(c.kind), `${d.key} kind ${c.kind}`);
  }
  assert.ok(ob.SCREENS.includes("basics") && ob.STEP_IDS.includes("basics"));
});

const SRC = () => ({
  id: "hop",
  answers: { cash: false, pool: true, breakfast: true, rollaways: false },
  details: {
    "Hotel name": "the Hampton", "Wi-Fi network": "HamptonGuest", "Wi-Fi password": "pw", "Check-out time": "11 AM", "Crib storage": "317 Storage", "ID scanner": "IDGuru", "Log book app": "Quore",
    "Breakfast hours": "6-10 AM", "Pool opening time": "10 AM", "Pool closing time": "10 PM", "Pet fee": "$75", "Smoking fee": "$450", "Quiet hours": "[FILL]", "Late check-out cutoff": "12 PM",
    "Early check-in fee": "$50", "Early check-in occupancy limit": "70%", "Cash policy": "The hotel is completely cashless.", "Weapons policy": "No weapons.",
    "AED location": "Lobby", "Hotel address": "10591 Metcalf", "Front desk phone": "(913) 555-0100", "Late check-out fee": "$25",
  },
});

test("templatePatch fills the Policies screen only: never identity, Wi-Fi, rooms, storage, systems, amenities or basics", () => {
  const out = ob.templatePatch(SRC(), { details: {}, answers: {} });
  assert.deepStrictEqual(Object.keys(out.details).sort(), ["Early check-in fee", "Early check-in occupancy limit", "Late check-out cutoff", "Smoking fee", "Weapons policy"]);
  assert.ok(!("Cash policy" in out.details), "cashless: nothing to copy, the wording is generated");
  assert.ok(!("Quiet hours" in out.details), "a [FILL] placeholder is not worth copying");
  assert.strictEqual(out.prefilled["Smoking fee"], "hop");
  assert.strictEqual(out.answers.cash, false);
  assert.strictEqual(out.prefilled.cash, "hop");
});

test("templatePatch never overwrites what the GM typed, but replaces a [FILL] placeholder", () => {
  const src = { id: "hop", answers: { cash: true }, details: { "Smoking fee": "$450", "Quiet hours": "10 PM to 7 AM", "Visitor policy": "No visitors after 10." } };
  const cur = { details: { "Smoking fee": "$300", "Visitor policy": "[FILL: visitors]" }, answers: { cash: false } };
  const out = ob.templatePatch(src, cur);
  assert.ok(!("Smoking fee" in out.details), "typed value kept");
  assert.strictEqual(out.details["Visitor policy"], "No visitors after 10.");
  assert.strictEqual(out.details["Quiet hours"], "10 PM to 7 AM");
  assert.ok(!("cash" in out.answers), "an existing cash answer is kept");
});

test("copy per section: each screen takes only its own copyable answers and marks them 'check this'", () => {
  const src = SRC();
  const hotel = ob.copyPatch(src, { details: {}, answers: {} }, "hotel");
  assert.deepStrictEqual(Object.keys(hotel.details), ["Check-out time"], "name and Wi-Fi are identity; only the times copy");
  for (const k of ["Hotel name", "Wi-Fi network", "Wi-Fi password"]) assert.ok(!(k in hotel.details), k);
  const am = ob.copyPatch(src, { details: {}, answers: {} }, "amenities");
  assert.deepStrictEqual(am.answers, { pool: true, breakfast: true });
  assert.deepStrictEqual(Object.keys(am.details).sort(), ["Breakfast hours", "Pool closing time", "Pool opening time"]);
  assert.ok(!("Pet fee" in am.details), "pets was not answered yes, so its fee is not copied");
  assert.strictEqual(am.prefilled.pool, "hop");
  assert.strictEqual(am.prefilled["Breakfast hours"], "hop");
  const rooms = ob.copyPatch(src, { details: {}, answers: {} }, "rooms");
  assert.deepStrictEqual(Object.keys(rooms.details), ["Crib storage"], "storage copies; the room list never does");
  assert.deepStrictEqual(rooms.answers, { rollaways: false });
  const basics = ob.copyPatch(src, { details: {}, answers: {} }, "basics");
  assert.deepStrictEqual(Object.keys(basics.details), ["Late check-out fee"], "emergency locations, address and phone are never copied");
  const sys = ob.copyPatch(src, { details: {}, answers: {} }, "systems");
  assert.deepStrictEqual(Object.keys(sys.details).sort(), ["ID scanner", "Log book app"]);
  assert.ok(!ob.COPY_SCREENS.includes("team") && !ob.COPY_SCREENS.includes("contacts"), "contacts are never copied");
});

test("copy per section: a source that predates the merged fields is read the way the migration reads it", () => {
  const old = { id: "mpi", answers: {}, details: { "Pool hours": "9 AM–9 PM", "Cash policy": "No cash. The hotel is cashless.", "Rollaway policy": "No rollaways are available." } };
  const am = ob.copyPatch({ ...old, answers: { pool: true } }, { details: {}, answers: {} }, "amenities");
  assert.strictEqual(am.details["Pool opening time"], "9 AM");
  assert.strictEqual(ob.copyPatch(old, { details: {}, answers: {} }, "policies").answers.cash, false);
  assert.strictEqual(ob.copyPatch(old, { details: {}, answers: {} }, "rooms").answers.rollaways, false);
});

test("copy per section: only empty fields are filled", () => {
  const out = ob.copyPatch(SRC(), { details: { "Crib storage": "mine", "Pillow storage": "[FILL]" }, answers: { rollaways: true } }, "rooms");
  assert.ok(!("Crib storage" in out.details));
  assert.ok(!("rollaways" in out.answers), "an answer already given stays");
});

const READY = () => ({
  answers: { breakfast: true, pool: false, pets: false, laundry: false, market: false, cash: false, rollaways: false, pack_and_plays: false, connecting_rooms: false, chats_confirmed: true },
  details: {
    "Hotel name": "the Lotus", "Wi-Fi network": "LotusGuest", "Check-in time": "3 PM", "Check-out time": "11 AM", "Breakfast hours": "6–10 AM",
    "Late check-out cutoff": "12 PM", "Smoking fee": "$450", "Quiet hours": "10 PM to 7 AM", "Visitor policy": "x", "Occupancy limit": "4", "Weapons policy": "x",
    "Early check-in cutoff": "12 PM", "Early check-in occupancy limit": "70%", "Early check-in fee": "$50",
    "Hearing kit location": "desk", "Coffee supplies storage": "a", "Toiletries storage": "a", "Pillow storage": "a", "Crib storage": "a", "Fridge and microwave storage": "a",
    "AED location": "lobby", "First aid kit location": "desk", "Water shutoff location": "boiler", "Breaker panel location": "hall", "Flashlight location": "desk",
    "Hotel address": "1 Main St", "Front desk phone": "(913) 555-0100", "Debit hold amount": "$50", "Late check-out fee": "$25", "Parking cost": "Free", "Parking location": "rear lot",
    "ID scanner": "x", "Log book app": "x", "Key system": "x", "Card authorization tool": "x",
  },
  rooms: { types: [{ code: "KG", name: "King", count: 40, rooms: [] }] },
  contacts: [{ role: "GM", name: "Priya Shah", phone: "(913) 555-0142" }],
  frontDesk: 1, used: ["Wi-Fi network", "Check-out time"], chatCustom: false,
});

test("readiness: everything applicable answered scores 100 and may go live (100% is reachable)", () => {
  const r = ob.readiness(READY());
  assert.strictEqual(r.score, 100);
  assert.strictEqual(r.essentialsDone, true);
  assert.deepStrictEqual(r.missing, []);
  assert.strictEqual(r.items.reduce((n, i) => n + i.weight, 0), 100);
  assert.deepStrictEqual(r.skipped, []);
});

test("readiness: questions behind a No do not count; a Yes adds its follow-ups to the total", () => {
  const base = ob.readiness(READY());
  const i = READY(); i.answers.pets = false; i.answers.pool = false; i.answers.cash = false;
  assert.strictEqual(ob.readiness(i).score, 100, "No hides the pet, pool and cash follow-ups");
  assert.deepStrictEqual(ob.applicable(i).map((q) => q.key).filter((k) => /Pet|Pool|Cash/.test(k)), []);
  const y = READY(); y.answers.pets = true; y.answers.cash = true;
  const r = ob.readiness(y);
  assert.ok(r.score < 100);
  const keys = ob.applicable(y).map((q) => q.key);
  for (const k of ["Pets allowed", "Pet fee", "Cash policy", "Cash deposit step", "Starting cash note"]) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes("Pet fee quote") && !keys.includes("Cash payment step"), "generated tokens are never asked");
  const by = Object.fromEntries(r.items.map((x) => [x.id, x]));
  assert.strictEqual(by.amenfields.left, 2);
  assert.strictEqual(by.policies.left, 3);
  assert.ok(base.score === 100);
});

test("readiness: hotel-specific leftovers count only when a SOP that is on uses them", () => {
  const i = READY(); i.answers.breakfast = true;
  const keys = (u) => ob.applicable({ ...i, used: u }).map((q) => q.key);
  assert.ok(!keys([]).includes("To-go bag name") && !keys([]).includes("Parking pass days") && !keys([]).includes("Gym cups storage"));
  assert.ok(keys(["To-go bag name", "Parking pass days"]).includes("To-go bag name"));
  assert.ok(keys(["Parking pass days"]).includes("Parking pass days"));
  i.answers.pool = false;
  assert.ok(!keys(["Gym cups storage"]).includes("Gym cups storage"), "even if used, a No hides it");
  assert.ok(keys(["Some owner added detail"]).includes("Some owner added detail"), "an Owner-added detail used by a SOP is asked");
  assert.ok(!keys(["Pool hours", "Rollaway script", "Room type 3", "Wi-Fi network name"]).some((k) => /Pool hours|Rollaway|Room type|network name/.test(k)), "generated details are never asked");
  const r = ob.readiness({ ...i, used: ["Parking pass days"] });
  assert.ok(r.score < 100 && r.items.find((x) => x.id === "policies").left === 1);
});

test("readiness: the Rooms section counts the room list and the yes/no questions, not Room type 1 or Accessible rooms", () => {
  const i = READY(); i.rooms = null;
  const r = ob.readiness(i);
  assert.strictEqual(r.items.find((x) => x.id === "rooms").done, false);
  assert.strictEqual(r.items.find((x) => x.id === "rooms").field, "rooms-inventory");
  i.rooms = { types: [{ code: "KG", count: 0 }] };
  assert.strictEqual(ob.readiness(i).items.find((x) => x.id === "rooms").done, false, "a type with no rooms is not a room list");
  i.rooms = { types: [{ code: "KG", count: 3 }] };
  delete i.answers.rollaways;
  const r2 = ob.readiness(i).items.find((x) => x.id === "rooms");
  assert.strictEqual(r2.field, "yn-rollaways");
  assert.ok(r2.frac < 1 && r2.frac > 0.5);
  const j = READY(); delete j.details["Accessible rooms"]; delete j.details["Room type 1"];
  assert.strictEqual(ob.readiness(j).items.find((x) => x.id === "rooms").done, true);
});

test("readiness: an early check-in limit that is not a percent is unanswered; the value is kept", () => {
  const i = READY(); i.details["Early check-in occupancy limit"] = "2 people per bed in a room.";
  const r = ob.readiness(i);
  assert.strictEqual(r.items.find((x) => x.id === "policies").left, 1);
  assert.strictEqual(r.items.find((x) => x.id === "policies").field, "Early check-in occupancy limit");
  assert.strictEqual(i.details["Early check-in occupancy limit"], "2 people per bed in a room.");
});

test("readiness: Don't know yet is a marker; it does not block go-live unless the question is essential, and it is listed", () => {
  const i = READY(); delete i.details["AED location"]; delete i.details["Quiet hours"]; i.answers.unknown = { "AED location": true, "Quiet hours": true };
  const r = ob.readiness(i);
  assert.strictEqual(r.essentialsDone, true, "non-essential skipped questions never block");
  assert.deepStrictEqual(r.skipped.map((s) => s.key).sort(), ["AED location", "Quiet hours"]);
  assert.ok(r.score < 100, "a skipped question is not answered, so progress is below 100");
  const bs = r.items.find((x) => x.id === "basics");
  assert.strictEqual(bs.left, 0);
  assert.strictEqual(bs.skipped, 1);
  assert.ok(/Don't know yet/.test(bs.label));
  // essential: Wi-Fi marked unknown still blocks go-live
  const w = READY(); delete w.details["Wi-Fi network"]; w.answers.unknown = { "Wi-Fi network": true };
  assert.strictEqual(ob.readiness(w).essentialsDone, false);
  // a yes/no and the room list can be skipped too
  const y = READY(); delete y.answers.rollaways; y.rooms = null; y.answers.unknown = { rollaways: true, "rooms-inventory": true };
  const ry = ob.readiness(y);
  assert.deepStrictEqual(ry.skipped.map((s) => s.key).sort(), ["rollaways", "rooms-inventory"]);
  assert.strictEqual(ry.essentialsDone, true);
  // answering clears it from the list (the server drops the marker, but even a stale marker does not list an answered question)
  const a = READY(); a.answers.unknown = { "AED location": true };
  assert.deepStrictEqual(ob.readiness(a).skipped, []);
});

test("readiness: an empty hotel scores low, lists essentials first and points Fix links at fields", () => {
  const r = ob.readiness({ answers: {}, details: {}, contacts: [], frontDesk: 0, used: ["Wi-Fi network"] });
  assert.ok(r.score < 15, "score " + r.score);
  assert.strictEqual(r.essentialsDone, false);
  assert.deepStrictEqual(r.missing.map((i) => i.id).slice(0, 5), ["contact", "wifi", "checkout", "staff", "amenities"]);
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
  assert.strictEqual(without((i) => { delete i.details["Wi-Fi network"]; i.details["Wi-Fi network name"] = "Guest"; }).essentialsDone, true, "an older Wi-Fi name still counts");
  assert.strictEqual(without((i) => delete i.details["Check-out time"]).essentialsDone, false);
  assert.strictEqual(without((i) => (i.frontDesk = 0)).essentialsDone, false);
  assert.strictEqual(without((i) => { i.frontDesk = 0; i.answers.staff_later = true; }).essentialsDone, true, "'staff later' satisfies the staff item");
  assert.strictEqual(without((i) => delete i.answers.market).essentialsDone, false, "all five amenity answers are needed");
  const r = without((i) => delete i.answers.market);
  assert.strictEqual(r.items.find((i) => i.id === "amenities").label, "Answer the amenity question");
  assert.strictEqual(without((i) => { delete i.details["Wi-Fi password"]; }).essentialsDone, true, "the Wi-Fi password is optional");
});

test("readiness: recommended items lower the score but never block go-live", () => {
  const i = READY(); delete i.details["Quiet hours"]; i.rooms = null; i.answers.chats_confirmed = false; i.used.push("Parking pass days");
  const r = ob.readiness(i);
  assert.strictEqual(r.essentialsDone, true);
  assert.ok(r.score < 100 && r.score > 70, "score " + r.score);
  assert.deepStrictEqual(r.missing.map((x) => x.id).sort(), ["chats", "policies", "rooms"]);
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
const KEYS = D.FIELDS.map((f) => f.key);

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
