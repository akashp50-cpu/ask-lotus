// Dashboard maths, kept free of the database so it can be tested with plain rows.
// A "question" here is a conversation (rows sharing a convo_id, or one row on its own), the same unit the Activity
// and Unanswered tabs show, so every number matches what a manager sees there.
const TZ = "America/Chicago"; // the hotels' local day
const RANGES = [7, 30, 90];
const HEX = /^#[0-9A-Fa-f]{6}$/;

// Anything but 7, 30 or 90 falls back to 7.
const parseRange = (v) => (RANGES.includes(Number(v)) && /^\d+$/.test(String(v).trim()) ? Number(v) : 7);

// Upper-case hex for the stored hotel color, or null for "Lotus gold". undefined means the value is not acceptable.
const cleanAccent = (v) => (v === null ? null : typeof v === "string" && HEX.test(v) ? v.toUpperCase() : undefined);

// "YYYY-MM-DD" arithmetic without time zones.
const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
// The last `n` local days ending on `today`, oldest first.
const lastDays = (today, n) => Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));

// Groups question rows (newest or oldest first, any order) into conversations, like groupLog() in app.js.
function groupRows(rows) {
  const m = new Map();
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    const k = r.convo || "r" + r.id;
    if (!m.has(k)) m.set(k, { key: k, rows: [] });
    m.get(k).rows.push(r);
  }
  return [...m.values()].map((g) => {
    const last = g.rows[g.rows.length - 1], ans = [...g.rows].reverse().find((r) => r.sop);
    const esc = g.rows.filter((r) => r.esc_level);
    return {
      key: g.key, id: last.id, uid: last.uid, user_name: last.user_name, day: last.day, when: last.when,
      q: g.rows[0].q, turns: g.rows.length,
      sop: ans ? ans.sop : null,
      by: ans ? ans.matched_by : null,
      fb: g.rows.some((r) => r.fb === "n") ? "n" : (ans && ans.fb) || null,
      dismissed: g.rows.every((r) => r.dismissed),
      escLevel: esc.some((r) => r.esc_level === "urgent") ? "urgent" : esc.length ? "chat" : null,
      escChat: esc.length ? esc[esc.length - 1].esc_chat : null,
      asked: g.rows.some((r) => r.kind === "ask"),
      open: !ans && last.kind === "ask", // still waiting on the staff member's reply: not a gap yet
    };
  });
}
// Answered = an SOP matched and nobody marked it not helpful.
const isAnswered = (g) => !!g.sop && g.fb !== "n";
// Same definition as gaps() in app.js.
const isGap = (g) => ((!g.sop && !g.open) || g.fb === "n") && !g.dismissed;

// rows: the hotel's question rows for the last 90 days. today: the hotel's local date. titles: { sopId: title }.
function summarize(rows, { range = 7, today, titles = {} }) {
  const all = groupRows(rows);
  const days = lastDays(today, range), idx = new Map(days.map((d, i) => [d, i]));
  const series = days.map((day) => ({ day, total: 0, answered: 0, sent: 0 }));
  const inRange = [];
  for (const g of all) {
    if (g.open || !idx.has(g.day)) continue; // a chat still waiting on the staff member isn't a question yet
    inRange.push(g);
    const s = series[idx.get(g.day)];
    s.total++;
    if (isAnswered(g)) s.answered++;
    if (g.escLevel) s.sent++;
  }
  const total = inRange.length, answered = inRange.filter(isAnswered).length;
  const topCount = {};
  for (const g of inRange) if (g.sop) topCount[g.sop] = (topCount[g.sop] || 0) + 1;
  const topics = Object.entries(topCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
    .map(([sop, n]) => ({ sop, title: titles[sop] || sop, n }));
  const recent = all.filter((g) => !g.open).sort((a, b) => b.id - a.id).slice(0, 6).map((g) => ({
    id: g.id, q: g.q, user: g.user_name || "Removed user", sop: g.sop, sopTitle: g.sop ? titles[g.sop] || g.sop : null,
    when: g.when, answered: isAnswered(g), notHelpful: g.fb === "n", escLevel: g.escLevel, escChat: g.escChat,
  }));
  return {
    range, today, days: series,
    kpi: {
      questions: total,
      answered,
      answeredPct: total ? Math.round((answered / total) * 100) : 0,
      waiting: all.filter(isGap).length, // all 90 days loaded, like the Unanswered tab
      sentChat: inRange.filter((g) => g.escLevel === "chat").length,
      sentUrgent: inRange.filter((g) => g.escLevel === "urgent").length,
    },
    rate: {
      byAi: inRange.filter((g) => isAnswered(g) && g.by === "ai").length,
      askedBack: inRange.filter((g) => g.asked).length,
      notCovered: inRange.filter((g) => !g.sop).length,
    },
    topics, recent,
    empty: !all.some((g) => !g.open), // no finished question at all in the last 90 days
  };
}

module.exports = { TZ, RANGES, parseRange, cleanAccent, addDays, lastDays, groupRows, isAnswered, isGap, summarize };
