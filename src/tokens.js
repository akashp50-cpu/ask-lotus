// {Role} resolves from the hotel's contacts, {Detail name} from the hotel's details. Contacts win
// when a name collides. A token with no value reads "(not set: ask a manager)".
const tokKey = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
const UNSET = "(not set: ask a manager)";
function tokenFiller(contacts, details) {
  const d = {};
  for (const [k, v] of Object.entries(details || {})) if (String(v ?? "").trim()) d[tokKey(k)] = String(v).trim();
  return (t) =>
    String(t || "").replace(/\{([^}]+)\}/g, (m, r) => {
      const c = contacts.find((x) => tokKey(x.role) === tokKey(r));
      if (c) return `${c.name} (${c.role}) ${c.phone}`;
      const v = d[tokKey(r)];
      return v !== undefined ? v : UNSET;
    });
}

// SOP text as staff would see it, for the model: contact and detail tokens filled in,
// [CHECK] manager notes removed, [FILL] gaps marked as "ask a manager".
function forModel(sop, contacts, details) {
  const tokens = tokenFiller(contacts, details);
  const fill = (t) =>
    tokens(t)
      .replace(/\[CHECK:[^\]]*\]|\[CHECK\]/g, "")
      .replace(/\[FILL:?[^\]]*\]/g, UNSET)
      .trim();
  const steps = (Array.isArray(sop.steps) ? sop.steps : []).map((x) => fill(typeof x === "string" ? x : x.t)).filter(Boolean);
  return { id: sop.id, title: sop.title, category: sop.category, steps, script: fill(sop.script), flag: fill(sop.flag) };
}

module.exports = { tokKey, UNSET, tokenFiller, forModel };
