// One conversational turn, shared by the /api/ask route and scripts/eval-converse.js.
const { best, rank } = require("./match");
const { forModel } = require("./tokens");
const ai = require("./ai");

// convo: { turns:[...prior turns], last_sop, asks }; hotel: { name, system, details }.
// Returns { result, by, aiError, turns } where turns already includes the new staff message.
async function runTurn({ cfg, hotel, sops, contacts, convo, question, expert, fallback }) {
  const turns = [...(convo.turns || []), { role: "staff", text: question }];
  const allStaff = turns.filter((t) => t.role === "staff").map((t) => t.text).join(". ");
  const byId = new Map(sops.map((x) => [x.id, x]));
  const keywordResult = (text) => {
    const k = best(text, sops);
    return k ? { kind: "answer", sopId: k.id, answer: null, tip: null, focusSteps: [] } : null;
  };
  let result = { kind: "none" }, by = "none", aiError = null;
  if (!cfg) {
    const k = keywordResult(question);
    if (k) { result = k; by = "keyword"; }
    return { result, by, aiError, turns };
  }
  try {
    // Shortlist: newest message first, then everything the staff member has said in this conversation.
    const seen = new Set(), short = [];
    for (const r of [...rank(question, sops, 4), ...rank(allStaff, sops, 8)]) {
      if (!seen.has(r.s.id) && short.length < 6) { seen.add(r.s.id); short.push(r); }
    }
    const lastSop = convo.last_sop && byId.get(convo.last_sop) ? forModel(byId.get(convo.last_sop), contacts, hotel.details) : null;
    const emergency = ai.isEmergency(question);
    const raw = await ai.converse(cfg, {
      hotelName: hotel.name,
      system: hotel.system === "pep" ? "PEP (Hilton's name for HotelKey NextGen)" : "HotelKey",
      turns, candidates: short.map((r) => forModel(r.s, contacts, hotel.details)), lastSop, expert,
      catalog: sops.map((x) => ({ id: x.id, title: x.title })), asks: convo.asks || 0,
    });
    const emergencyId = emergency
      ? (rank(question, sops, 1)[0] || {}).s?.id || (sops.find((x) => /emergenc|fire|medical|safety/i.test(x.title + " " + x.category)) || {}).id || null
      : null;
    result = ai.coerceTurn(raw, {
      valid: new Set(sops.map((x) => x.id)),
      stepCount: Object.fromEntries(sops.map((x) => [x.id, forModel(x, contacts, hotel.details).steps.length])),
      asks: convo.asks || 0, expert, emergency, emergencyId,
      fallbackIds: [convo.last_sop, ...short.filter((r) => r.sc >= 2.5).map((r) => r.s.id)].filter((id) => id && byId.has(id)),
      staffText: allStaff,
    });
    by = "ai";
    // A forced answer (question limit or emergency) has no model-written text yet.
    if (result.kind === "answer" && result.coerced && !result.answer) {
      try { result.answer = await ai.answerFromSop(cfg, allStaff, forModel(byId.get(result.sopId), contacts, hotel.details)); } catch (e) { console.error("AI answer error:", e.message); }
    }
  } catch (e) {
    aiError = e.message;
    console.error("AI provider error:", e.message);
    result = { kind: "none" };
    if (fallback) {
      const k = keywordResult(allStaff) || keywordResult(question);
      if (k) { result = k; by = "keyword"; }
    }
  }
  return { result, by, aiError, turns };
}

module.exports = { runTurn };
