// Provider-agnostic AI layer. The model only picks which SOP answers the question
// (and, if "answer only from SOPs" is off, may give a short general answer).
// Staff always see the SOP text exactly as managers wrote it.

const PROVIDERS = {
  anthropic: { name: "Anthropic", defaultModel: "claude-haiku-5-5", defaultWritingModel: "claude-sonnet-5-5" },
  openai: { name: "OpenAI", defaultModel: "" },
  google: { name: "Google", defaultModel: "" },
  azure: { name: "Microsoft Azure OpenAI", defaultModel: "", needsUrl: true },
  custom: { name: "Other (OpenAI-compatible)", defaultModel: "", needsUrl: true },
};

// What a blank model has always meant for Anthropic. Kept apart from the suggested default so saved setups behave the same.
const LEGACY_ANTHROPIC_MODEL = "claude-sonnet-5-5";
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

// Photos can ride along with the user message: opts.images = [{ id, mime, b64, caption }], at most MAX_IMAGES per call.
// Each photo is introduced with a text line naming its id (and the manager's caption), so the model can refer to it.
const MAX_IMAGES = 6;
const IMG_MIME = /^image\/(jpeg|png|webp|gif)$/;
const photoLabel = (im) => `Photo ${im.id}${im.caption ? ` (caption: ${String(im.caption).slice(0, 200)})` : ""}:`;
function cleanImages(list) {
  return (Array.isArray(list) ? list : []).filter((im) => im && im.id && im.b64 && IMG_MIME.test(im.mime || "")).slice(0, MAX_IMAGES);
}
// The user message as provider-specific content parts. No images: the plain string (or a single text part for Gemini).
const contentParts = {
  anthropic: (user, imgs) => [{ type: "text", text: user }, ...imgs.flatMap((im) => [{ type: "text", text: photoLabel(im) }, { type: "image", source: { type: "base64", media_type: im.mime, data: im.b64 } }])],
  openai: (user, imgs) => [{ type: "text", text: user }, ...imgs.flatMap((im) => [{ type: "text", text: photoLabel(im) }, { type: "image_url", image_url: { url: `data:${im.mime};base64,${im.b64}` } }])],
  google: (user, imgs) => [{ text: user }, ...imgs.flatMap((im) => [{ text: photoLabel(im) }, { inline_data: { mime_type: im.mime, data: im.b64 } }])],
};

// Builds the provider request without sending it (so it can be unit-tested). read(json) pulls the text out of the reply.
function buildRequest(cfg, system, user, opts = {}) {
  const { provider, model, baseUrl, apiKey } = cfg;
  // Newer models spend part of max_tokens on internal reasoning before the visible reply, so a tight cap cuts the
  // JSON off mid-answer. Keep a generous floor: billing is per token actually used, not per cap.
  const maxTokens = Math.max(opts.maxTokens || 400, MIN_OUTPUT_TOKENS);
  const imgs = cleanImages(opts.images);
  if (provider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: { model: model || LEGACY_ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: imgs.length ? contentParts.anthropic(user, imgs) : user }] },
      read: (j) => (j.content || []).map((c) => c.text || "").join(""),
    };
  }
  if (provider === "google") {
    if (!model) throw new Error("Enter a Gemini model name in Settings");
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: { "x-goog-api-key": apiKey },
      body: { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: imgs.length ? contentParts.google(user, imgs) : [{ text: user }] }], ...(opts.maxTokens ? { generationConfig: { maxOutputTokens: maxTokens } } : {}) },
      read: (j) => j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "",
    };
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
  const body = { messages: [{ role: "system", content: system }, { role: "user", content: imgs.length ? contentParts.openai(user, imgs) : user }], max_tokens: maxTokens };
  if (model) body.model = model;
  return { url, headers, body, read: (j) => j.choices?.[0]?.message?.content || "" };
}

// Send one system + user message (optionally with photos), get text back. opts: { maxTokens (default 400), timeoutMs (default 15s), images }.
const MIN_OUTPUT_TOKENS = 4000;

async function complete(cfg, system, user, opts = {}) {
  // Test hook only: "@img:N" in a scripted reply becomes the Nth "[img:ID]" of the prompt (ids from a PDF are made at request time).
  if (mockEnabled()) { const ids = [...String(user).matchAll(/\[img:([0-9a-f-]{36})\]/g)].map((m) => m[1]); return mockNext().replace(/@img:(\d+)/g, (m, n) => ids[+n - 1] || ""); }
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const req = buildRequest(cfg, system, user, opts);
  return req.read(await post(req.url, req.headers, req.body, timeoutMs));
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
const EMERGENCY_RE = /\b(fire|smoke|smoking|burning|medical|ambulance|911|unconscious|passed out|collapsed|bleeding|blood|injur\w*|hurt|heart attack|seizure|stroke|overdos\w*|not breathing|can'?t breathe|choking|drown\w*|gun|weapon|knife|shots?|shooting|stabb\w*|assault\w*|attack\w*|violen\w*|threaten\w*|gas leak|gas smell|smell of gas|smell gas|smells? like gas|carbon monoxide|flood\w*|water pouring|burst pipe|suicid\w*)\b/i;
const isEmergency = (text) => EMERGENCY_RE.test(String(text || ""));
// Money, safety, security, legal/ID or policy: expert advice must be confirmed with a manager.
const CONFIRM_RE = /\b(refund\w*|comp|comps|comped|compensat\w*|discount\w*|rebate|waive\w*|charge\w*|fee|fees|price|rate|rates|money|cash|payment|pay|paid|deposit|credit card|chargeback|dispute\w*|lawsuit|legal|lawyer|police|safety|unsafe|security|theft|stolen|id|identification|passport|license|policy|policies|injur\w*|medical|fire|weapon|threat\w*|harass\w*|discriminat\w*|bed ?bugs?|insurance|liabilit\w*)\b/i;
const needsConfirm = (text) => CONFIRM_RE.test(String(text || ""));
// Safety, security and aggression terms: the only non-emergency words the server forces "urgent" for (call now).
// Money, refunds, comps, disputes, policy and system questions are NOT here: the team answers those in the chat within minutes.
const URGENT_RE = /\b(police|unsafe|theft|thief|stolen|break-?in|weapon\w*|threat\w*|harass\w*|stalk\w*|intimidat\w*|abusive|aggress\w*|hostile|belligerent)\b/i;
const needsUrgent = (text) => URGENT_RE.test(String(text || ""));

const clip = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

// ---------- escalation: who the agent should ask, and how urgently ----------
// A guest is in front of the agent (or on the phone) right now.
const PRESENT_RE = /\b(at the (front )?desk|at the counter|in the lobby|standing here|standing there|waiting|right now|on the phone|on the line|on hold|in front of me|here now|checking in now|checking out now)\b/i;
const guestPresent = (text) => PRESENT_RE.test(String(text || ""));
// Topics the Housekeeping chat answers. Everything else goes to the Front Desk chat.
const HOUSEKEEPING_RE = /\b(housekeep\w*|clean\w*|dirty|towels?|linens?|sheets?|pillows?|blankets?|bedding|duvet|toiletr\w*|shampoo|conditioner|soap|amenit\w*|supplies|restock\w*|vacuum\w*|trash|garbage|laundry|lost and found|lost & found|left behind|room status|vacant clean|inspected|turn ?down|stain\w*|mattress|crib|rollaway|roll away|ironing board|hair ?dryer|coffee maker|fridge|refrigerator|microwave|maintenance|out of order|ooo|do not disturb|dnd)\b/i;
const isHousekeepingTopic = (text) => HOUSEKEEPING_RE.test(String(text || ""));
const CHATS = new Set(["front_desk", "housekeeping"]);
// Strips emoji and [CHECK] notes, collapses whitespace, caps length. Staff must never see [CHECK] text.
const cleanMsg = (v, n = 400) => clip(String(typeof v === "string" ? v : "").replace(/\[CHECK:?[^\]]*\]/gi, "").replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, ""), n);

// "[Room #]: <what they asked>. Can a manager confirm?" with the room number when the staff text names one.
function templateMessage(staffText) {
  const room = String(staffText || "").match(/\broom\s*#?\s*(\d{2,4})\b/i);
  const body = room ? String(staffText).replace(room[0], "").replace(/^[\s,:.-]+/, "") : String(staffText || "");
  const text = clip(body.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, ""), 220).replace(/[.?!\s]+$/, "");
  return `${room ? "Room " + room[1] : "[Room #]"}: ${text || "[question]"}. Can a manager confirm?`;
}

// The level the server insists on whatever the model says: emergencies and safety/security/aggression terms are always urgent.
// Returns a reason code or null.
// How long the team usually takes to answer in the group chat: whole minutes, default 5, clamped to 1-60.
const DEFAULT_MINUTES = 5;
const responseMinutes = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && String(v ?? "").trim() !== "" ? Math.min(60, Math.max(1, n)) : DEFAULT_MINUTES; };

function urgentReason(text, emergency) {
  if (emergency || isEmergency(text)) return "emergency";
  if (needsUrgent(text)) return "safety";
  return null;
}

// escalate: the model's object (or anything). Returns { level, chat, message, why, emergency } or null when malformed.
// ctx: { staffText, emergency, answer, forceAnyway } - forceAnyway builds one even when the model sent none (advice, emergencies).
function coerceEscalate(raw, ctx = {}) {
  const staff = String(ctx.staffText || "");
  const why = urgentReason(staff, ctx.emergency);
  let o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (o) {
    const level = String(o.level || "").toLowerCase();
    if (level !== "urgent" && level !== "chat") o = null; // malformed: drop
    else o = { level, chat: String(o.chat || "").toLowerCase().replace(/[\s-]+/g, "_"), message: cleanMsg(o.message) };
  }
  if (!o && !ctx.forceAnyway) return null; // the model sent none and none is required
  if (!o) o = { level: why ? "urgent" : "chat", chat: "", message: "" };
  if (!CHATS.has(o.chat)) o.chat = "front_desk";
  if (!o.message) o.message = templateMessage(staff);
  if (why) o.level = "urgent"; // the server forces urgent; it never lowers a level
  return { level: o.level, chat: o.chat, message: o.message, why: o.level === "urgent" ? why || "ai" : null, emergency: why === "emergency" };
}

// No model message is available (keyword path, not-covered card): a generic instruction and a template message.
function fallbackEscalate({ staffText, topicText }) {
  const hk = isHousekeepingTopic(topicText != null ? topicText : staffText) || isHousekeepingTopic(staffText);
  const why = urgentReason(staffText, false);
  return { level: why ? "urgent" : "chat", chat: hk ? "housekeeping" : "front_desk", message: templateMessage(staffText), why, emergency: why === "emergency", generic: true };
}

// Turns the model's parsed JSON into one safe result, applying the rules the server enforces whatever the model says.
// ctx: { valid:Set<sopId>, stepCount:{id:n}, asks:int (asks since the last answer), expert:bool, emergency:bool,
//        emergencyId:string|null, fallbackIds:[ids best first], staffText:string }
function coerceTurn(raw, ctx) {
  const r = coerceTurnBase(raw, ctx);
  // Answers and advice carry the model's escalate object (validated). Advice always has one; an emergency answer always does.
  if (r.kind === "answer") r.escalate = coerceEscalate(raw && raw.escalate, { staffText: ctx.staffText, emergency: ctx.emergency, answer: r.answer, forceAnyway: !!ctx.emergency });
  else if (r.kind === "advise") r.escalate = coerceEscalate(raw && raw.escalate, { staffText: ctx.staffText, answer: r.advice, forceAnyway: true });
  return r;
}

function coerceTurnBase(raw, ctx) {
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

// Added to the system prompt: when and how to route the agent to a manager (urgent call) or the team's WhatsApp chats.
const ESCALATE_RULES = (minutes) => [
  'ESCALATE: In an answer or advise reply you may add "escalate": {"level":"urgent" or "chat","chat":"front_desk" or "housekeeping","message":"the message to post"}.',
  'Include escalate when the SOP (steps or the "Call a manager if" line) or your own answer tells the agent to involve, ask or call a manager or someone else, when an "ask a manager" / "not set" gap blocks the answer, and on EVERY advise reply. Otherwise leave it out.',
  `The team replies in the group chat within about ${responseMinutes(minutes)} minutes, so prefer "chat". level "urgent" (the agent phones a manager now) ONLY for: an emergency (fire, medical, gas, flood), a safety or security risk (weapon, threat, violence, theft in progress, police needed, harassment, someone hurt or injured), or a guest becoming aggressive or abusive. Everything else that needs a manager is level "chat", including refunds, comps, discounts, disputes, a guest waiting at the desk, policy exceptions, late checkout beyond the rules and system questions. The agent is told to call if nobody answers the chat. Emergencies are never "chat".`,
  'chat picks the group: "housekeeping" for rooms, cleaning, linens, towels, amenity stock, supplies, maintenance handoffs for a room, lost and found and room status; "front_desk" for everything else (reservations, rates, payments, PEP or HotelKey, policies, guest issues, shifts).',
  'message is ready to paste in WhatsApp, in the staff member\'s own voice: 1 to 3 short sentences, no emojis, no greeting. Include the room number and guest name only if the conversation gave them (otherwise write "[room #]"; never invent one), what the guest wants, what was already tried, and one clear question. Do not name the chat in the message.',
].join(" ");

function converseSystem({ hotelName, system, expert, minutes }) {
  return [
    `You are the voice of Ask Lotus at ${hotelName || "this hotel"}: a seasoned master hotel operator with 20+ years running select-service and full-service hotels, from the front desk to general manager. You know PMS work, guest recovery, safety and revenue basics. You are coaching a front desk agent in the middle of a shift.`,
    system ? `Front desk system: ${system}.` : "",
    "VOICE: Confident and direct. Lead with the action. No hedging (no \"I think\", \"you may want to\", \"maybe\", \"perhaps\"). Plain words a front desk agent can follow mid-shift. 1 to 3 short sentences.",
    "AUTHORITY: The hotel's SOPs are the authority. Answer from them and never contradict them. Use the exact names, phone numbers, amounts and times in the SOP. Never invent a procedure, price, fee, policy, time, room number or phone number. Where the SOP says \"ask a manager\", tell them to ask a manager.",
    "You see a conversation between a staff member and the assistant, a shortlist of SOPs with full text, the SOP shown last turn (if any), and a list of all SOP titles. Reply with ONE JSON object and nothing else, in one of these shapes:",
    '{"action":"answer","sop_id":"XX-00","answer":"1-3 plain sentences answering THIS conversation from the SOP","tip":"optional","focus_steps":[step numbers, optional],"escalate":{optional, see ESCALATE}}',
    '{"action":"ask","question":"one short question","options":["2-4 short answers"],"why":"clarify" or "troubleshoot","candidates":["sop ids you are considering"]}',
    expert
      ? '{"action":"advise","advice":"2-4 short sentences of practical operator guidance","confirm":true or false,"escalate":{see ESCALATE}}'
      : '{"action":"none"}',
    expert ? '{"action":"none"} is only for a message that is not a hotel question at all.' : "",
    "WHEN TO ASK: If the question is vague, or it describes a problem and the SOP has branches that change what the agent should do (still staying or checked out, card or cash, lock flashes red or shows nothing, which of two SOPs applies), ask ONE question back, like a manager would, before answering. Questions must come from the SOP text provided (a choice between candidate SOPs, or which branch of an SOP applies). Ask at most ONE question per turn. Never ask something the conversation already answered. Do not ask when you can answer well already.",
    `OPTIONS: 2 to 4 options, each 5 words or fewer, mutually exclusive, written as the staff member would say them. You may include "Something else".`,
    `LIMITS: After ${MAX_ASKS} questions in a row you MUST answer with the best SOP. For an emergency (fire, medical, violence, gas, flood, someone hurt) never ask: answer immediately with the emergency SOP. A clear question gets an answer right away.`,
    "FOLLOW-UPS: After an answer, a follow-up (for example \"what if they say no?\") is answered from the same SOP unless the staff member clearly changed topic; if the topic is clearly new, ignore the earlier turns and treat it as a fresh question.",
    "ANSWER TEXT: Address what the staff member actually described, for example \"Since the lock flashes red, the key needs re-encoding: ...\". focus_steps lists the step numbers of the SOP most relevant to this conversation (leave it out if all apply).",
    'TIP: In an answer you may add "tip": ONE short line of practical operator advice (how to phrase something to an upset guest, what to note in the log). It adds to the SOP and never contradicts or replaces it, and contains no prices, policies, phone numbers or procedures that are not in the SOP. Leave it out when there is nothing useful.',
    ESCALATE_RULES(minutes),
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
async function converse(cfg, { hotelName, system, turns, candidates, catalog, lastSop, expert, asks, minutes }) {
  const sys = converseSystem({ hotelName, system, expert: expert !== false, minutes });
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
  const text = await complete(cfg, sys, user, { maxTokens: 900 });
  const out = looseParse(text);
  if (!out) throw new Error("The AI reply wasn't understood");
  return out;
}

// ---------- SOP authoring (manager briefs the AI; it asks, then drafts) ----------
const AUTHOR_MAX_ASKS = 3;
const AUTHOR_TIMEOUT_MS = 45000, AUTHOR_MAX_TOKENS = 1500, AUTHOR_PDF_MAX_TOKENS = 5000;

function authorSystem({ hotelName, system, categories, detailKeys, roles, editing, asks, pdf }) {
  return [
    `You are a seasoned hotel operator (20+ years, front desk to general manager) writing the standard operating procedures (SOPs) that front desk agents follow in the middle of a shift${hotelName ? ` at ${hotelName}` : ""}. A manager is briefing you like an assistant: they describe a procedure in their own words and may attach screenshots or photos. You turn it into a clean SOP.`,
    system ? `Front desk system: ${system}. Use that name in the steps, never "the PMS" or "the system".` : "",
    "Reply with ONE JSON object and nothing else, in one of these shapes:",
    '{"action":"ask","question":"one or two short questions in one string","options":["optional, 2-4 short answers"]' + (pdf ? ',"multi":true or false' : "") + "}",
    '{"action":"draft","sop":{"title":"...","category":"one name from the category list","steps":[{"t":"step text","img":"photo id or null"}],"script":"what to say to the guest, or empty","flag":"when to call a manager, or empty","kw":"comma separated phrases staff might type"},"notes":"one line on what you did or assumed","missing":["things still unknown"]' + (pdf ? ',"update_sop_id":"id of the existing SOP this replaces, only when the manager chose to update it"' : "") + "}",
    `WHEN TO ASK: If the manager's message and photos are enough for a usable SOP, DRAFT IMMEDIATELY. Ask only about genuinely missing critical information: something that changes what the agent does and cannot be inferred (who to call, which screen or button, a time limit or fee that must be stated, which branch applies). One or two short questions per turn, written in the one "question" string. Add "options" only when the answer is a short choice (2 to 4 options, 5 words or fewer each). Never ask about wording or format, never ask for confirmation, never ask what was already said. Questions asked in a row so far: ${asks || 0} of ${AUTHOR_MAX_ASKS}. ${asks >= AUTHOR_MAX_ASKS ? "You MUST draft now: use [FILL: ...] for what is unknown and list it in missing." : `After ${AUTHOR_MAX_ASKS} questions in a row you MUST draft.`} If the manager says they don't know, draft with a [FILL: ...] marker.`,
    "STEPS: Short imperative steps, one action per step, plain words a new hire can follow, starting with the verb. Name the exact screen path with > (for example Reservation > Stay tab > Departure Time) only when the manager gave it. No numbering inside the text, no markdown, no emojis.",
    "KEEP THEIR WORDING: Labels, quoted text, field names, templates and formats the manager gave (for example a log book headline format) must be kept character for character, in quotes where they gave quotes. Do not paraphrase them.",
    `TOKENS: Hotel details that already exist can be written as {Detail name} instead of the literal value, whenever a step needs that fact. Use only these detail names, spelled exactly: ${detailKeys.length ? detailKeys.join("; ") : "(none)"}. Contacts are written as {Role}, for example "Call {AGM}". Use only these roles: ${roles.length ? roles.join(", ") : "(none)"}. Never write a person's name or phone number.`,
    "NEVER INVENT prices, fees, phone numbers, times, room numbers, policies or names. If a fact is needed, the manager did not give it and no token covers it, write [FILL: what is needed] in that spot and add it to missing. Never write [CHECK] markers.",
    "PHOTOS: Each attached photo is introduced to you with its id (and the manager's caption if any). Look at what it shows (a screen, a button, a form) and attach it to the ONE step it illustrates with that step's \"img\". A photo goes on one step only. Steps without a photo get null. Use only ids you were given. Do not describe a photo in the step text unless the step needs it. If a photo fits no step, leave it out and say so in notes.",
    `FIELDS: title is short and names the situation or task. category is exactly one of: ${categories.join(" | ")}. script is what the agent says to the guest, in quotes, one or two sentences, or an empty string. flag says when to call a manager and who, using a {Role} token (for example "The guest wants a refund. Call {AGM}."), or an empty string. kw is 6 to 10 phrases staff would really type or say, comma separated.`,
    editing
      ? "EDITING: The manager is changing an existing SOP (shown as CURRENT DRAFT). Keep everything they did not mention exactly as it is: same wording, same photos, same order. Return the FULL updated SOP, not a diff. Keep photo ids already on steps unless asked to change them."
      : "NEW SOP: If a CURRENT DRAFT is shown, you already drafted it earlier in this chat. Apply the manager's newest message to it and return the FULL updated SOP.",
    "notes is one short line (25 words or fewer) on what you did or assumed. missing lists short items still unknown, or [].",
    pdf ? PDF_RULES : "",
  ].filter(Boolean).join("\n");
}

// Added to the author prompt when the manager attached a PDF quick-reference guide.
const PDF_RULES = [
  "PDF GUIDE: The manager attached a PDF guide. Its text was read for you and is listed in the conversation as PROCEDURE n, then numbered lines \"step text [img:ID]\". Each ID is a screenshot cropped from the guide, already saved; you never see the pictures. Attach one to a step with that step's \"img\" (the ID only, no \"img:\" prefix). Use only IDs from the listing, each on one step only.",
  "PDF STEPS: Rewrite each step short, plain and staff-friendly in the hotel's own wording (say \"PEP\", never OnQ or \"the PMS\"; the folio is V2; the property is cashless; night audit is the Night Audit tab, then Start). Keep one screenshot per step where it helps the agent find the screen. When two steps have near-identical screenshots, or the screenshot only shows a confirmation, keep one and drop the other. Merge a step that is only an introduction into the next one. Never invent a click, button, field, fee or number that is not in the guide. Keep the guide's order. Ignore policy text and corporate notices that are not steps.",
  "PDF SPLIT OR UPDATE: Before you draft, check two things. (1) If the guide holds MORE THAN ONE separate procedure, ask whether to make one SOP for each, as ONE question listing them, for example \"This guide has 2 procedures: Print one guest's registration card / Print all arrivals' cards. Make 2 SOPs?\". Give each procedure as its own short option and set \"multi\":true so the manager can tick several; add an option \"Combine into one SOP\" only if it makes sense. (2) If a procedure clearly overlaps an SOP in the CATALOG, ask, for example \"This matches your SOP 'Standard check-out' (CO-04): update it, or make a new one?\" with options \"Update CO-04\" and \"Make a new SOP\" and \"multi\":false. Do both in one question when both apply. If the guide is one procedure with no overlap, DRAFT IMMEDIATELY and ask nothing. The manager's answer is final: never ask the same thing twice.",
  "PDF ONE AT A TIME: Draft only ONE SOP per reply. When the manager asks for several, write the first now and say in notes which one is next; the manager will ask for the next one after saving this one. When the manager chose to update an existing SOP, return the full updated SOP built from the guide, and set \"update_sop_id\" to that SOP's id from the CATALOG; otherwise leave it out. Never put the existing SOP's id on a new SOP.",
].join("\n");

const draftBlock = (d) => !d ? "" : [
  `CURRENT DRAFT: ${d.title || "(no title yet)"} [${d.category || "no category"}]`,
  ...(d.steps || []).map((x, i) => `  ${i + 1}. ${x.t}${x.img ? ` [photo ${x.img}]` : ""}`),
  d.script ? `  Say to the guest: ${d.script}` : "", d.flag ? `  Call the manager if: ${d.flag}` : "", d.kw ? `  Keywords: ${d.kw}` : "",
].filter(Boolean).join("\n");

// turns: [{role:"manager",text,images:[{id,caption}]} | {role:"assistant",kind:"ask",question,options} | {role:"assistant",kind:"draft",notes}]
// images: [{id,mime,b64,caption}] actually sent (max 6). allowedImages: extra photo ids the draft may use (already on the existing SOP).
async function authorSop(cfg, { hotelName, system, categories, detailKeys = [], roles = [], existingSop, draft, turns, images = [], allowedImages = [], asks = 0, catalog = [] }) {
  const hasPdf = turns.some((t) => t.pdf);
  const sys = authorSystem({ hotelName, system, categories, detailKeys, roles, editing: !!existingSop, asks, pdf: hasPdf });
  const lastPdf = turns.map((t, i) => (t.pdf ? i : -1)).filter((i) => i >= 0).pop();
  const first = Math.max(0, turns.length - 20);
  const convo = turns.slice(-20).map((t, k) => {
    if (t.role === "manager") {
      const ph = (t.images || []).map((i) => i.id + (i.caption ? ` (${i.caption})` : "")).join(", ");
      const pdf = t.pdf ? (first + k === lastPdf ? `\n[Attached PDF "${t.pdf.name}", ${t.pdf.pages} pages, ${t.pdf.shots} screenshots. What it contains:]\n${t.pdf.listing}\n[End of PDF]` : `\n[Attached PDF "${t.pdf.name}" (listed earlier in this chat)]`) : "";
      return `MANAGER: ${t.text || (t.pdf ? "(attached a PDF guide)" : "(no text)")}${ph ? ` [attached photos: ${ph}]` : ""}${pdf}`;
    }
    if (t.kind === "ask") return `ASSISTANT asked: ${t.question}${(t.options || []).length ? ` [options: ${t.options.join(" | ")}]` : ""}`;
    return `ASSISTANT drafted the SOP${t.notes ? ` (${t.notes})` : ""}`;
  }).join("\n");
  const sent = cleanImages(images);
  const user = [
    existingSop ? `Editing existing SOP ${existingSop.id || ""}: ${existingSop.title || ""}` : "",
    draftBlock(draft),
    hasPdf && catalog.length ? `\nCATALOG of the SOPs that already exist (id | title | category | keywords):\n${catalog.map((c) => `${c.id} | ${c.title} | ${c.category}${c.kw ? " | " + c.kw : ""}`).join("\n")}\n` : "",
    "", "Conversation (the last MANAGER line is the newest message):", convo,
    sent.length ? `\nPhotos follow, each introduced with its id: ${sent.map((i) => i.id).join(", ")}.` : "",
  ].filter((x) => x !== "").join("\n");
  const text = await complete(cfg, sys, user, { maxTokens: hasPdf ? AUTHOR_PDF_MAX_TOKENS : AUTHOR_MAX_TOKENS, timeoutMs: hasPdf ? 90000 : AUTHOR_TIMEOUT_MS, images: sent });
  const raw = looseParse(text);
  if (!raw) throw new Error("The AI reply wasn't understood");
  return coerceAuthor(raw, { pdf: hasPdf, categories, validImages: [...sent.map((i) => i.id), ...allowedImages], catalogIds: catalog.map((c) => c.id), fallbackCategory: (draft && draft.category) || (existingSop && existingSop.category) || "" });
}

const tidy = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
// [CHECK] notes are never shown to staff: an authored one becomes a [FILL: ...] gap the manager sees and completes.
const noCheck = (t) => t.replace(/\[CHECK:?\s*([^\]]*)\]/gi, (m, x) => `[FILL: ${x.trim() || "check this"}]`);

// Turns the model's JSON into the strict shape the server stores. Throws when it is neither a usable ask nor a usable draft.
function coerceAuthor(raw, ctx) {
  const cats = ctx.categories || [];
  const action = String(raw && raw.action || "").toLowerCase();
  if (action === "ask") {
    const question = tidy(raw.question, 400);
    if (!question) throw new Error("The AI reply wasn't understood");
    const seen = new Set(), options = [];
    for (const o of Array.isArray(raw.options) ? raw.options : []) {
      const t = tidy(typeof o === "string" ? o : o && o.text, 40);
      if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); options.push(t); }
    }
    const opts = options.length >= 2 ? options.slice(0, ctx.pdf ? 8 : 4) : [];
    return { action: "ask", question, options: opts, ...(ctx.pdf && opts.length && raw.multi === true ? { multi: true } : {}) };
  }
  const src = raw && (raw.sop || (action === "draft" ? raw : null));
  if (!src) throw new Error("The AI reply wasn't understood");
  const valid = new Set(ctx.validImages || []), used = new Set();
  const steps = [];
  for (const x of (Array.isArray(src.steps) ? src.steps : []).slice(0, 40)) {
    const t = noCheck(tidy(typeof x === "string" ? x : x && x.t, 1000));
    if (!t) continue;
    let img = x && typeof x === "object" && x.img != null ? String(x.img) : null;
    if (img && (!valid.has(img) || used.has(img))) img = null;
    if (img) used.add(img);
    steps.push({ t, img });
  }
  const title = tidy(src.title, 200);
  if (!title || !steps.length) throw new Error("The AI reply wasn't understood");
  const missing = (Array.isArray(raw.missing) ? raw.missing : []).map((m) => tidy(typeof m === "string" ? m : "", 140)).filter(Boolean).slice(0, 6);
  let category = cats.find((c) => c.toLowerCase() === String(src.category || "").trim().toLowerCase()) || "";
  if (!category) {
    category = cats.includes(ctx.fallbackCategory) ? ctx.fallbackCategory : cats[0] || "";
    if (category) missing.push("Category: please check it");
  }
  const kwRaw = Array.isArray(src.kw) ? src.kw.join(", ") : src.kw ?? src.keywords ?? "";
  const longText = (v) => noCheck(typeof v === "string" ? v.replace(/[ \t]+/g, " ").trim().slice(0, 1000) : "");
  return {
    action: "draft",
    sop: { title, category, steps, script: longText(src.script), flag: longText(src.flag), kw: tidy(String(kwRaw), 1000) },
    notes: tidy(raw.notes, 300),
    missing,
    ...(ctx.pdf ? { updateId: (ctx.catalogIds || []).find((id) => id.toLowerCase() === String(raw.update_sop_id || src.update_sop_id || "").trim().toLowerCase()) || null } : {}),
  };
}

module.exports = { responseMinutes, authorSop, authorSystem, coerceAuthor, buildRequest, cleanImages, MAX_IMAGES, AUTHOR_MAX_ASKS, PROVIDERS, pickSop, answerFromSop, testConnection, complete, mockEnabled, converse, converseSystem, coerceTurn, coerceEscalate, fallbackEscalate, templateMessage, isHousekeepingTopic, guestPresent, looseParse, isEmergency, needsConfirm, MAX_ASKS };
