// Turns the settings row into the config the AI layer needs, and works out what a settings save changes.
// Kept apart from server.js so both can be unit-tested without starting the server.
const { decrypt } = require("./crypto");

// variant "writing": SOP authoring and document import use model_writing, falling back to the chat model when blank.
function aiConfig(s, variant) {
  if (!s || !s.key_enc || s.provider === "none") return null;
  try {
    const model = variant === "writing" && s.model_writing ? s.model_writing : s.model;
    return { provider: s.provider, model, baseUrl: s.base_url, apiKey: decrypt(s.key_enc) };
  } catch (e) {
    // e.g. APP_SECRET changed since the key was saved: fall back to keyword matching
    console.error("Saved AI key can't be decrypted; re-enter it in Settings.", e.message);
    return null;
  }
}

// The provider/model/url fields after a save. Switching provider clears model, writing model and URL (like the key).
function settingsFields(b, s, providers) {
  const provider = b.provider && (b.provider === "none" || providers[b.provider]) ? b.provider : s.provider;
  const switching = provider !== s.provider;
  const text = (v, n) => String(v).trim().slice(0, n);
  return {
    switching,
    provider,
    model: b.model !== undefined ? text(b.model, 100) : switching ? "" : s.model,
    model_writing: b.modelWriting !== undefined ? text(b.modelWriting, 100) : switching ? "" : s.model_writing || "",
    base_url: b.baseUrl !== undefined ? text(b.baseUrl, 300) : switching ? "" : s.base_url,
  };
}

module.exports = { aiConfig, settingsFields };
