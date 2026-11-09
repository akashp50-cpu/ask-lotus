const test = require("node:test");
const assert = require("node:assert");
const ai = require("../src/ai");
const { stepTextFor, SKIP_TEXT } = require("../db/updates");

const CATS = ["Departures and check-out", "Shift routines and handoff"];
const ctx = (o = {}) => ({ categories: CATS, validImages: ["img-1", "img-2"], fallbackCategory: "", ...o });

test("ask: trims, de-duplicates and caps options; a lone option is dropped", () => {
  const r = ai.coerceAuthor({ action: "ask", question: "  Who do they call?  ", options: ["AGM", "agm", "GM", "COO", "Engineer", "Other"] }, ctx());
  assert.deepStrictEqual(r, { action: "ask", question: "Who do they call?", options: ["AGM", "GM", "COO", "Engineer"] });
  assert.deepStrictEqual(ai.coerceAuthor({ action: "ask", question: "Q?", options: ["Only"] }, ctx()).options, []);
  assert.throws(() => ai.coerceAuthor({ action: "ask", question: "" }, ctx()));
});

test("draft: category matched case-insensitively, unknown ids and duplicate photos dropped, [CHECK] becomes [FILL]", () => {
  const r = ai.coerceAuthor({
    action: "draft", notes: "Wrote it.", missing: ["Phone"],
    sop: { title: "Late checkout", category: "departures and CHECK-OUT", kw: ["late checkout", "stay later"],
      steps: [{ t: "Open PEP.", img: "img-1" }, "Save.", { t: "Post it. [CHECK: the time]", img: "img-1" }, { t: "Done", img: "zzz" }, { t: "  " }],
      script: "\"Hi\"", flag: "Call {AGM}." },
  }, ctx());
  assert.strictEqual(r.action, "draft");
  assert.strictEqual(r.sop.category, "Departures and check-out");
  assert.deepStrictEqual(r.sop.steps, [{ t: "Open PEP.", img: "img-1" }, { t: "Save.", img: null }, { t: "Post it. [FILL: the time]", img: null }, { t: "Done", img: null }]);
  assert.strictEqual(r.sop.kw, "late checkout, stay later");
  assert.deepStrictEqual(r.missing, ["Phone"]);
});

test("draft: unknown category falls back to the current one (or the first) and flags it", () => {
  const raw = { action: "draft", sop: { title: "T", category: "Nope", steps: ["A"] } };
  const a = ai.coerceAuthor(raw, ctx({ fallbackCategory: "Shift routines and handoff" }));
  assert.strictEqual(a.sop.category, "Shift routines and handoff");
  assert.ok(a.missing.some((m) => /Category/.test(m)));
  assert.strictEqual(ai.coerceAuthor(raw, ctx()).sop.category, CATS[0]);
});

test("draft without a title or steps, or an unknown action, is rejected", () => {
  assert.throws(() => ai.coerceAuthor({ action: "draft", sop: { title: "T", steps: [] } }, ctx()));
  assert.throws(() => ai.coerceAuthor({ action: "draft", sop: { steps: ["a"] } }, ctx()));
  assert.throws(() => ai.coerceAuthor({ action: "chat" }, ctx()));
  // a bare draft (fields at the top level) is accepted too
  assert.strictEqual(ai.coerceAuthor({ action: "draft", title: "T", steps: ["a"], category: CATS[1] }, ctx()).sop.category, CATS[1]);
});

const IMGS = [
  { id: "a1", mime: "image/jpeg", b64: "AAAA", caption: "PEP screen" },
  { id: "a2", mime: "image/png", b64: "BBBB" },
];
const cfg = (provider, extra = {}) => ({ provider, model: "m1", apiKey: "k", baseUrl: "https://x.example/v1", ...extra });

test("anthropic request: base64 image blocks, each introduced by a text line with its id and caption", () => {
  const r = ai.buildRequest(cfg("anthropic"), "SYS", "USER", { images: IMGS, maxTokens: 1500 });
  const c = r.body.messages[0].content;
  assert.strictEqual(c[0].text, "USER");
  assert.strictEqual(c[1].text, "Photo a1 (caption: PEP screen):");
  assert.deepStrictEqual(c[2], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
  assert.strictEqual(c[3].text, "Photo a2:");
  assert.strictEqual(c[4].source.media_type, "image/png");
  assert.strictEqual(r.body.max_tokens, 1500);
  assert.strictEqual(r.body.system, "SYS");
});

test("openai / azure / custom request: image_url data URLs", () => {
  for (const p of ["openai", "azure", "custom"]) {
    const r = ai.buildRequest(cfg(p), "SYS", "USER", { images: IMGS });
    const c = r.body.messages[1].content;
    assert.strictEqual(r.body.messages[0].role, "system");
    assert.deepStrictEqual(c[2], { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }, p);
    assert.strictEqual(c[4].image_url.url, "data:image/png;base64,BBBB");
  }
  assert.strictEqual(ai.buildRequest(cfg("custom"), "S", "U", {}).url, "https://x.example/v1/chat/completions");
});

test("google request: inline_data parts", () => {
  const r = ai.buildRequest(cfg("google"), "SYS", "USER", { images: IMGS, maxTokens: 1500 });
  const parts = r.body.contents[0].parts;
  assert.deepStrictEqual(parts[2], { inline_data: { mime_type: "image/jpeg", data: "AAAA" } });
  assert.strictEqual(parts[3].text, "Photo a2:");
  assert.strictEqual(r.body.generationConfig.maxOutputTokens, 1500);
});

test("no images: the user message stays a plain string; at most 6 images; bad ones are ignored", () => {
  assert.strictEqual(ai.buildRequest(cfg("anthropic"), "S", "U").body.messages[0].content, "U");
  assert.strictEqual(ai.buildRequest(cfg("openai"), "S", "U").body.messages[1].content, "U");
  const many = Array.from({ length: 9 }, (_, i) => ({ id: "i" + i, mime: "image/jpeg", b64: "AA" }));
  const c = ai.buildRequest(cfg("anthropic"), "S", "U", { images: [...many, { id: "bad", mime: "text/plain", b64: "x" }] }).body.messages[0].content;
  assert.strictEqual(c.filter((x) => x.type === "image").length, 6);
  assert.strictEqual(ai.cleanImages(many).length, ai.MAX_IMAGES);
});

test("authorSop with the mock: parses a draft and keeps only photos it was given", async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const f = path.join(os.tmpdir(), `author-mock-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify([{ action: "draft", sop: { title: "T", category: CATS[0], steps: [{ t: "One", img: "p1" }, { t: "Two", img: "other" }] }, notes: "n" }]));
  process.env.AI_MOCK_FILE = f;
  try {
    const r = await ai.authorSop({}, { categories: CATS, turns: [{ role: "manager", text: "hi", images: [{ id: "p1" }] }], images: [{ id: "p1", mime: "image/jpeg", b64: "AA" }] });
    assert.deepStrictEqual(r.sop.steps.map((s) => s.img), ["p1", null]);
  } finally { delete process.env.AI_MOCK_FILE; fs.unlinkSync(f); }
});

test("author prompt carries the rules, categories, tokens and the ask limit", () => {
  const s = ai.authorSystem({ hotelName: "H", system: "PEP", categories: CATS, detailKeys: ["Log book app"], roles: ["AGM"], editing: false, asks: 3 });
  for (const w of ["DRAFT IMMEDIATELY", "[FILL:", "Log book app", "AGM", CATS[0], "You MUST draft now", "character for character"]) assert.ok(s.includes(w), w);
});

test("update loader: per-hotel step wording and skipped steps", () => {
  const step = { t: "PEP text", hk: "HK text", hampton: "Hampton text" };
  assert.strictEqual(stepTextFor(step, { id: "hop", system: "pep" }), "Hampton text");
  assert.strictEqual(stepTextFor(step, { id: "x", system: "pep" }), "PEP text");
  assert.strictEqual(stepTextFor(step, { id: "hlm", system: "hotelkey" }), "HK text");
  assert.strictEqual(stepTextFor({ t: "T" }, { id: "hlm", system: "hotelkey" }), "T");
  assert.strictEqual(stepTextFor({ t: "T", hk: SKIP_TEXT }, { id: "hlm", system: "hotelkey" }), null);
  assert.strictEqual(stepTextFor({ t: "T", hk: SKIP_TEXT }, { id: "hop", system: "pep" }), "T");
  assert.strictEqual(stepTextFor({ t: "T", hotels: { hlm: "Own" } }, { id: "hlm", system: "hotelkey" }), "Own");
});
