// What the setup asks, and how the old detail names still resolve.
//
// SOPs say {Hotel short name}, {Pool hours}, {Rollaway script}, {Room type 3}... at every hotel and are never edited for this. The wizard now asks each fact
// once; every other token is either an ALIAS of an asked detail, DERIVED from it (a pool's two times make "Pool hours"), or GENERATED from a yes/no answer
// (cashless wording). resolve() fills those in at render time. A value the hotel already has (explicit and not a [FILL] placeholder) always wins, so live
// hotels render exactly what they rendered before.
//
// Pure functions only (no database, no network).
const { tokKey } = require("./tokens");
const rooms = require("./rooms");

const NOT_OFFERED = "not offered at this hotel";
const isFill = (v) => /\[FILL/.test(String(v ?? ""));
const filled = (v) => { const s = String(v ?? "").trim(); return !!s && !isFill(s); };
const rawGet = (details, key) => { const k = Object.keys(details || {}).find((x) => tokKey(x) === tokKey(key)); return k === undefined ? "" : String(details[k] ?? "").trim(); };
const nonEmpty = (v) => (filled(v) && v !== NOT_OFFERED ? v : "");

/* ---------- what is asked ---------- */
// screen: where it is asked. sec: section title. type: text | ml | time | percent | money | phone. gate: {q, v}: only asked after that yes/no answer is v.
// when: "core" (always asked) or "used" (asked only if a SOP that is on uses the token). optional: asked, but never counts toward progress.
// copy: may be copied from a sister hotel (always marked "check this"). essential: blocks go-live (handled in onboard.readiness).
const F = (key, o) => ({ key, label: key, hint: "", type: "text", gate: null, when: "core", optional: false, copy: true, ...o });
const AMEN_SEC = { breakfast: "Breakfast", pool: "Pool", pets: "Pets", laundry: "Laundry", market: "Market" };
const yes = (q) => ({ q, v: true });

const FIELDS = [
  // Your hotel
  F("Hotel name", { screen: "hotel", sec: "Name and times", label: "Hotel name, as you say it on the phone", hint: "With \"the\" if you say it, e.g. the Hampton Inn Overland Park", copy: false }),
  F("Phone greeting", { screen: "hotel", sec: "Name and times", label: "Phone greeting", hint: "Optional. e.g. Thank you for calling the Hampton, this is Maria", optional: true, copy: false }),
  F("Check-in time", { screen: "hotel", sec: "Name and times", hint: "e.g. 3 PM", type: "time" }),
  F("Check-out time", { screen: "hotel", sec: "Name and times", hint: "e.g. 11 AM", type: "time" }),
  F("Wi-Fi network", { screen: "hotel", sec: "Wi-Fi", label: "Wi-Fi network name", hint: "The guest network name", copy: false }),
  F("Wi-Fi password", { screen: "hotel", sec: "Wi-Fi", hint: "Optional. Or tap Open network if guests need no password", optional: true, copy: false }),
  F("Hotel location check", { screen: "hotel", sec: "More about the hotel", when: "used", ml: true, label: "Name and street, to tell it from look-alikes", hint: "Name and street of this hotel, so staff can tell it from look-alikes with the same brand", copy: false }),
  F("State", { screen: "hotel", sec: "More about the hotel", when: "used", hint: "State the hotel is in, for tax-exempt rules", copy: false }),
  F("Hotel code", { screen: "hotel", sec: "More about the hotel", when: "used", hint: "Brand hotel code used with brand support", copy: false }),
  F("Entrance lock time", { screen: "hotel", sec: "More about the hotel", when: "used", hint: "When the main entrance is locked at night, e.g. 11 PM", type: "time" }),

  // Amenities (each asked once, after its yes/no)
  F("Breakfast hours", { screen: "amenities", sec: "Breakfast", gate: yes("breakfast"), hint: "e.g. 6–10 AM" }),
  F("To-go bag name", { screen: "amenities", sec: "Breakfast", gate: yes("breakfast"), when: "used", hint: "Name of the grab-and-go breakfast bag, e.g. On the Run" }),
  F("Pool opening time", { screen: "amenities", sec: "Pool", gate: yes("pool"), type: "time", hint: "e.g. 10 AM" }),
  F("Pool closing time", { screen: "amenities", sec: "Pool", gate: yes("pool"), type: "time", hint: "e.g. 10 PM" }),
  F("Gym cups storage", { screen: "amenities", sec: "Pool", gate: yes("pool"), when: "used", hint: "Where gym cups are kept, e.g. 417 Storage" }),
  F("Pets allowed", { screen: "amenities", sec: "Pets", gate: yes("pets"), ml: true, hint: "Which pets are allowed and where, e.g. Dogs only. Every room is a pet room." }),
  F("Pet fee", { screen: "amenities", sec: "Pets", gate: yes("pets"), ml: true, hint: "The full fee rule, e.g. $75 per stay for 1–3 nights, $125 for 4 or more" }),
  F("Laundry location", { screen: "amenities", sec: "Laundry", gate: yes("laundry"), hint: "Where the guest laundry is" }),
  F("Laundry cost", { screen: "amenities", sec: "Laundry", gate: yes("laundry"), hint: "Cost and how guests pay" }),
  F("Market name", { screen: "amenities", sec: "Market", gate: yes("market"), hint: "What you call the lobby shop, e.g. treat shop, market" }),
  F("Market price list", { screen: "amenities", sec: "Market", gate: yes("market"), ml: true, hint: "Prices for items sold in the shop" }),

  // Policies
  F("Late check-out cutoff", { screen: "policies", sec: "Check-out, fees and parking", type: "time", hint: "Time after which a full night is charged, e.g. 12 PM" }),
  F("Smoking fee", { screen: "policies", sec: "Check-out, fees and parking", type: "money", hint: "e.g. $450" }),
  F("Parking pass days", { screen: "policies", sec: "Check-out, fees and parking", when: "used", hint: "How long a parking pass lasts after check-out, e.g. 1 day" }),
  F("Quiet hours", { screen: "policies", sec: "House rules", ml: true, hint: "e.g. 10 PM–7 AM" }),
  F("Visitor policy", { screen: "policies", sec: "House rules", ml: true, hint: "Who may visit guest rooms and until when" }),
  F("Occupancy limit", { screen: "policies", sec: "House rules", ml: true, hint: "Maximum guests per room" }),
  F("Weapons policy", { screen: "policies", sec: "House rules", ml: true, hint: "Hotel weapons policy" }),
  F("Early check-in cutoff", { screen: "policies", sec: "Early check-in", type: "time", hint: "Time before which early check-in rules apply, e.g. 12 PM" }),
  F("Early check-in occupancy limit", { screen: "policies", sec: "Early check-in", type: "percent", label: "Early check-in fee applies when occupancy is above ___%", hint: "A number, e.g. 70. Below it, early check-in is free when a room is ready." }),
  F("Early check-in fee", { screen: "policies", sec: "Early check-in", type: "money", hint: "Fee when early check-in is allowed, e.g. $50" }),
  F("Cash policy", { screen: "policies", sec: "Cash", gate: yes("cash"), ml: true, hint: "Hotel-wide cash rule as one sentence, e.g. Cash is accepted for rooms and deposits up to $200." }),
  F("Cash deposit step", { screen: "policies", sec: "Cash", gate: yes("cash"), ml: true, label: "Cash deposit amount and rule", hint: "e.g. Cash deposit is $100 per night, refunded at check-out" }),
  F("Starting cash note", { screen: "policies", sec: "Cash", gate: yes("cash"), label: "Starting cash for a shift", hint: "e.g. Starting Cash $200" }),

  // Rooms (yes/no follow-ups; the room inventory has its own editor)
  F("Rollaway fee", { screen: "rooms", sec: "Rollaways", gate: yes("rollaways"), type: "money", label: "Rollaway fee", hint: "e.g. $15 per night, or No charge" }),
  F("Pack-and-play fee", { screen: "rooms", sec: "Pack-and-plays", gate: yes("pack_and_plays"), type: "money", label: "Pack-and-play fee", hint: "e.g. No charge" }),
  F("Connecting room pairs", { screen: "rooms", sec: "Connecting rooms", gate: yes("connecting_rooms"), label: "Which rooms connect", hint: "e.g. 201–202, 301–302" }),
  F("Hearing kit location", { screen: "rooms", sec: "Accessible rooms", hint: "Where the hearing-impaired communication kit is kept" }),
  F("Coffee supplies storage", { screen: "rooms", sec: "Storage locations", hint: "Where lobby coffee and coffee makers are kept" }),
  F("Toiletries storage", { screen: "rooms", sec: "Storage locations", hint: "Where guest toiletries, toilet paper and cups are kept" }),
  F("Pillow storage", { screen: "rooms", sec: "Storage locations", hint: "Where extra pillows and lobby cups are kept" }),
  F("Crib storage", { screen: "rooms", sec: "Storage locations", hint: "Where cribs and ice buckets are kept" }),
  F("Fridge and microwave storage", { screen: "rooms", sec: "Storage locations", hint: "Where spare fridges and microwaves are kept" }),
  F("Cribs on hand", { screen: "rooms", sec: "Storage locations", when: "used", hint: "How many cribs and where, e.g. 2 in 317 Storage" }),
  F("Bath amenities storage", { screen: "rooms", sec: "Storage locations", when: "used", hint: "Where shampoo, conditioner, lotion and soap are kept" }),
  F("Audit envelope drop-off", { screen: "rooms", sec: "Storage locations", when: "used", hint: "Where the finished audit envelope goes" }),

  // Emergency and basics (new; asked even though no SOP uses them yet)
  F("AED location", { screen: "basics", sec: "Emergency locations", hint: "e.g. Lobby, by the elevator", copy: false }),
  F("First aid kit location", { screen: "basics", sec: "Emergency locations", hint: "e.g. Behind the front desk", copy: false }),
  F("Water shutoff location", { screen: "basics", sec: "Emergency locations", hint: "e.g. Boiler room, north wall", copy: false }),
  F("Breaker panel location", { screen: "basics", sec: "Emergency locations", hint: "e.g. Hallway behind the laundry room", copy: false }),
  F("Flashlight location", { screen: "basics", sec: "Emergency locations", hint: "e.g. Bottom drawer at the front desk", copy: false }),
  F("Hotel address", { screen: "basics", sec: "Hotel basics", ml: true, hint: "Street, city, state and ZIP", copy: false }),
  F("Front desk phone", { screen: "basics", sec: "Hotel basics", type: "phone", hint: "(913) 555-0123", copy: false }),
  F("Debit hold amount", { screen: "basics", sec: "Money", type: "money", label: "Incidental deposit amount", hint: "The hold placed on a card at check-in, e.g. $50 per night" }),
  F("Late check-out fee", { screen: "basics", sec: "Money", type: "money", hint: "e.g. $25 per hour, or half a night" }),
  F("Lost and found hold period", { screen: "basics", sec: "Lost and found", hint: "How long items are kept", default: "30 days" }),
  F("Parking cost", { screen: "basics", sec: "Parking", hint: "Free, or the price, e.g. Free" }),
  F("Parking location", { screen: "basics", sec: "Parking", hint: "Where guests park, e.g. Lot behind the hotel" }),

  // Systems
  F("ID scanner", { screen: "systems", sec: "Tools your team uses", hint: "ID scanning app used at check-in, e.g. IDGuru" }),
  F("Log book app", { screen: "systems", sec: "Tools your team uses", hint: "App for the shift log book and work orders, e.g. Quore" }),
  F("Key system", { screen: "systems", sec: "Tools your team uses", hint: "Lock/key software used when the encoder fails, e.g. OnPortal" }),
  F("Card authorization tool", { screen: "systems", sec: "Tools your team uses", hint: "Vendor for card authorization forms and links, e.g. Canary" }),
  F("DNR system", { screen: "systems", sec: "More tools", when: "used", hint: "Where do-not-rent guests are also recorded, e.g. ID Guru" }),
  F("Manual key steps", { screen: "systems", sec: "More tools", when: "used", ml: true, hint: "Steps to cut a key by hand in the key software" }),
  F("Housekeeping chat app", { screen: "systems", sec: "More tools", when: "used", hint: "Group chat app used with housekeeping, e.g. WhatsApp" }),
];
const BY_KEY = new Map(FIELDS.map((f) => [tokKey(f.key), f]));
const fieldOf = (key) => BY_KEY.get(tokKey(key)) || null;

// The yes/no questions: where each is asked, and which asked details follow it.
const YN = {
  breakfast: { screen: "amenities", title: "Breakfast", q: "Do you serve breakfast?" },
  pool: { screen: "amenities", title: "Pool", q: "Do you have a pool?" },
  pets: { screen: "amenities", title: "Pets", q: "Do you allow pets?" },
  laundry: { screen: "amenities", title: "Laundry", q: "Is there a guest laundry room?" },
  market: { screen: "amenities", title: "Market", q: "Do you sell snacks at the front desk?" },
  cash: { screen: "policies", title: "Cash", q: "Does the hotel accept cash?" },
  rollaways: { screen: "rooms", title: "Rollaways", q: "Do you offer rollaways?" },
  pack_and_plays: { screen: "rooms", title: "Pack-and-plays", q: "Do you have pack-and-plays for guests?" },
  connecting_rooms: { screen: "rooms", title: "Connecting rooms", q: "Do you have connecting rooms?" },
};
const YN_KEYS = Object.keys(YN);

// Details that are never asked because another answer makes them. Listed so nothing else mistakes them for a hotel-specific leftover.
const GENERATED = [
  "Hotel short name", "Hotel welcome name", "Wi-Fi network name", "Breakfast hours spoken", "Pool hours", "Pet fee quote", "Incidental deposit amount",
  "Rollaway policy", "Rollaway script", "Rollaway crib script", "Pack-and-play policy", "Connecting rooms policy", "Connecting rooms script",
  "Cash payment step", "Cash payment script", "Shop payment step", "Card machine down cash step",
  "Total rooms", "Rooms per floor", "Room list by type", "Room Type Count", "Fridge and microwave rooms", "Sofa sleeper rooms", "Accessible rooms", "Accessible room list",
  ...Array.from({ length: 60 }, (_, i) => `Room type ${i + 1}`),
];
const GENERATED_SET = new Set(GENERATED.map(tokKey));
const isGenerated = (key) => GENERATED_SET.has(tokKey(key));

/* ---------- wording generated from the yes/no answers (the wordings the setup has always filled in) ---------- */
const CASH_NO = {
  "Cash policy": "The hotel is completely cashless: no cash for rooms, deposits or the treat shop.",
  "Cash payment step": "Offer a credit card or debit card in the guest's name.",
  "Cash payment script": "We're a cashless hotel, so we'll need a card. If someone else is paying, I can send them a quick form.",
  "Cash deposit step": "The hotel is cashless. Cash can't be used for the room or the deposit.",
  "Shop payment step": "The hotel is cashless: post the item to the room or take a card.",
  "Starting cash note": "Starting Cash $0, the hotel is cashless",
  "Card machine down cash step": "The hotel is cashless, so cash can't replace it.",
};
const CASH_YES = {
  "Cash policy": "The hotel accepts cash.",
  "Cash payment step": "Accept cash, count it twice in front of the guest, and put it in the drawer.",
  "Cash payment script": "We can take cash for that.",
  "Cash deposit step": "Cash can be used for the room and the deposit.",
  "Shop payment step": "Post the item to the room, or take a card or cash.",
  "Card machine down cash step": "Cash can be taken while the machine is down.",
};
const sentence = (s) => { const t = String(s || "").trim(); return t ? (/[.!?]$/.test(t) ? t : t + ".") : ""; };
const nameList = (types) => types.map((t) => t.name || t.code).join(" and ");

// ctx: { answers, rooms, get(key): the hotel's own value or "" }. -> { key: wording } for one yes/no question, or {} when it isn't answered.
function generated(q, ctx) {
  const a = ctx.answers || {};
  if (a[q] === undefined || a[q] === null) return {};
  const on = !!a[q];
  if (q === "cash") return on ? { ...CASH_YES } : { ...CASH_NO };
  if (q === "rollaways") {
    const fee = nonEmpty(ctx.get("Rollaway fee"));
    const feeLine = fee ? ` The fee is ${fee.replace(/\.$/, "")}.` : "";
    if (on) return { "Rollaway policy": `Rollaways are available.${fee ? " Fee: " + fee.replace(/\.$/, "") + "." : ""}`, "Rollaway script": `We can bring a rollaway up for you.${feeLine}`, "Rollaway crib script": `I can bring a crib or a rollaway up for you.${feeLine}` };
    const sofa = ((ctx.rooms && ctx.rooms.types) || []).filter((t) => t.sofa);
    return { "Rollaway policy": "No rollaways are available.", "Rollaway script": `We don't have rollaways${sofa.length ? `, but our ${nameList(sofa)} rooms have a sofa sleeper` : ""}.`, "Rollaway crib script": "We don't have rollaways, but I can bring a crib up for you at no charge." };
  }
  if (q === "pack_and_plays") {
    const fee = nonEmpty(ctx.get("Pack-and-play fee"));
    return { "Pack-and-play policy": on ? `Pack-and-plays are available.${fee ? " Fee: " + fee.replace(/\.$/, "") + "." : ""}` : "No pack-and-plays are stocked." };
  }
  if (q === "connecting_rooms") {
    const pairs = nonEmpty(ctx.get("Connecting room pairs"));
    return on
      ? { "Connecting rooms policy": `Connecting rooms are available on request.${pairs ? " Connecting rooms: " + pairs.replace(/\.$/, "") + "." : ""}`, "Connecting rooms script": "We can try to connect your rooms." }
      : { "Connecting rooms policy": "The hotel doesn't offer connecting rooms.", "Connecting rooms script": "We don't have connecting rooms, but I can put you right next to each other." };
  }
  return {};
}

/* ---------- alias and derive rules ---------- */
// "6–10 AM" -> "6 to 10": the hours as you say them aloud.
function spoken(hours) {
  const h = String(hours || "").trim();
  if (!h) return "";
  const s = h.replace(/\b([ap])\.?m\.?\b/gi, "").replace(/\s*[–—-]\s*|\s+to\s+/gi, " to ").replace(/\s+/g, " ").trim();
  return /\d/.test(s) && / to /.test(s) ? s : "";
}
const firstMoney = (t) => { const m = /\$\s?\d[\d,]*(?:\.\d+)?/.exec(String(t || "")); return m ? m[0].replace(/\s+/g, "") : ""; };
const dash = "–";

// Rules that copy or combine ASKED details. [target, sources, fn(get) -> string]. Each is also kept in step when a source is edited (see syncAfterSave).
const RULES = [
  ["Hotel short name", ["Hotel name"], (g) => nonEmpty(g("Hotel name"))],
  ["Hotel welcome name", ["Hotel name"], (g) => nonEmpty(g("Hotel name"))],
  ["Wi-Fi network name", ["Wi-Fi network"], (g) => nonEmpty(g("Wi-Fi network"))],
  ["Incidental deposit amount", ["Debit hold amount"], (g) => nonEmpty(g("Debit hold amount"))],
  ["Debit hold amount", ["Incidental deposit amount"], (g) => nonEmpty(g("Incidental deposit amount"))],
  ["Breakfast hours spoken", ["Breakfast hours"], (g) => spoken(nonEmpty(g("Breakfast hours")))],
  ["Pool hours", ["Pool opening time", "Pool closing time"], (g) => (nonEmpty(g("Pool opening time")) && nonEmpty(g("Pool closing time")) ? `${nonEmpty(g("Pool opening time"))}${dash}${nonEmpty(g("Pool closing time"))}` : "")],
  ["Pet fee quote", ["Pet fee"], (g) => firstMoney(nonEmpty(g("Pet fee")))],
];

// resolve(details, { answers, rooms }) -> { details, derived: [{ key, value, via }] }. details is a copy of the hotel's own details plus every alias,
// derived and generated token that has no value of its own. Nothing is stored: this runs when SOPs are rendered.
function resolveFull(details, ctx = {}) {
  const raw = details || {};
  const out = { ...raw };
  const derived = [];
  const get = (k) => rawGet(raw, k);
  const put = (key, value, via) => {
    if (!value) return;
    if (nonEmpty(get(key))) return; // the hotel's own value wins
    if (get(key) === NOT_OFFERED) return;
    const existing = Object.keys(out).find((x) => tokKey(x) === tokKey(key));
    out[existing === undefined ? key : existing] = value;
    derived.push({ key, value, via });
  };
  const c = { answers: ctx.answers || {}, rooms: ctx.rooms || null, get };
  for (const [target, , fn] of RULES) put(target, fn(get), "alias");
  for (const q of YN_KEYS) for (const [k, v] of Object.entries(generated(q, c))) put(k, v, "answer:" + q);
  for (const [k, v] of Object.entries(rooms.derive(c.rooms))) put(k, v, "rooms");
  for (const f of FIELDS) if (f.default) put(f.key, f.default, "default");
  return { details: out, derived };
}
const resolve = (details, ctx) => resolveFull(details, ctx).details;

// A source detail just changed. A derived-or-alias value the hotel holds that still equals what it used to derive follows the change;
// anything the GM customised is left alone. before/after are the hotel's own details (not resolved). Returns a new `after`.
function syncAfterSave(before, after) {
  const out = { ...after };
  const g0 = (k) => rawGet(before, k), g1 = (k) => rawGet(out, k);
  for (const [target, sources, fn] of RULES) {
    if (!sources.some((s) => g0(s) !== g1(s))) continue;
    const prev = fn(g0), next = fn(g1), cur = g1(target);
    if (!cur || !prev || cur !== prev || cur === next) continue; // blank resolves live; customised stays
    const k = Object.keys(out).find((x) => tokKey(x) === tokKey(target));
    if (next) out[k] = next; else delete out[k];
  }
  return out;
}

// An answer changed from `old` to `now`: stored wording that still equals what the old answer generated goes away so the new answer's wording takes over.
function dropStaleGenerated(details, q, oldAnswers, newAnswers, rm) {
  if (!oldAnswers || oldAnswers[q] === undefined || !!oldAnswers[q] === !!newAnswers[q]) return details;
  const out = { ...details };
  const get = (k) => rawGet(out, k);
  const was = generated(q, { answers: { [q]: !!oldAnswers[q] }, rooms: rm, get });
  for (const [k, v] of Object.entries(was)) {
    const key = Object.keys(out).find((x) => tokKey(x) === tokKey(k));
    if (key !== undefined && String(out[key]).trim() === v) delete out[key];
  }
  return out;
}

/* ---------- validity ---------- */
const percentOf = (v) => { const m = /^\s*(\d{1,3}(?:\.\d+)?)\s*%?\s*$/.exec(String(v ?? "")); return m && +m[1] >= 0 && +m[1] <= 100 ? +m[1] : null; };
const VALID = { percent: (v) => percentOf(v) !== null };
function valueFilled(field, v) {
  if (!filled(v) || v === NOT_OFFERED) return false;
  const f = typeof field === "string" ? fieldOf(field) : field;
  return !(f && VALID[f.type]) || VALID[f.type](v);
}

/* ---------- migration of one hotel (pure; db/onboarding.js writes the result) ---------- */
const NO_RE = { cash: /cashless|no cash|doesn.?t accept cash|not accept cash/i, rollaways: /^no rollaway|not available|don.?t (have|offer)/i, pack_and_plays: /^no pack|not stocked|don.?t (have|offer)/i, connecting_rooms: /doesn.?t offer|no connecting|don.?t (have|offer)|not available/i };
const POLICY_OF = { cash: "Cash policy", rollaways: "Rollaway policy", pack_and_plays: "Pack-and-play policy", connecting_rooms: "Connecting rooms policy" };
function splitHours(h) {
  const parts = String(h || "").split(/\s*[–—-]\s*|\s+to\s+/i).map((x) => x.trim()).filter(Boolean);
  return parts.length === 2 ? parts : null;
}

// hotel: { details, answers, rooms }. -> { details, answers, rooms, changes: [..text], merged: [..], unanswered: [..] }.
// Fill-if-empty only: no key is ever removed and no existing value is changed, so the result is the same however often it runs.
function migrateHotel(hotel) {
  const details = { ...(hotel.details || {}) }, answers = { ...(hotel.answers || {}) };
  let inv = hotel.rooms || null;
  const changes = [], merged = [];
  const get = (k) => rawGet(details, k);
  const set = (k, v, why) => { details[k] = v; changes.push(`${k} <- ${why}: ${String(v).slice(0, 60)}`); };
  const carry = (target, sources) => {
    if (filled(get(target))) return;
    for (const s of sources) if (filled(get(s)) && get(s) !== NOT_OFFERED) { set(target, get(s), s); merged.push(`${s} -> ${target}`); return; }
  };
  carry("Hotel name", ["Hotel short name", "Hotel welcome name"]);
  carry("Wi-Fi network", ["Wi-Fi network name"]);
  if (filled(get("Pool hours")) && get("Pool hours") !== NOT_OFFERED && !filled(get("Pool opening time")) && !filled(get("Pool closing time"))) {
    const p = splitHours(get("Pool hours"));
    if (p) { set("Pool opening time", p[0], "Pool hours"); set("Pool closing time", p[1], "Pool hours"); merged.push("Pool hours -> Pool opening time + Pool closing time"); }
  }
  // The yes/no answers a hotel never gave are read from its policy text, the way go-live always did for cash.
  for (const q of ["cash", "rollaways", "pack_and_plays", "connecting_rooms"]) {
    if (answers[q] !== undefined) continue;
    const t = get(POLICY_OF[q]);
    if (!filled(t)) continue;
    answers[q] = !NO_RE[q].test(t);
    changes.push(`answer ${q} <- ${POLICY_OF[q]}: ${answers[q] ? "yes" : "no"}`);
  }
  let built = null;
  if (!inv) {
    const r = rooms.fromLegacy(details);
    if (r.inventory) { inv = r.inventory; built = r; changes.push(`room inventory built: ${inv.types.length} type(s), ${rooms.total(inv)} rooms`); merged.push("Room type 1..7 + Room list by type -> room inventory"); }
    else if (r.notes.length) changes.push("room inventory NOT built: " + r.notes.join("; "));
  }
  return { details, answers, rooms: inv, changes, merged, built };
}

// The questions a hotel would now be asked that it has no usable answer for (used by the dry run).
function newlyUnanswered(before, after) {
  const out = [];
  for (const f of FIELDS) {
    if (f.optional || f.when !== "core" || f.screen === "basics") continue;
    if (f.gate && !(after.answers || {})[f.gate.q]) continue;
    const had = valueFilled(f, rawGet(before.details, f.key));
    if (!valueFilled(f, rawGet(after.details, f.key)) && !(f.default)) out.push({ key: f.key, hadText: !!rawGet(before.details, f.key) && !had });
  }
  return out;
}

module.exports = {
  NOT_OFFERED, FIELDS, fieldOf, YN, YN_KEYS, GENERATED, isGenerated, generated, RULES, resolve, resolveFull, syncAfterSave, dropStaleGenerated,
  valueFilled, percentOf, filled, nonEmpty, isFill, rawGet, spoken, firstMoney, migrateHotel, newlyUnanswered, AMEN_SEC, CASH_NO, CASH_YES,
};
