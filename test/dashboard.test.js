const test = require("node:test");
const assert = require("node:assert");
const d = require("../src/dashboard");

let n = 0;
// A question row as /api/dashboard loads it. day is the hotel's local date.
const row = (day, o = {}) => ({ id: ++n, uid: 1, user_name: "Pat Lee", q: "late checkout", sop: "HH-13", matched_by: "keyword", convo: null, kind: "answer", esc_level: null, esc_chat: null, fb: null, dismissed: false, when: day + "T15:00:00Z", day, ...o });

test("parseRange accepts 7, 30 and 90 and falls back to 7 for anything else", () => {
  assert.strictEqual(d.parseRange("30"), 30);
  assert.strictEqual(d.parseRange(90), 90);
  for (const bad of [undefined, "", "0", "1", "8", "365", "-7", "abc", "7;drop", ["30", "90"], "30.5"]) assert.strictEqual(d.parseRange(bad), 7, String(bad));
});

test("cleanAccent: strict #RRGGBB, stored upper case, null clears, everything else is rejected", () => {
  assert.strictEqual(d.cleanAccent("#1f3a6e"), "#1F3A6E");
  assert.strictEqual(d.cleanAccent("#8C6A1F"), "#8C6A1F");
  assert.strictEqual(d.cleanAccent(null), null);
  for (const bad of [undefined, "", "1F3A6E", "#1F3A6", "#1F3A6EE", "#GGGGGG", "red", "#1F3A6E ", " #1F3A6E", "#1F3A6E;}", 123, {}, []]) assert.strictEqual(d.cleanAccent(bad), undefined, JSON.stringify(bad));
});

test("lastDays fills every day, across month and year ends", () => {
  assert.deepStrictEqual(d.lastDays("2026-01-02", 4), ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"]);
  assert.strictEqual(d.lastDays("2026-03-01", 30).length, 30);
  assert.strictEqual(d.lastDays("2026-03-01", 30)[28], "2026-02-28");
  assert.strictEqual(d.lastDays("2026-11-09", 90)[0], "2026-08-12");
});

test("summarize: zero-fills days, counts answered, and drops questions outside the range", () => {
  const today = "2026-11-09";
  const rows = [
    row("2026-11-09"), row("2026-11-09"), row("2026-11-09", { sop: null, matched_by: "none" }),
    row("2026-11-07", { fb: "n" }), // marked not helpful: not answered
    row("2026-11-05", { esc_level: "chat", esc_chat: "front_desk" }),
    row("2026-11-01"), // outside 7 days, inside 30
    row("2026-08-20"), // inside 90 only
  ];
  const s = d.summarize(rows, { range: 7, today, titles: { "HH-13": "Late checkout" } });
  assert.strictEqual(s.days.length, 7);
  assert.deepStrictEqual(s.days.map((x) => x.day), ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
  assert.deepStrictEqual(s.days.map((x) => x.total), [0, 0, 1, 0, 1, 0, 3]);
  assert.deepStrictEqual(s.days.map((x) => x.answered), [0, 0, 1, 0, 0, 0, 2]);
  assert.deepStrictEqual(s.days.map((x) => x.sent), [0, 0, 1, 0, 0, 0, 0]);
  assert.strictEqual(s.kpi.questions, 5);
  assert.strictEqual(s.kpi.answered, 3);
  assert.strictEqual(s.kpi.answeredPct, 60);
  assert.strictEqual(s.kpi.sentChat, 1);
  assert.strictEqual(s.kpi.sentUrgent, 0);
  assert.deepStrictEqual(s.topics, [{ sop: "HH-13", title: "Late checkout", n: 4 }]);
  assert.strictEqual(s.empty, false);
  assert.strictEqual(d.summarize(rows, { range: 30, today }).kpi.questions, 6);
  assert.strictEqual(d.summarize(rows, { range: 90, today }).kpi.questions, 7);
  assert.strictEqual(d.summarize(rows, { range: 90, today }).days.length, 90);
});

test("summarize: a conversation counts once; an unfinished ask-back is not a question or a gap", () => {
  const today = "2026-11-09";
  const rows = [
    row("2026-11-09", { convo: "c1", sop: null, kind: "ask" }), row("2026-11-09", { convo: "c1", sop: "KY-01", kind: "answer", matched_by: "ai" }), // asked back, then answered
    row("2026-11-09", { convo: "c2", sop: null, kind: "ask" }), // still waiting on the staff member
    row("2026-11-09", { convo: "c3", sop: null, kind: "none", matched_by: "none", esc_level: "urgent" }),
  ];
  const s = d.summarize(rows, { range: 7, today });
  assert.strictEqual(s.kpi.questions, 2);
  assert.strictEqual(s.kpi.answered, 1);
  assert.strictEqual(s.kpi.sentUrgent, 1);
  assert.strictEqual(s.kpi.waiting, 1); // c3 only, same as gaps() in the manager app
  assert.deepStrictEqual(s.rate, { byAi: 1, askedBack: 1, notCovered: 1 });
});

test("summarize: waiting for an SOP matches gaps(): no SOP or marked not helpful, minus dismissed", () => {
  const rows = [
    row("2026-11-09", { sop: null, kind: "none" }),
    row("2026-11-09", { sop: null, kind: "none", dismissed: true }),
    row("2026-11-08", { fb: "n" }),
    row("2026-11-08", { fb: "y" }),
    row("2026-09-01", { sop: null, kind: "none" }), // older than 7 days still counts: the Unanswered tab has no range
  ];
  assert.strictEqual(d.summarize(rows, { range: 7, today: "2026-11-09" }).kpi.waiting, 3);
});

test("summarize: no questions at all is the empty state, with zeroed numbers and every day present", () => {
  const s = d.summarize([], { range: 30, today: "2026-11-09" });
  assert.strictEqual(s.empty, true);
  assert.strictEqual(s.days.length, 30);
  assert.ok(s.days.every((x) => x.total === 0));
  assert.deepStrictEqual(s.kpi, { questions: 0, answered: 0, answeredPct: 0, waiting: 0, sentChat: 0, sentUrgent: 0 });
  assert.deepStrictEqual(s.topics, []);
  assert.deepStrictEqual(s.recent, []);
});
