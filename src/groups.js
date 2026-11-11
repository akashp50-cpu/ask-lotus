// Brand groups: SOP libraries are shared inside a group = brand + PMS. Pure helpers (no database, no network) so they can be unit-tested.
//   kind    'pms' (walks through PMS screens) | 'general' (the same in any system) | 'brand' (a brand program, e.g. Hilton Honors)
//   family  the same SOP across hotels: the master id for copies of a master SOP, 'hotel:id' for a hotel-only SOP
const KINDS = ["pms", "general", "brand"];
const KIND_LABEL = { pms: "PMS", general: "General", brand: "Brand" };

/* ---------- classifying a SOP ---------- */
// A brand program, judged by the title only: a passing mention ("thank Honors members", "Thank you for calling Hampton Inn") doesn't make a check-in or phone SOP brand-only.
const BRAND_RE = /\b(hilton|hampton|honors|diamond|points|medallia|connected\s+room|digital[\s-]+check-?in|digital[\s-]+key)\b/i;
// Walks through PMS screens: the PMS names, the folio, V2, Copy Reservation, the Night Audit tab, screens, tabs, clicks, or a menu path like "More > Lost and Found".
const PMS_RE = /\b(PEP|HotelKey|OnQ|folio|V2|Copy\s+Reservation|Night\s+Audit|screens?|tabs?|clicks?|clicked|clicking)\b|\s>\s/i;

const stepText = (x) => (typeof x === "string" ? x : (x && x.t) || "");
const textOf = (s) => [s.title, ...(Array.isArray(s.steps) ? s.steps : []).map(stepText), s.script, s.flag].filter(Boolean).join("\n");

// sop: { title, steps, script, flag }. opts.applies: the master's 'applies' ('hilton' = brand when nothing else decides). Deterministic; the Owner spot-checks it in Portfolio.
function classifyKind(sop, opts = {}) {
  // A brand program wins; then PMS screens (a Hilton-only master like "Undo a check-out" is PEP steps, not a brand program); then the master's own flag.
  if (BRAND_RE.test(sop.title || "")) return "brand";
  if ((Array.isArray(sop.steps) ? sop.steps : []).some((x) => PMS_RE.test(stepText(x)))) return "pms";
  return opts.applies === "hilton" ? "brand" : "general";
}

/* ---------- families ---------- */
const familyOf = (row) => row.family || row.master_id || `${row.hotel_id}:${row.id}`;
// The same expression in SQL, for rows that have not been through the migration yet.
const FAMILY_SQL = (alias = "") => `COALESCE(${alias}family, ${alias}master_id, ${alias}hotel_id || ':' || ${alias}id)`;

/* ---------- groups ---------- */
const groupKey = (h) => `${h.brand}|${h.system}`;
const sameGroup = (a, b) => a.brand === b.brand && a.system === b.system;

// Whether a SOP of this kind is copied from a source hotel to a destination hotel: general always, PMS only if the PMS matches, brand only if the brand matches.
function copies(kind, src, dst) {
  if (kind === "pms") return src.system === dst.system;
  if (kind === "brand") return src.brand === dst.brand;
  return true;
}

/* ---------- what changed between two versions of a SOP ---------- */
const FIELD_LABEL = { title: "Title", category: "Category", steps: "Steps", script: "What to say", flag: "When to call a manager", keywords: "Search words", kind: "Type" };
const FIELD_ORDER = Object.keys(FIELD_LABEL);
const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
// Steps compare by wording and by whether they carry a picture (picture ids differ from hotel to hotel).
const stepsSig = (steps) => (Array.isArray(steps) ? steps : []).map((x) => [clean(stepText(x)), x && typeof x === "object" && x.img ? 1 : 0]);
function sig(f, s) {
  if (f === "steps") return JSON.stringify(stepsSig(s.steps));
  if (f === "keywords") return clean(s.keywords ?? s.kw).toLowerCase();
  if (f === "category") return clean(s.category ?? s.cat);
  if (f === "kind") return s.kind || "general";
  return clean(s[f]);
}
// -> ["steps", "script", ...] in a fixed order
function changedFields(a, b) {
  return FIELD_ORDER.filter((f) => sig(f, a) !== sig(f, b));
}
// "Steps changed", "Steps and what to say changed", "3 things changed"
function changeLabel(fields) {
  const l = fields.map((f) => FIELD_LABEL[f].toLowerCase());
  if (!l.length) return "Updated";
  if (l.length === 1) return `${FIELD_LABEL[fields[0]]} changed`;
  if (l.length === 2) return `${FIELD_LABEL[fields[0]]} and ${l[1]} changed`;
  return `${l.length} things changed`;
}

/* ---------- PMS wording for the AI ---------- */
// pms: a row of the pms table ({ name, staff_name, rules }) or null. Old hotels fall back to the wording the code always had.
const LEGACY_PMS = {
  pep: { name: "PEP", staff_name: "PEP", rules: "PEP is Hilton's name for HotelKey NextGen. Say \"PEP\" and never \"OnQ\" or \"the PMS\". The folio is V2. Use \"Copy Reservation\". Night audit is the Night Audit tab, then Start." },
  hotelkey: { name: "HotelKey NextGen", staff_name: "HotelKey", rules: "Say \"HotelKey\"." },
};
function pmsOf(hotel, pmsRow) {
  return pmsRow || LEGACY_PMS[hotel && hotel.system] || LEGACY_PMS.hotelkey;
}
const trimDot = (s) => clean(s).replace(/[.\s]+$/, "");
// One line for "Front desk system: ..." in a prompt.
function pmsLine(pms) {
  const staff = clean(pms.staff_name) || pms.name;
  const head = clean(pms.name) && clean(pms.name) !== staff ? `${pms.name} (staff call it "${staff}")` : staff;
  return pms.rules && clean(pms.rules) ? `${head}. ${clean(pms.rules)}` : head;
}
// The rules alone, as a clause for a sentence ("say PEP...; the folio is V2"). Empty when there are none.
function pmsRulesClause(pms) {
  return clean(pms.rules).split(/(?<=\.)\s+/).map(trimDot).filter(Boolean).join("; ");
}

module.exports = {
  KINDS, KIND_LABEL, classifyKind, BRAND_RE, PMS_RE, textOf, stepText, familyOf, FAMILY_SQL, groupKey, sameGroup, copies,
  changedFields, changeLabel, FIELD_LABEL, pmsOf, pmsLine, pmsRulesClause, LEGACY_PMS,
};
