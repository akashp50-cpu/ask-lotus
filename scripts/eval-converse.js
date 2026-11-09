// Runs realistic front desk conversations through the real converse() + server turn logic (src/turn.js) against hotel 'hop'.
// Usage: DATABASE_URL=... APP_SECRET=... node scripts/eval-converse.js [filter]
// Uses the AI provider saved in Settings. Prints each transcript and pass/fail heuristics. Writes nothing to the database.
const { pool, q } = require("../src/db");
const { decrypt } = require("../src/crypto");
const { forModel } = require("../src/tokens");
const { runTurn } = require("../src/turn");
const ai = require("../src/ai");

const HOTEL = "hop";
// ask: true = the first reply should be a question; false = answered straight away.
// replies: staff replies, in order, to each question (matched by option text when it is one of the options); after:
// extra follow-up messages sent once an answer arrives. expect.ids: acceptable final SOPs. expect.kind: final kind.
const S = [
  { name: "vague: key problem", first: "guest has a key problem", ask: true, replies: ["Still staying", "Checked out"], expect: { ids: ["KY-01", "KY-02", "KY-03"] } },
  { name: "troubleshoot: key will not open door", first: "room 214 key is not working", ask: true, replies: ["Flashes red", "Nothing", "Yes", "Something else"], expect: { ids: ["KY-02", "KY-01", "KY-03"] } },
  { name: "clear: late checkout", first: "Guest wants late checkout until 2pm", ask: false, expect: { ids: ["CO-04"] } },
  { name: "clear: lost key", first: "Guest lost their key and is at the desk", ask: false, expect: { ids: ["KY-01"] } },
  { name: "clear: dog", first: "Can they bring a dog?", ask: false, expect: { ids: [] , any: true } },
  { name: "vague: guest upset", first: "guest is upset", ask: true, replies: ["Something else", "Billing", "Room"], expect: { any: true } },
  { name: "vague: payment", first: "guest payment issue", ask: true, replies: ["Card declined", "Cash", "Something else"], expect: { any: true } },
  { name: "vague: room problem", first: "room is not right", ask: true, replies: ["Dirty", "Something else"], expect: { any: true } },
  { name: "troubleshoot: noise complaint", first: "noise complaint from 305", ask: null, replies: ["Loud party", "Yes", "Something else"], expect: { any: true } },
  { name: "follow-up uses the SOP just shown", first: "Guest wants late checkout until 2pm", ask: false, after: ["what if they say no?"], expect: { ids: ["CO-04"], followSame: true } },
  { name: "follow-up: lost key then ID", first: "Guest lost their key", ask: null, replies: ["Still staying"], after: ["what if they don't have ID?"], expect: { ids: ["KY-01"], followSame: true } },
  { name: "topic change starts fresh", first: "Guest wants late checkout until 2pm", ask: false, after: ["different question, guest lost their key"], expect: { any: true, changedTopic: true } },
  { name: "emergency: smoke", first: "there is smoke coming out of room 305", ask: false, expect: { emergency: true, ids: ["EM-01"] } },
  { name: "emergency: medical", first: "guest collapsed in the lobby and is not responding", ask: false, expect: { emergency: true, ids: ["EM-08"] } },
  { name: "emergency: flood", first: "water is pouring through the ceiling in the hallway", ask: false, expect: { emergency: true, any: true } },
  { name: "uncovered + money: advice with confirm", first: "guest wants us to refund his whole stay because the pool was closed for an hour", ask: null, replies: ["Something else"], expect: { advise: true, confirm: true } },
  { name: "uncovered, no money: advice", first: "a guest wants to know the best way to politely end a long chat at the desk", ask: null, replies: ["Something else"], expect: { advise: true } },
  { name: "uncovered safety: advice with confirm", first: "a guest says someone has been taking photos of the parked cars", ask: null, replies: ["Something else"], expect: { advise: true, confirm: true } },
  { name: "scam call (hotel-only SOP)", first: "FedEx is calling asking me to send money for bitcoin", ask: false, expect: { ids: ["CI-24"] } },
  { name: "not a hotel question", first: "what's the capital of France", ask: null, expect: { notSop: true } },
  // Escalation: urgent (phone a manager) vs the team's WhatsApp chats. expect.esc: { level, chat?, emergency? }.
  { name: "escalate: non-urgent room supply -> housekeeping chat", first: "Guest in 412 wants a rollaway bed and two extra towels tomorrow morning, do we have any left?", ask: null, replies: ["Something else"], expect: { any: true, esc: { level: "chat", chat: "housekeeping" } } },
  { name: "escalate: refund with guest at desk -> urgent", first: "Guest at the desk is demanding a refund for last night right now", ask: null, replies: ["Something else"], expect: { any: true, esc: { level: "urgent" } } },
  { name: "escalate: rate question with a gap -> front desk chat", first: "A guest emailed asking what our corporate rate is for next month. What do I tell them?", ask: null, replies: ["Something else"], expect: { any: true, esc: { level: "chat", chat: "front_desk" } } },
  { name: "escalate: emergency -> urgent with 911", first: "guest in 220 says there is a gas smell in the hallway", ask: false, expect: { emergency: true, ids: ["EM-01", "EM-02", "EM-03", "EM-04", "EM-05", "EM-06", "EM-07", "EM-08"], esc: { level: "urgent", emergency: true } } },
  { name: "ask-limit holds with unhelpful replies", first: "guest problem", ask: true, replies: ["Something else", "Something else", "Something else", "Something else", "Something else"], expect: { any: true, maxAsks: 3 } },
];

const pickReply = (sc, r, i) => {
  const want = (sc.replies || [])[i];
  if (want) { const m = r.options.find((o) => o.toLowerCase() === want.toLowerCase()); return m || r.options[r.options.length - 1]; }
  return r.options[0];
};
const facts = (text) => (String(text).match(/\$\s?\d[\d,.]*|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{1,2}(:\d\d)?\s?(am|pm)\b/gi) || []).map((x) => x.toLowerCase().replace(/\s+/g, ""));

async function main() {
  const filter = (process.argv[2] || "").toLowerCase();
  const s = (await q("SELECT * FROM settings WHERE id=1")).rows[0];
  if (!s.key_enc || s.provider === "none") throw new Error("No AI provider is configured in Settings.");
  const cfg = { provider: s.provider, model: s.model, baseUrl: s.base_url, apiKey: decrypt(s.key_enc) };
  const expert = s.expert_advice !== false;
  const h = (await q("SELECT id, name, system, details FROM hotels WHERE id=$1", [HOTEL])).rows[0];
  const sops = (await q("SELECT * FROM sops WHERE hotel_id=$1 AND status='live'", [HOTEL])).rows;
  const contacts = (await q("SELECT role, name, phone FROM contacts WHERE hotel_id=$1", [HOTEL])).rows;
  const sopText = Object.fromEntries(sops.map((x) => { const m = forModel(x, contacts, h.details); return [x.id, [m.steps.join(" "), m.script, m.flag].join(" ")]; }));
  const allText = Object.values(sopText).join(" ").toLowerCase();
  let pass = 0, fail = 0;

  for (const sc of S) {
    if (filter && !sc.name.toLowerCase().includes(filter)) continue;
    const convo = { turns: [], last_sop: null, asks: 0 };
    const log = [], checks = [];
    const todo = [sc.first, ...(sc.after || [])];
    let msg = sc.first, replies = 0, kinds = [], followIdx = 0, consecAsks = 0, maxAsks = 0, firstKind = null, finals = [], guard = 0;
    while (msg && guard++ < 14) {
      const t0 = Date.now();
      const { result, aiError, turns } = await runTurn({ cfg, hotel: h, sops, contacts, convo, question: msg, expert, fallback: false });
      log.push(`  STAFF: ${msg}`);
      if (aiError) log.push(`  !! AI error: ${aiError}`);
      const k = result.kind; kinds.push(k); if (!firstKind) firstKind = k;
      let bot, next = null;
      if (k === "ask") {
        consecAsks++; maxAsks = Math.max(maxAsks, consecAsks);
        bot = { role: "assistant", kind: k, question: result.question, options: result.options };
        log.push(`  ASK (${result.why}): ${result.question}  [${result.options.join(" | ")}]`);
        next = pickReply(sc, result, replies++);
      } else {
        consecAsks = 0;
        if (k === "answer") {
          bot = { role: "assistant", kind: k, sop_id: result.sopId, answer: result.answer };
          log.push(`  ANSWER ${result.sopId}${result.coerced ? " (forced)" : ""}: ${result.answer || "(SOP only)"}${result.tip ? `\n    TIP: ${result.tip}` : ""}${result.focusSteps.length ? `\n    focus steps: ${result.focusSteps}` : ""}`);
          if (result.escalate) log.push(`    ESCALATE ${result.escalate.level}/${result.escalate.chat}${result.escalate.emergency ? " (911)" : ""}: ${result.escalate.message}`);
          finals.push(result);
        } else if (k === "advise") {
          bot = { role: "assistant", kind: k };
          log.push(`  ADVICE${result.confirm ? " [confirm with a manager]" : ""}: ${result.advice}`);
          if (result.escalate) log.push(`    ESCALATE ${result.escalate.level}/${result.escalate.chat}${result.escalate.emergency ? " (911)" : ""}: ${result.escalate.message}`);
          finals.push(result);
        } else { bot = { role: "assistant", kind: k }; log.push("  NONE (not covered card)"); finals.push(result); }
        if (followIdx < (sc.after || []).length) next = sc.after[followIdx++];
      }
      convo.turns = [...turns, bot];
      convo.asks = k === "ask" ? convo.asks + 1 : 0;
      if (k === "answer") convo.last_sop = result.sopId;
      msg = next;
      log.push(`    (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
    const convoText = convo.turns.filter((t) => t.role === "staff").map((t) => t.text).join(" ");
    const fin = finals[sc.after && sc.after.length && sc.expect.followSame ? 0 : finals.length - 1] || {};
    const last = finals[finals.length - 1] || {};
    const chk = (cond, label) => checks.push([!!cond, label]);
    if (sc.ask === true) chk(firstKind === "ask", "asked back when vague");
    if (sc.ask === false) chk(firstKind !== "ask", "did not ask when the question was clear");
    chk(maxAsks <= 3, `at most 3 asks in a row (max ${maxAsks})`);
    chk(!kinds.includes("ask") || kinds.at(-1) !== "ask", "ended with an answer, advice or not-covered");
    const e = sc.expect || {};
    if (e.emergency) { chk(!kinds.includes("ask") && !kinds.includes("advise"), "emergency: no question, no generic advice"); chk(finals[0] && finals[0].kind === "answer", "emergency: answered from an SOP"); }
    if (e.ids && e.ids.length) chk(finals.some((f) => f.kind === "answer" && e.ids.includes(f.sopId)), `answered from one of ${e.ids.join("/")}`);
    if (e.any) chk(finals.length > 0, "reached a final response");
    if (e.followSame) chk(finals.length >= 2 && finals[1].kind === "answer" && finals[1].sopId === finals[0].sopId, "follow-up answered from the same SOP");
    if (e.changedTopic) chk(finals.length >= 2 && finals[1].kind === "answer" && finals[1].sopId !== finals[0].sopId, "new topic switched SOP");
    if (e.advise) chk(finals.some((f) => f.kind === "advise"), "labeled expert advice (no SOP fit)");
    if (e.confirm) chk(finals.some((f) => f.kind === "advise" && f.confirm), "advice requires confirming with a manager");
    if (e.notSop) chk(finals.every((f) => f.kind !== "answer"), "no SOP forced onto an unrelated question");
    if (e.esc) {
      const fe = finals.map((f) => f.escalate).filter(Boolean).pop();
      chk(fe, "an escalate was returned");
      if (fe) {
        chk(fe.level === e.esc.level, `escalate level is ${e.esc.level} (got ${fe.level})`);
        if (e.esc.chat) chk(fe.chat === e.esc.chat, `escalate chat is ${e.esc.chat} (got ${fe.chat})`);
        if (e.esc.emergency) chk(fe.emergency === true, "escalate flags the emergency (911 first)");
      }
    }
    for (const f of finals) {
      if (f.escalate) {
        const m = f.escalate.message, said = convoText;
        chk(m && m.split(/(?<=[.?!])\s+/).length <= 3, "escalate message is 1 to 3 sentences");
        chk(!/\p{Extended_Pictographic}/u.test(m), "escalate message has no emoji");
        const badNums = (m.match(/\b\d{2,4}\b/g) || []).filter((n) => !said.includes(n));
        chk(!badNums.length, `escalate message invents no room numbers${badNums.length ? " (" + badNums.join(", ") + ")" : ""}`);
      }
      if (f.kind === "answer") {
        chk(!f.tip || f.tip.split(/[.!?]\s/).length <= 2, "tip is a single short line");
        const src = (sopText[f.sopId] || "").toLowerCase().replace(/\s+/g, "");
        const bad = facts(`${f.answer || ""} ${f.tip || ""}`).filter((x) => !src.includes(x) && !allText.replace(/\s+/g, "").includes(x));
        chk(!bad.length, `no invented prices, phones or times in the answer${bad.length ? " (" + bad.join(", ") + ")" : ""}`);
        chk(!/\b(i think|you may want to|maybe|perhaps|i believe)\b/i.test(`${f.answer} ${f.tip}`), "no hedging language");
      }
      if (f.kind === "advise") {
        const bad = facts(f.advice);
        chk(!bad.length, `advice states no property-specific prices, phones or times${bad.length ? " (" + bad.join(", ") + ")" : ""}`);
        chk(!/\b(i think|you may want to|maybe|perhaps)\b/i.test(f.advice), "no hedging language");
      }
    }
    const okAll = checks.every((c) => c[0]);
    okAll ? pass++ : fail++;
    console.log(`\n=== ${okAll ? "PASS" : "FAIL"}: ${sc.name}`);
    console.log(log.join("\n"));
    for (const [c, l] of checks) console.log(`   ${c ? "ok  " : "FAIL"} ${l}`);
  }
  console.log(`\n${pass} scenarios passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
