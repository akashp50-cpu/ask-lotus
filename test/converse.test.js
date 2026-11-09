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
  assert.deepStrictEqual(r, { kind: "answer", sopId: "KY-01", answer: "Re-encode the key.", tip: "Stay calm.", focusSteps: [2, 3], coerced: false, escalate: null });
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
  assert.ok(ai.isEmergency("there is smoke in room 214") && ai.isEmergency("guest says there is a gas smell in the hallway") && ai.isEmergency("guest collapsed in the lobby") && !ai.isEmergency("guest lost key"));
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

// ---------- escalation (urgent call vs team chat) ----------
const ans = (extra = {}) => ({ action: "answer", sop_id: "KY-01", answer: "Re-encode the key.", ...extra });

test("escalate: a valid object is kept, cleaned and capped", () => {
  const r = ai.coerceTurn(ans({ escalate: { level: "CHAT", chat: "Housekeeping", message: "  Room 214 needs two\n extra towels \u{1F600}. Can someone bring them?  " } }), ctx());
  assert.deepStrictEqual(r.escalate, { level: "chat", chat: "housekeeping", message: "Room 214 needs two extra towels . Can someone bring them?", why: null, emergency: false });
  assert.strictEqual(ai.coerceTurn(ans({ escalate: { level: "chat", chat: "front_desk", message: "x".repeat(900) } }), ctx()).escalate.message.length, 400);
  assert.ok(!/CHECK/.test(ai.coerceTurn(ans({ escalate: { level: "chat", chat: "front_desk", message: "Rate? [CHECK: confirm] please" } }), ctx()).escalate.message));
});

test("escalate: unknown chat defaults to front_desk, empty message gets the template, urgent keeps its reason", () => {
  const r = ai.coerceTurn(ans({ escalate: { level: "chat", chat: "maintenance", message: "" } }), ctx({ staffText: "room 305 asks about the rate" }));
  assert.strictEqual(r.escalate.chat, "front_desk");
  assert.strictEqual(r.escalate.message, "Room 305: asks about the rate. Can a manager confirm?");
  const u = ai.coerceTurn(ans({ escalate: { level: "urgent", chat: "front_desk", message: "Guest upset at the desk." } }), ctx());
  assert.strictEqual(u.escalate.level, "urgent"); assert.strictEqual(u.escalate.why, "ai"); assert.strictEqual(u.escalate.emergency, false);
});

test("escalate: malformed objects are dropped on answers, rebuilt on advice", () => {
  for (const bad of ["urgent", 5, [], { level: "asap", chat: "front_desk", message: "m" }, { chat: "front_desk", message: "m" }, null]) {
    assert.strictEqual(ai.coerceTurn(ans({ escalate: bad }), ctx()).escalate, null, JSON.stringify(bad));
  }
  assert.strictEqual(ai.coerceTurn(ans(), ctx()).escalate, null); // none sent, none required
  // advice always carries one: a bad or missing object becomes a chat template
  const a = ai.coerceTurn({ action: "advise", advice: "Offer a quiet seat.", escalate: { level: "bogus" } }, ctx({ staffText: "guest wants a chair" }));
  assert.deepStrictEqual([a.escalate.level, a.escalate.chat, a.escalate.message], ["chat", "front_desk", "[Room #]: guest wants a chair. Can a manager confirm?"]);
  assert.strictEqual(ai.coerceTurn({ action: "advise", advice: "Offer a quiet seat." }, ctx()).escalate.level, "chat");
});

test("escalate: emergencies are always urgent with the 911 flag, never chat", () => {
  const c = ctx({ emergency: true, emergencyId: "EM-01", staffText: "smoke in room 305" });
  const r = ai.coerceTurn(ans({ sop_id: "EM-01", escalate: { level: "chat", chat: "housekeeping", message: "Smoke in 305" } }), c);
  assert.strictEqual(r.escalate.level, "urgent"); assert.strictEqual(r.escalate.emergency, true); assert.strictEqual(r.escalate.why, "emergency");
  // an emergency answer the model sent no escalate for still gets one; a forced answer too
  assert.strictEqual(ai.coerceTurn(ans({ sop_id: "EM-01" }), c).escalate.level, "urgent");
  assert.strictEqual(ai.coerceTurn({ action: "ask", question: "Q?", options: ["A", "B"] }, c).escalate.emergency, true);
});

test("escalate: refunds and money with a guest at the desk stay chat; safety words and injuries are urgent", () => {
  const chat = { level: "chat", chat: "front_desk", message: "Guest wants a refund." };
  const run = (t, e = chat) => ai.coerceTurn({ action: "advise", advice: "Listen first.", escalate: e }, ctx({ staffText: t })).escalate;
  for (const t of ["guest at the desk wants a refund", "guest is on the phone right now disputing a charge", "guest waiting wants a comp and a discount", "guest at the counter wants late checkout"]) assert.strictEqual(run(t).level, "chat", t);
  assert.strictEqual(run("guest at the desk wants a refund").why, null);
  const w = run("guest pulled a weapon at the desk"); assert.deepStrictEqual([w.level, w.emergency], ["urgent", true]);
  const i = run("guest slipped and is injured in the lobby"); assert.deepStrictEqual([i.level, i.emergency], ["urgent", true]);
  const t = run("a guest is making a threat to staff"); assert.deepStrictEqual([t.level, t.why, t.emergency], ["urgent", "safety", false]);
  for (const x of ["guest is becoming aggressive", "abusive guest at the desk", "someone is harassing a guest", "theft in progress", "need to call the police"]) assert.strictEqual(run(x).level, "urgent", x);
  assert.ok(ai.guestPresent("guest is on the phone right now") && !ai.guestPresent("guest called yesterday"));
});

test("response minutes: default 5, rounded, clamped to 1-60", () => {
  assert.deepStrictEqual([undefined, null, "", "abc", 5].map(ai.responseMinutes), [5, 5, 5, 5, 5]);
  assert.deepStrictEqual([0, -3, 1, 10, "15", 60, 75, 7.6].map(ai.responseMinutes), [1, 1, 1, 10, 15, 60, 60, 8]);
});

test("fallback escalate: generic chat instruction with a template; housekeeping topics; emergency is urgent", () => {
  const f = ai.fallbackEscalate({ staffText: "can the guest keep the room rate" });
  assert.deepStrictEqual([f.level, f.chat, f.generic], ["chat", "front_desk", true]);
  assert.strictEqual(f.message, "[Room #]: can the guest keep the room rate. Can a manager confirm?");
  for (const t of ["need extra towels in 214", "room is dirty", "guest left a phone behind, lost and found", "out of shampoo and soap", "which linens go on a rollaway", "AC maintenance in the room"]) assert.strictEqual(ai.fallbackEscalate({ staffText: t }).chat, "housekeeping", t);
  for (const t of ["guest wants late checkout", "PEP is slow", "how do I split a payment"]) assert.strictEqual(ai.fallbackEscalate({ staffText: t }).chat, "front_desk", t);
  assert.strictEqual(ai.fallbackEscalate({ staffText: "x", topicText: "Housekeeping supplies" }).chat, "housekeeping"); // matched SOP's topic
  const e = ai.fallbackEscalate({ staffText: "smoke on the third floor" });
  assert.deepStrictEqual([e.level, e.emergency], ["urgent", true]);
  assert.strictEqual(ai.fallbackEscalate({ staffText: "guest at the desk disputes a charge" }).level, "chat");
  assert.strictEqual(ai.fallbackEscalate({ staffText: "guest is threatening staff" }).level, "urgent");
  assert.strictEqual(ai.templateMessage("room 214 key is not working"), "Room 214: key is not working. Can a manager confirm?");
});

test("system prompt carries the escalate rules", () => {
  const p = ai.converseSystem({ hotelName: "H", system: "PEP", expert: true });
  for (const needle of ['"escalate"', "urgent", "housekeeping", "front_desk", "EVERY advise", "never invent", "no emojis", "[room #]", "never \"chat\""]) assert.ok(p.toLowerCase().includes(needle.toLowerCase()), needle);
  assert.ok(ai.converseSystem({ expert: false }).includes("ESCALATE"));
  assert.ok(p.includes("within about 5 minutes, so prefer \"chat\""));
  assert.ok(ai.converseSystem({ expert: true, minutes: 12 }).includes("within about 12 minutes") && ai.converseSystem({ expert: true, minutes: 999 }).includes("within about 60 minutes"));
  assert.ok(/refunds, comps, discounts, disputes, a guest waiting at the desk/.test(p));
});
