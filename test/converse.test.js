const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ai = require("../src/ai");

const ctx = (o = {}) => ({
  valid: new Set(["KY-01", "KY-02", "EM-01", "CO-04"]),
  stepCount: { "KY-01": 5, "KY-02": 4, "EM-01": 3, "CO-04": 4 },
  asks: 0, expert: true, emergency: false, emergencyId: null, fallbackIds: ["KY-01"], staffText: "guest key problem", ...o,
});

test("looseParse reads fenced, chatty and trailing-comma JSON", () => {
  assert.deepStrictEqual(ai.looseParse('Sure:\n```json\n{"action":"none",}\n```'), { action: "none" });
  assert.strictEqual(ai.looseParse("nothing"), null);
});

test("answer: validates the SOP id, cleans focus steps, trims tip", () => {
  const r = ai.coerceTurn({ action: "answer", sop_id: "ky-01", answer: "  Re-encode the key. ", tip: "Stay calm.", focus_steps: [2, 2, 9, "x", 3] }, ctx());
  assert.deepStrictEqual(r, { kind: "answer", sopId: "KY-01", answer: "Re-encode the key.", tip: "Stay calm.", focusSteps: [2, 3], coerced: false });
  // all steps relevant -> no highlight
  assert.deepStrictEqual(ai.coerceTurn({ action: "answer", sop_id: "EM-01", answer: "x", focus_steps: [1, 2, 3] }, ctx()).focusSteps, []);
});

test("answer with an unknown SOP becomes advice (or none when expert guidance is off)", () => {
  const raw = { action: "answer", sop_id: "ZZ-99", answer: "x", advice: "Stay calm and listen." };
  assert.strictEqual(ai.coerceTurn(raw, ctx()).kind, "advise");
  assert.strictEqual(ai.coerceTurn(raw, ctx({ expert: false })).kind, "none");
});

test("ask: cleans options, adds Something else to a lone option, caps at 4", () => {
  const r = ai.coerceTurn({ action: "ask", question: "Still staying?", options: ["Yes", "No", "Yes", "Maybe", "Other", "Extra"], why: "clarify", candidates: ["KY-01", "bogus"] }, ctx());
  assert.strictEqual(r.kind, "ask");
  assert.deepStrictEqual(r.options, ["Yes", "No", "Maybe", "Other"]);
  assert.deepStrictEqual(r.candidates, ["KY-01"]);
  assert.deepStrictEqual(ai.coerceTurn({ action: "ask", question: "Q?", options: ["Only"] }, ctx()).options, ["Only", "Something else"]);
});

test("ask limit: a 4th ask is coerced to the top candidate's answer, or none", () => {
  const raw = { action: "ask", question: "Q?", options: ["A", "B"], candidates: ["KY-02"] };
  const r = ai.coerceTurn(raw, ctx({ asks: 3 }));
  assert.strictEqual(r.kind, "answer"); assert.strictEqual(r.sopId, "KY-02"); assert.strictEqual(r.coerced, true);
  assert.strictEqual(ai.coerceTurn({ ...raw, candidates: [] }, ctx({ asks: 3 })).sopId, "KY-01"); // fallback list
  assert.strictEqual(ai.coerceTurn({ ...raw, candidates: [] }, ctx({ asks: 3, fallbackIds: [] })).kind, "none");
  assert.strictEqual(ai.coerceTurn(raw, ctx({ asks: 2 })).kind, "ask"); // third ask is still allowed
});

test("ask with no question or fewer than two options is not shown", () => {
  assert.strictEqual(ai.coerceTurn({ action: "ask", question: "", options: ["A", "B"] }, ctx()).kind, "answer");
  assert.strictEqual(ai.coerceTurn({ action: "ask", question: "Q?", options: [] }, ctx({ fallbackIds: [] })).kind, "none");
});

test("emergency: never asks or gives generic advice", () => {
  assert.ok(ai.isEmergency("there is smoke in room 214") && ai.isEmergency("guest collapsed in the lobby") && !ai.isEmergency("guest lost key"));
  const c = ctx({ emergency: true, emergencyId: "EM-01" });
  assert.strictEqual(ai.coerceTurn({ action: "ask", question: "Q?", options: ["A", "B"] }, c).sopId, "EM-01");
  assert.strictEqual(ai.coerceTurn({ action: "advise", advice: "Call someone." }, c).sopId, "EM-01");
  assert.strictEqual(ai.coerceTurn({ action: "advise", advice: "Call someone." }, ctx({ emergency: true })).kind, "none");
  assert.strictEqual(ai.coerceTurn({ action: "ask", question: "Q?", options: ["A", "B"], candidates: ["KY-01"] }, ctx({ emergency: true })).sopId, "KY-01");
});

test("advise: confirm is forced when money, safety or policy is involved", () => {
  const a = ai.coerceTurn({ action: "advise", advice: "Listen first, then offer a make-good.", confirm: false }, ctx({ staffText: "guest wants a refund" }));
  assert.strictEqual(a.kind, "advise"); assert.strictEqual(a.confirm, true);
  const b = ai.coerceTurn({ action: "advise", advice: "Offer a quiet seat.", confirm: false }, ctx({ staffText: "guest wants a chair" }));
  assert.strictEqual(b.confirm, false);
  assert.strictEqual(ai.coerceTurn({ action: "advise", advice: "x" }, ctx({ expert: false })).kind, "none");
});

test("unusable replies throw so the server falls back to keywords", () => {
  assert.throws(() => ai.coerceTurn(null, ctx()));
  assert.throws(() => ai.coerceTurn({ action: "dance" }, ctx()));
});

test("system prompt carries the persona, limits and the no-invention rule", () => {
  const p = ai.converseSystem({ hotelName: "Hampton Inn Overland Park", system: "PEP", expert: true });
  for (const needle of ["20+ years", "ONE question", "MUST answer", "never ask", "advise", "Never invent", "SOPs are the authority"]) assert.ok(p.includes(needle) || p.toLowerCase().includes(needle.toLowerCase()), needle);
});

test("AI_MOCK_FILE: array entries are consumed in order; errors and exhaustion throw; plain text still repeats", async () => {
  const f = path.join(os.tmpdir(), "mock-" + process.pid + ".json");
  const prev = process.env.AI_MOCK_FILE, prevEnv = process.env.NODE_ENV;
  process.env.AI_MOCK_FILE = f; delete process.env.NODE_ENV;
  try {
    fs.writeFileSync(f, JSON.stringify(["one", { action: "none" }, { error: "timeout" }]));
    assert.strictEqual(await ai.complete({}, "s", "u"), "one");
    assert.strictEqual(await ai.complete({}, "s", "u"), '{"action":"none"}');
    await assert.rejects(ai.complete({}, "s", "u"), /timeout/);
    await assert.rejects(ai.complete({}, "s", "u"), /no more scripted/);
    fs.writeFileSync(f, '{"sop_id":"A"}');
    assert.strictEqual(await ai.complete({}, "s", "u"), '{"sop_id":"A"}');
    assert.strictEqual(await ai.complete({}, "s", "u"), '{"sop_id":"A"}');
    fs.writeFileSync(f, JSON.stringify([{ action: "answer", sop_id: "KY-01", answer: "Hi" }]));
    const out = await ai.converse({}, { hotelName: "H", turns: [{ role: "staff", text: "lost key" }], candidates: [], catalog: [{ id: "KY-01", title: "Lost key" }], expert: true, asks: 0 });
    assert.strictEqual(out.sop_id, "KY-01");
  } finally {
    fs.rmSync(f, { force: true });
    if (prev === undefined) delete process.env.AI_MOCK_FILE; else process.env.AI_MOCK_FILE = prev;
    if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv;
  }
});
