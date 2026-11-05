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
  if (mockEnabled()) return fs.readFileSync(mockFile(), "utf8");
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

module.exports = { PROVIDERS, pickSop, answerFromSop, testConnection, complete, mockEnabled };
