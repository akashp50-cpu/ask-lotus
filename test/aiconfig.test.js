const test = require("node:test");
const assert = require("node:assert");
process.env.APP_SECRET = process.env.APP_SECRET || "x".repeat(40);
const { encrypt } = require("../src/crypto");
const { aiConfig, settingsFields } = require("../src/aiconfig");
const { PROVIDERS } = require("../src/ai");

const row = (o = {}) => ({ provider: "anthropic", model: "claude-haiku-5-5", model_writing: null, base_url: "", key_enc: encrypt("sk-test-key-123456"), ...o });

test("aiConfig: chat config uses the chat model; writing falls back to it when blank", () => {
  assert.strictEqual(aiConfig(row()).model, "claude-haiku-5-5");
  assert.strictEqual(aiConfig(row(), "writing").model, "claude-haiku-5-5");
  assert.strictEqual(aiConfig(row({ model_writing: "" }), "writing").model, "claude-haiku-5-5");
});

test("aiConfig: writing variant uses model_writing; chat is unaffected", () => {
  const s = row({ model_writing: "claude-sonnet-5-5" });
  assert.strictEqual(aiConfig(s, "writing").model, "claude-sonnet-5-5");
  assert.strictEqual(aiConfig(s).model, "claude-haiku-5-5");
  assert.strictEqual(aiConfig(s, "writing").apiKey, "sk-test-key-123456");
});

test("aiConfig: no key or provider none gives null for both variants", () => {
  assert.strictEqual(aiConfig(row({ key_enc: null }), "writing"), null);
  assert.strictEqual(aiConfig(row({ provider: "none" })), null);
});

test("settingsFields: saves and trims the writing model, keeps it when not sent", () => {
  const s = row({ model_writing: "claude-sonnet-5-5" });
  assert.strictEqual(settingsFields({ modelWriting: "  claude-opus-5-5 " }, s, PROVIDERS).model_writing, "claude-opus-5-5");
  assert.strictEqual(settingsFields({}, s, PROVIDERS).model_writing, "claude-sonnet-5-5");
  assert.strictEqual(settingsFields({ modelWriting: "" }, s, PROVIDERS).model_writing, "");
});

test("settingsFields: switching provider clears model, writing model and URL", () => {
  const s = row({ model_writing: "claude-sonnet-5-5", base_url: "https://x" });
  const f = settingsFields({ provider: "openai" }, s, PROVIDERS);
  assert.deepStrictEqual([f.switching, f.model, f.model_writing, f.base_url], [true, "", "", ""]);
  assert.strictEqual(settingsFields({ provider: "anthropic" }, s, PROVIDERS).switching, false);
});

test("anthropic suggestions: haiku chat, sonnet writing; a blank saved model still runs sonnet", () => {
  assert.strictEqual(PROVIDERS.anthropic.defaultModel, "claude-haiku-5-5");
  assert.strictEqual(PROVIDERS.anthropic.defaultWritingModel, "claude-sonnet-5-5");
  const { buildRequest } = require("../src/ai");
  assert.strictEqual(buildRequest({ provider: "anthropic", model: "", apiKey: "k" }, "s", "u").body.model, "claude-sonnet-5-5");
});
