// Provider-agnostic AI layer. The model only picks which SOP answers the question
// (and, if "answer only from SOPs" is off, may give a short general answer).
// Staff always see the SOP text exactly as managers wrote it.

const PROVIDERS = {
  anthropic: { name: "Anthropic", defaultModel: "claude-sonnet-5-5" },
  openai: { name: "OpenAI", defaultModel: "" },
  google: { name: "Google", defaultModel: "" },
  azure: { name: "Microsoft Azure OpenAI", defaultModel: "", needsUrl: true },
  custom: { name: "Other (OpenAI-compatible)", defaultModel: "", needsUrl: true },
};

const TIMEOUT_MS = 15000;
const fs = require("fs");

// Test hook: with AI_MOCK_FILE set (never in production) complete() returns that file's text instead of calling a provider.
const mockFile = () => (process.env.NODE_ENV !== "production" && process.env.AI_MOCK_FILE) || "";
const mockEnabled = () => !!mockFile();
// The file may hold a JSON array: its entries (strings, or {"error": "msg"} to simulate a provider failure) are
// returned one per call, in order, and the list starts over whenever the file's content changes. Past the end it fails.
const mockState = { content: null, i: 0 };
function mockNext() {
  const content = fs.readFileSync(mockFile(), "utf8");
  if (mockState.content !== content) { mockState.content = content; mockState.i = 0; }
  let arr = null;
  if (content.trim().startsWith("[")) { try { const a = JSON.parse(content); if (Array.isArray(a)) arr = a; } catch { /* plain text */ } }
  if (!arr) return content;
  if (mockState.i >= arr.length) throw new Error("mock AI: no more scripted responses");
  const v = arr[mockState.i++];
  if (v && typeof v === "object" && v.error) throw new Error(String(v.error));
  return typeof v === "string" ? v : JSON.stringify(v);
}

async function post(url, headers, body, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(`${r.status} from provider: ${text.slice(0, 300)}`);
      err.status = r.status;
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

// Send one system + user message, get text back. opts: { maxTokens (default 400), timeoutMs (default 15s) }.
async function complete(cfg, system, user, opts = {}) {
  if (mockEnabled()) return mockNext();
  const { provider, model, baseUrl, apiKey } = cfg;
  const maxTokens = opts.maxTokens || 400, timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  if (provider === "anthropic") {
    const j = await post(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      { model: model || PROVIDERS.anthropic.defaultModel, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] },
      timeoutMs
    );
    return (j.content || []).map((c) => c.text || "").join("");
  }
  if (provider === "google") {
    if (!model) throw new Error("Enter a Gemini model name in Settings");
    const j = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { "x-goog-api-key": apiKey },
      { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], ...(opts.maxTokens ? { generationConfig: { maxOutputTokens: maxTokens } } : {}) },
      timeoutMs
    );
    return j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  }
  // OpenAI, Azure OpenAI and OpenAI-compatible endpoints share the chat completions shape.
  let url = "https://api.openai.com/v1/chat/completions";
  let headers = { authorization: `Bearer ${apiKey}` };
  if (provider === "azure") {
    if (!baseUrl) throw new Error("Enter your Azure chat completions URL in Settings");
    url = baseUrl;
    headers = { "api-key": apiKey };
  } else if (provider === "custom") {
    if (!baseUrl) throw new Error("Enter the endpoint base URL in Settings");
    url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  }
  if (provider !== "azure" && !model) throw new Error("Enter a model name in Settings");
  const body = { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens };
  if (model) body.model = model;
  const j = await post(url, headers, body, timeoutMs);
  return j.choices?.[0]?.message?.content || "";
}

function parseJSON(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

// candidates: [{id,title,category,steps:[{t}]}]; catalog: every live SOP id + title
async function pickSop(cfg, question, candidates, catalog, { sourceOnly, hotelName }) {
  const system = [
    `You route front desk questions at ${hotelName || "a hotel"} to the hotel's standard operating procedures (SOPs).`,
    "Pick the ONE SOP that best answers the staff member's question. Use only the SOP ids given.",
    'Reply with JSON only: {"sop_id": "XX-00"} or {"sop_id": null} if none fits.',
    sourceOnly
      ? "Never answer from your own knowledge."
      : 'If no SOP fits, you may add "general": "<one or two short sentences of general hotel guidance>". Never invent property rules, prices or phone numbers.',
  ].join(" ");
  const detail = candidates
    .map((s) => `${s.id} | ${s.category} | ${s.title}\n  ${s.steps.slice(0, 3).map((x) => x.t).join(" / ")}`)
    .join("\n");
  const all = catalog.map((s) => `${s.id} ${s.title}`).join("\n");
  const user = `Staff question: """${question}"""\n\nMost likely SOPs:\n${detail || "(none matched by keyword)"}\n\nAll SOP titles:\n${all}`;
  const out = parseJSON(await complete(cfg, system, user)) || {};
  const ids = new Set(catalog.map((s) => s.id));
  return {
    sopId: out.sop_id && ids.has(out.sop_id) ? out.sop_id : null,
    general: !sourceOnly && typeof out.general === "string" ? out.general.slice(0, 500) : null,
  };
}

// Write a short, direct answer to the staff member's exact question, using only the
// matched SOP (already token-resolved, [CHECK] notes removed). Returns null if the
// SOP doesn't speak to it.
async function answerFromSop(cfg, question, sop) {
  const system = [
    "You help hotel front desk staff. Answer the staff member's question using ONLY the SOP provided.",
    "Write 1 to 3 short, plain sentences: the direct answer first, then the key action. No preamble, no headings, no markdown.",
    "Use the exact names, phone numbers, amounts and times in the SOP. Never invent a price, policy, time, room number or phone number.",
    'Where the SOP says "ask a manager", tell them to ask a manager for that detail.',
    "If the SOP does not answer this specific question, reply with exactly: NONE",
  ].join(" ");
  const body = [
    `SOP ${sop.id}: ${sop.title} (${sop.category})`,
    "Steps:",
    ...sop.steps.map((t, i) => `${i + 1}. ${t}`),
    sop.script ? `What to say to the guest: ${sop.script}` : "",
    sop.flag ? `Call a manager if: ${sop.flag}` : "",
  ].filter(Boolean).join("\n");
  const text = String(await complete(cfg, system, `${body}\n\nStaff question: """${question}"""`)).trim();
  if (!text || /^none\.?$/i.test(text)) return null;
  return text.slice(0, 600);
}

async function testConnection(cfg) {
  const t0 = Date.now();
  const text = await complete(cfg, "Reply with the single word OK.", "Connection test");
  return { ms: Date.now() - t0, reply: String(text).trim().slice(0, 40) };
}

// ---------- conversational turn ----------
const MAX_ASKS = 3;
const EMERGENCY_RE = /\b(fire|smoke|smoking|burning|medical|ambulance|911|unconscious|passed out|collapsed|bleeding|blood|injur\w*|hurt|heart attack|seizure|stroke|overdos\w*|not breathing|can'?t breathe|choking|drown\w*|gun|weapon|knife|shots?|shooting|stabb\w*|assault\w*|attack\w*|violen\w*|threaten\w*|gas leak|smell gas|smells? like gas|carbon monoxide|flood\w*|water pouring|burst pipe|suicid\w*)\b/i;
const isEmergency = (text) => EMERGENCY_RE.test(String(text || ""));
// Money, safety, security, legal/ID or policy: expert advice must be confirmed with a manager.
const CONFIRM_RE = /\b(refund\w*|comp|comps|comped|compensat\w*|discount\w*|rebate|waive\w*|charge\w*|fee|fees|price|rate|rates|money|cash|payment|pay|paid|deposit|credit card|chargeback|dispute\w*|lawsuit|legal|lawyer|police|safety|unsafe|security|theft|stolen|id|identification|passport|license|policy|policies|injur\w*|medical|fire|weapon|threat\w*|harass\w*|discriminat\w*|bed ?bugs?|insurance|liabilit\w*)\b/i;
const needsConfirm = (text) => CONFIRM_RE.test(String(text || ""));

const clip = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

// Turns the model's parsed JSON into one safe result, applying the rules the server enforces whatever the model says.
// ctx: { valid:Set<sopId>, stepCount:{id:n}, asks:int (asks since the last answer), expert:bool, emergency:bool,
//        emergencyId:string|null, fallbackIds:[ids best first], staffText:string }
function coerceTurn(raw, ctx) {
  if (!raw || typeof raw !== "object") throw new Error("The AI reply wasn't understood");
  const valid = (id) => (typeof id === "string" && ctx.valid.has(id.trim().toUpperCase()) ? id.trim().toUpperCase() : null);
  const action = String(raw.action || "").toLowerCase();
  const cands = (Array.isArray(raw.candidates) ? raw.candidates : []).map(valid).filter(Boolean);
  const toAnswer = (id, extra = {}) => {
    const n = ctx.stepCount[id] || 0;
    const focus = [...new Set((Array.isArray(extra.focus_steps) ? extra.focus_steps : []).map(Number).filter((k) => Number.isInteger(k) && k >= 1 && k <= n))].sort((a, b) => a - b).slice(0, 6);
    return { kind: "answer", sopId: id, answer: clip(extra.answer, 600) || null, tip: clip(extra.tip, 220) || null, focusSteps: focus.length && focus.length < n ? focus : [], coerced: !!extra.coerced };
  };
  const advise = () => {
    const advice = ctx.expert && !ctx.emergency ? clip(raw.advice, 700) : "";
    if (!advice) return { kind: "none" };
    return { kind: "advise", advice, confirm: raw.confirm === true || needsConfirm(ctx.staffText) || needsConfirm(advice) };
  };
  if (ctx.emergency && action !== "answer") {
    const id = ctx.emergencyId && valid(ctx.emergencyId) || cands[0] || null;
    return id ? toAnswer(id, { coerced: true }) : { kind: "none" };
  }
  if (action === "answer") {
    const id = valid(raw.sop_id);
    return id ? toAnswer(id, raw) : advise();
  }
  if (action === "ask") {
    const question = clip(raw.question, 200);
    let options = [...new Set((Array.isArray(raw.options) ? raw.options : []).map((o) => clip(String(o ?? ""), 40)).filter(Boolean))].slice(0, 4);
    if (options.length === 1) options.push("Something else");
    if (!question || options.length < 2 || ctx.asks >= MAX_ASKS) {
      const id = cands[0] || (ctx.fallbackIds || [])[0] || null;
      return id ? toAnswer(id, { coerced: true }) : { kind: "none" };
    }
    return { kind: "ask", question, options, why: raw.why === "troubleshoot" ? "troubleshoot" : "clarify", candidates: cands };
  }
  if (action === "advise") return advise();
  if (action === "none") return { kind: "none" };
  throw new Error("The AI reply wasn't understood");
}

function looseParse(text) {
  const s = String(text || "").replace(/[\u201C\u201D]/g, '"').replace(/```(?:json)?/gi, "");
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  for (const t of [m[0], m[0].replace(/,\s*([}\]])/g, "$1")]) { try { return JSON.parse(t); } catch { /* next */ } }
  return null;
}

function converseSystem({ hotelName, system, expert }) {
  return [
    `You are the voice of Ask Lotus at ${hotelName || "this hotel"}: a seasoned master hotel operator with 20+ years running select-service and full-service hotels, from the front desk to general manager. You know PMS work, guest recovery, safety and revenue basics. You are coaching a front desk agent in the middle of a shift.`,
    system ? `Front desk system: ${system}.` : "",
    "VOICE: Confident and direct. Lead with the action. No hedging (no \"I think\", \"you may want to\", \"maybe\", \"perhaps\"). Plain words a front desk agent can follow mid-shift. 1 to 3 short sentences.",
    "AUTHORITY: The hotel's SOPs are the authority. Answer from them and never contradict them. Use the exact names, phone numbers, amounts and times in the SOP. Never invent a procedure, price, fee, policy, time, room number or phone number. Where the SOP says \"ask a manager\", tell them to ask a manager.",
    "You see a conversation between a staff member and the assistant, a shortlist of SOPs with full text, the SOP shown last turn (if any), and a list of all SOP titles. Reply with ONE JSON object and nothing else, in one of these shapes:",
    '{"action":"answer","sop_id":"XX-00","answer":"1-3 plain sentences answering THIS conversation from the SOP","tip":"optional","focus_steps":[step numbers, optional]}',
    '{"action":"ask","question":"one short question","options":["2-4 short answers"],"why":"clarify" or "troubleshoot","candidates":["sop ids you are considering"]}',
    expert
      ? '{"action":"advise","advice":"2-4 short sentences of practical operator guidance","confirm":true or false}'
      : '{"action":"none"}',
    expert ? '{"action":"none"} is only for a message that is not a hotel question at all.' : "",
    "WHEN TO ASK: If the question is vague, or it describes a problem and the SOP has branches that change what the agent should do (still staying or checked out, card or cash, lock flashes red or shows nothing, which of two SOPs applies), ask ONE question back, like a manager would, before answering. Questions must come from the SOP text provided (a choice between candidate SOPs, or which branch of an SOP applies). Ask at most ONE question per turn. Never ask something the conversation already answered. Do not ask when you can answer well already.",
    `OPTIONS: 2 to 4 options, each 5 words or fewer, mutually exclusive, written as the staff member would say them. You may include "Something else".`,
    `LIMITS: After ${MAX_ASKS} questions in a row you MUST answer with the best SOP. For an emergency (fire, medical, violence, gas, flood, someone hurt) never ask: answer immediately with the emergency SOP. A clear question gets an answer right away.`,
    "FOLLOW-UPS: After an answer, a follow-up (for example \"what if they say no?\") is answered from the same SOP unless the staff member clearly changed topic; if the topic is clearly new, ignore the earlier turns and treat it as a fresh question.",
    "ANSWER TEXT: Address what the staff member actually described, for example \"Since the lock flashes red, the key needs re-encoding: ...\". focus_steps lists the step numbers of the SOP most relevant to this conversation (leave it out if all apply).",
    'TIP: In an answer you may add "tip": ONE short line of practical operator advice (how to phrase something to an upset guest, what to note in the log). It adds to the SOP and never contradicts or replaces it, and contains no prices, policies, phone numbers or procedures that are not in the SOP. Leave it out when there is nothing useful.',
    expert
      ? 'NO SOP FITS: Use "advise": 2 to 4 short sentences of general best practice from your experience. Never state property-specific facts (fees, hours, phone numbers, room numbers, names) that are not in the SOPs. Set "confirm": true whenever money, refunds or comps, safety, security, legal or ID, or policy is involved. Never use advise for an emergency.'
      : "NO SOP FITS: reply with the none action. Never answer from your own knowledge.",
  ].filter(Boolean).join("\n");
}

function sopBlock(s) {
  return [
    `SOP ${s.id}: ${s.title} (${s.category})`,
    ...s.steps.map((t, i) => `  ${i + 1}. ${t}`),
    s.script ? `  Say to the guest: ${s.script}` : "",
    s.flag ? `  Call a manager if: ${s.flag}` : "",
  ].filter(Boolean).join("\n");
}

// turns: [{role:"staff",text} | {role:"assistant",kind:"ask",question,options} | {role:"assistant",kind:"answer",sop_id,answer} | {role:"assistant",kind:"advise"|"none"}]
// candidates / lastSop: SOPs already resolved with tokens.forModel. Returns the parsed (uncoerced) JSON object.
async function converse(cfg, { hotelName, system, turns, candidates, catalog, lastSop, expert, asks }) {
  const sys = converseSystem({ hotelName, system, expert: expert !== false });
  const convo = turns.slice(-16).map((t) => {
    if (t.role === "staff") return `STAFF: ${t.text}`;
    if (t.kind === "ask") return `ASSISTANT asked: ${t.question} [options: ${(t.options || []).join(" | ")}]`;
    if (t.kind === "answer") return `ASSISTANT answered from ${t.sop_id}: ${t.answer || "(showed the SOP)"}`;
    if (t.kind === "advise") return "ASSISTANT gave general guidance (no SOP fit)";
    return "ASSISTANT: no SOP fit";
  }).join("\n");
  const shown = lastSop ? `\nSOP shown last turn (the conversation is probably still about it):\n${sopBlock(lastSop)}\n` : "";
  const cand = candidates.filter((c) => !lastSop || c.id !== lastSop.id);
  const user = [
    `Conversation so far (the last STAFF line is the newest message). Questions already asked since the last answer: ${asks || 0} of ${MAX_ASKS}.`,
    convo, shown,
    "Shortlist of SOPs (full text):", cand.map(sopBlock).join("\n\n") || "(none matched by keyword)",
    "\nAll SOP titles:", catalog.map((s) => `${s.id} ${s.title}`).join("\n"),
  ].join("\n");
  const text = await complete(cfg, sys, user, { maxTokens: 700 });
  const out = looseParse(text);
  if (!out) throw new Error("The AI reply wasn't understood");
  return out;
}

module.exports = { PROVIDERS, pickSop, answerFromSop, testConnection, complete, mockEnabled, converse, converseSystem, coerceTurn, looseParse, isEmergency, needsConfirm, MAX_ASKS };
