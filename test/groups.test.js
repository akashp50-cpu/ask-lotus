// Brand groups: the pure helpers (kind, copy rules, what changed, PMS wording for the AI prompts). No database.
const test = require("node:test");
const assert = require("node:assert");
const g = require("../src/groups");
const ai = require("../src/ai");
const { pdfSystem } = require("../src/importer");

const sop = (title, steps, extra = {}) => ({ title, steps: steps.map((t) => ({ t, img: null })), script: "", flag: "", ...extra });

test("classifyKind: brand by the title (Honors, Digital Check-In, Digital Key, Hilton...) or a Hilton-only master with no PMS steps", () => {
  assert.strictEqual(g.classifyKind(sop("Anything", ["Say hello."]), { applies: "hilton" }), "brand");
  assert.strictEqual(g.classifyKind(sop("Diamond arrival", ["Greet the guest."])), "brand");
  assert.strictEqual(g.classifyKind(sop("Finding Digital Check-In guests", ["Open the list."])), "brand");
  assert.strictEqual(g.classifyKind(sop("Digital Key guest", ["Reissue the key."])), "brand");
  // A passing mention doesn't make it brand-only; a Hilton-only master that walks through screens is PMS steps.
  assert.strictEqual(g.classifyKind(sop("Answering the phone", ["Say: Thank you for calling Hampton Inn."])), "general");
  assert.strictEqual(g.classifyKind(sop("Undo a check-out", ["Departures > open the reservation."]), { applies: "hilton" }), "pms");
});

test("classifyKind: pms when steps mention PEP, HotelKey, folio, V2, Copy Reservation, Night Audit, screens, tabs, clicks or a menu path", () => {
  for (const t of ["Open PEP and search.", "In HotelKey, open the reservation.", "Check the folio.", "Use V2.", "Use Copy Reservation.", "Run the Night Audit tab.", "Go to the Stay tab.", "Click Save.", "More > Lost and Found"]) {
    assert.strictEqual(g.classifyKind(sop("T", [t])), "pms", t);
  }
});

test("classifyKind: general otherwise, and brand wins over pms", () => {
  assert.strictEqual(g.classifyKind(sop("Fire alarm", ["Call 911.", "Walk the floors."])), "general");
  assert.strictEqual(g.classifyKind(sop("Honors in PEP", ["Open PEP.", "Greet the Honors member."])), "brand");
});

test("familyOf: the master id, a stored family, or hotel:id for a hotel-only SOP", () => {
  assert.strictEqual(g.familyOf({ hotel_id: "h", id: "CI-01", master_id: "CI-01" }), "CI-01");
  assert.strictEqual(g.familyOf({ hotel_id: "h", id: "ZZ-01", family: "h:ZZ-01" }), "h:ZZ-01");
  assert.strictEqual(g.familyOf({ hotel_id: "h", id: "ZZ-02" }), "h:ZZ-02");
});

test("copies: general always, PMS only on the same PMS, brand only on the same brand", () => {
  const hop = { brand: "hilton", system: "pep" }, mpi = { brand: "independent", system: "hotelkey" }, hk2 = { brand: "ihg", system: "hotelkey" };
  assert.strictEqual(g.copies("general", hop, mpi), true);
  assert.strictEqual(g.copies("pms", hop, mpi), false);
  assert.strictEqual(g.copies("pms", mpi, hk2), true);
  assert.strictEqual(g.copies("brand", mpi, hk2), false);
  assert.strictEqual(g.copies("brand", hop, { brand: "hilton", system: "other" }), true);
  assert.strictEqual(g.groupKey(hop), "hilton|pep");
});

test("changedFields and changeLabel say what differs", () => {
  const a = { title: "T", category: "C", steps: [{ t: "One", img: null }], script: "", flag: "", keywords: "x" };
  assert.deepStrictEqual(g.changedFields(a, { ...a }), []);
  assert.deepStrictEqual(g.changedFields(a, { ...a, steps: [{ t: "One", img: "other-hotel-id" }] }), ["steps"]); // a picture was added
  assert.deepStrictEqual(g.changedFields(a, { ...a, steps: [{ t: "  One ", img: null }] }), []); // whitespace is not a change
  assert.deepStrictEqual(g.changedFields(a, { ...a, steps: [{ t: "Two", img: null }], script: "Hi" }), ["steps", "script"]);
  assert.strictEqual(g.changeLabel(["steps"]), "Steps changed");
  assert.strictEqual(g.changeLabel(["steps", "script"]), "Steps and what to say changed");
  assert.strictEqual(g.changeLabel(["title", "steps", "flag"]), "3 things changed");
});

test("PMS wording: pmsLine and pmsRulesClause use the Owner's name, staff name and rules", () => {
  const pep = { name: "PEP", staff_name: "PEP", rules: 'Say "PEP". The folio is V2.' };
  assert.strictEqual(g.pmsLine(pep), 'PEP. Say "PEP". The folio is V2.');
  assert.strictEqual(g.pmsRulesClause(pep), 'Say "PEP"; The folio is V2');
  const hk = { name: "HotelKey NextGen", staff_name: "HotelKey", rules: "" };
  assert.strictEqual(g.pmsLine(hk), 'HotelKey NextGen (staff call it "HotelKey")');
  assert.strictEqual(g.pmsRulesClause(hk), "");
  assert.strictEqual(g.pmsOf({ system: "pep" }, null).name, "PEP"); // old hotels keep the wording the code always had
  assert.strictEqual(g.pmsOf({ system: "x" }, { name: "Opera" }).name, "Opera");
});

test("PMS wording reaches the author prompt and the PDF prompt (and the cashless rule stays)", () => {
  const rules = 'Say "Opera". The folio is called the Guest Ledger.';
  const a = ai.authorSystem({ hotelName: "H", system: "Opera", pmsRules: g.pmsRulesClause({ rules }), categories: ["C"], detailKeys: [], roles: [], pdf: true });
  assert.match(a, /Opera/);
  assert.match(a, /Guest Ledger/);
  assert.doesNotMatch(a, /\bPEP\b/);
  const p = pdfSystem({ pmsName: "Opera", pmsRules: g.pmsRulesClause({ rules }) });
  assert.match(p, /"Opera"/);
  assert.match(p, /Guest Ledger/);
  assert.match(p, /cashless/);
  assert.doesNotMatch(p, /\bPEP\b/);
});
