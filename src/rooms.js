// Room inventory: the structured list of room types a hotel has (code, name, count, room numbers and three flags).
// Pure functions only. The wizard edits it, the token resolver (src/details.js) derives the old {Room type 1}, {Accessible rooms}... tokens from it,
// and the migration builds it from the plain details the live hotels have today.
//
//   inventory = { types: [{ code, name, count, rooms: ["101", ...], accessible, sofa, fridge }], source }

const str = (x, n) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const MAX_TYPES = 60, MAX_ROOMS_PER_TYPE = 600;

const roomSort = (a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || (a < b ? -1 : a > b ? 1 : 0);

// Cleans whatever the browser sent into an inventory. Anything that isn't a type with a code is dropped.
function normalize(input) {
  const src = Array.isArray(input) ? input : input && Array.isArray(input.types) ? input.types : [];
  const seen = new Set(), types = [];
  for (const t of src) {
    if (!t || typeof t !== "object") continue;
    const code = str(t.code, 24);
    if (!code || seen.has(code.toLowerCase())) continue;
    seen.add(code.toLowerCase());
    const rooms = [...new Set((Array.isArray(t.rooms) ? t.rooms : []).map((r) => str(r, 8)).filter(Boolean))].sort(roomSort).slice(0, MAX_ROOMS_PER_TYPE);
    let count = t.count === "" || t.count === null || t.count === undefined ? NaN : Math.round(Number(t.count));
    if (!Number.isFinite(count) || count < 0) count = rooms.length;
    types.push({ code, name: str(t.name, 60), count: Math.min(count, 5000), rooms, accessible: t.accessible === true, sofa: t.sofa === true, fridge: t.fridge === true });
    if (types.length >= MAX_TYPES) break;
  }
  const out = { types };
  const source = str(input && input.source, 20);
  if (source) out.source = source;
  return out;
}

const total = (inv) => ((inv && inv.types) || []).reduce((n, t) => n + (t.count || 0), 0);
const hasInventory = (inv) => !!(inv && Array.isArray(inv.types) && inv.types.length && total(inv) > 0);

// 101, 102, 103, 105 -> "101–103, 105"
function compress(rooms) {
  const nums = [...rooms].sort(roomSort);
  const out = [];
  for (let i = 0; i < nums.length;) {
    let j = i;
    while (j + 1 < nums.length && /^\d+$/.test(nums[j]) && /^\d+$/.test(nums[j + 1]) && +nums[j + 1] === +nums[j] + 1) j++;
    out.push(j - i >= 2 ? `${nums[i]}–${nums[j]}` : nums.slice(i, j + 1).join(", "));
    i = j + 1;
  }
  return out.join(", ");
}

// 3 digits: floor = first digit (305 -> 3). 4 digits: first two (1205 -> 12). Rooms with fewer digits have no floor.
function floorOf(room) {
  const m = /^(\d{3,4})/.exec(String(room));
  if (!m) return null;
  return m[1].length === 3 ? +m[1][0] : +m[1].slice(0, 2);
}
function perFloor(inv) {
  const by = new Map();
  for (const t of (inv && inv.types) || []) for (const r of t.rooms || []) { const f = floorOf(r); if (f !== null) by.set(f, (by.get(f) || 0) + 1); }
  return [...by.entries()].sort((a, b) => a[0] - b[0]);
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const label = (t) => (t.name ? `${t.code}: ${t.name}` : t.code);

// Everything the old room tokens say, from one inventory. Keys are the old detail names.
function derive(inv) {
  const out = {};
  if (!hasInventory(inv)) return out;
  const types = inv.types;
  out["Total rooms"] = String(total(inv));
  out["Room Type Count"] = String(types.length);
  types.forEach((t, i) => { out[`Room type ${i + 1}`] = `${label(t)} (${plural(t.count, "room")})`; });
  // Floors and the full list only make sense when every type has all its room numbers.
  const complete = types.every((t) => t.rooms.length === t.count);
  const floors = perFloor(inv);
  if (complete && floors.length) out["Rooms per floor"] = floors.map(([f, n]) => `Floor ${f}: ${n}`).join(", ");
  if (complete) out["Room list by type"] = types.map((t) => `${label(t)}: ${compress(t.rooms)}`).join("\n");
  const named = (t) => `${t.code}${t.name ? " " + t.name : ""} rooms`;
  const fr = types.filter((t) => t.fridge), so = types.filter((t) => t.sofa), ac = types.filter((t) => t.accessible);
  if (fr.length) out["Fridge and microwave rooms"] = fr.map(named).join(" and ");
  if (so.length) out["Sofa sleeper rooms"] = so.map(named).join(" and ");
  if (ac.length) {
    // "210 (HRK), 219, 319, 419 (HQ)": the room numbers, with the type code after the last room of each type.
    out["Accessible room list"] = ac.map((t) => (t.rooms.length ? `${t.rooms.length > 1 ? t.rooms.slice(0, -1).join(", ") + ", " : ""}${t.rooms[t.rooms.length - 1]} (${t.code})` : `${plural(t.count, "room")} (${t.code})`)).join(", ");
    out["Accessible rooms"] = ac.map((t) => (t.rooms.length ? `${compress(t.rooms)} (${t.name || t.code})` : `${t.name || t.code}: ${plural(t.count, "room")}`)).join(", ");
  }
  return out;
}

/* ---------- migration: build an inventory from the plain details a hotel has today ---------- */

// "101, 102–105, 110 and 112" -> ["101","102",...]. Returns null when the text holds something that isn't a room list.
function parseRoomList(text) {
  const rooms = [];
  const s = String(text || "").replace(/\band\b/gi, ",").replace(/[()]/g, " ");
  for (const part of s.split(/[,;]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d{1,4})\s*[–—-]\s*(\d{1,4})$/.exec(part);
    if (m) {
      const a = +m[1], b = +m[2];
      if (b < a || b - a > 200) return null;
      for (let n = a; n <= b; n++) rooms.push(String(n));
    } else if (/^\d{1,4}[A-Za-z]?$/.test(part)) rooms.push(part);
    else return null;
  }
  return rooms;
}

// "Room list by type" in the shapes a GM types: one type per line (or ;), "CODE: 101, 102" or "CODE (Name): 101–105" or "CODE - 101, 102".
function parseRoomListByType(text) {
  const types = [];
  for (const line of String(text || "").split(/\n|;/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^([A-Za-z0-9]{1,12})(?:\s*\(([^)]*)\))?\s*[:\-–—]\s*(.+)$/.exec(line);
    if (!m) return null;
    const rooms = parseRoomList(m[3]);
    if (!rooms || !rooms.length) return null;
    types.push({ code: m[1], name: str(m[2], 60), count: rooms.length, rooms, accessible: false, sofa: false, fridge: false });
  }
  return types.length ? types : null;
}

// "KXLX: King Deluxe with fridge and microwave (18): 129, 131, 229–232." / "KXTD: King Standard (32 rooms)." / "NKXQA: accessible King with tub (121, 421, 521)."
function parseRoomTypeLine(text) {
  const m = /^([A-Za-z0-9]{1,12})\s*:\s*(.+?)\.?$/.exec(String(text || "").trim());
  if (!m) return null;
  const code = m[1];
  let rest = m[2], count = null, rooms = [];
  // a trailing room list after "): "
  const tail = /\)\s*:\s*(.+)$/.exec(rest);
  if (tail) { const l = parseRoomList(tail[1]); if (l) { rooms = l; rest = rest.slice(0, tail.index + 1); } }
  const par = /\(([^)]*)\)\s*$/.exec(rest);
  let name = rest;
  if (par) {
    name = rest.slice(0, par.index).trim();
    const inner = par[1].trim();
    const n = /^(\d+)(?:\s*rooms?)?$/i.exec(inner);
    if (n) count = +n[1];
    else { const l = parseRoomList(inner); if (l && l.length) { rooms = l; count = l.length; } }
  }
  if (count === null && rooms.length) count = rooms.length;
  if (count === null) return null;
  const low = text.toLowerCase();
  return { code, name: str(name, 60), count, rooms, accessible: /accessible/.test(low), sofa: /sofa/.test(low), fridge: /fridge/.test(low) };
}

// -> { inventory|null, notes: [..] }. Never throws; a hotel whose text doesn't parse simply gets no inventory.
function fromLegacy(details) {
  const get = (k) => { const e = Object.entries(details || {}).find(([x]) => x.toLowerCase().replace(/[^a-z0-9]/g, "") === k.toLowerCase().replace(/[^a-z0-9]/g, "")); const v = e ? String(e[1] ?? "").trim() : ""; return v && !/\[FILL/.test(v) ? v : ""; };
  const notes = [];
  const typed = [];
  for (let i = 1; i <= 12; i++) {
    const v = get(`Room type ${i}`);
    if (!v) continue;
    const t = parseRoomTypeLine(v);
    if (!t) { notes.push(`Room type ${i} ("${v.slice(0, 40)}") could not be read`); continue; }
    typed.push(t);
  }
  const byType = parseRoomListByType(get("Room list by type"));
  if (get("Room list by type") && !byType) notes.push("Room list by type could not be read");
  let types = [];
  if (byType) {
    types = byType;
    for (const t of types) { const m = typed.find((x) => x.code.toLowerCase() === t.code.toLowerCase()); if (m) { if (m.name) t.name = m.name; t.sofa = m.sofa; t.fridge = m.fridge; t.accessible = m.accessible; } }
  } else if (typed.length && !notes.length) types = typed;
  else if (typed.length) { notes.push("kept no inventory because a room type line was unreadable"); }
  if (!types.length) return { inventory: null, notes };
  // Accessible rooms named in "Accessible room list" ("210 (HRK), 219, 319, 419 (HQ)"): a code in brackets after a run of rooms marks that run's type.
  const acc = get("Accessible room list");
  if (acc && byType) {
    for (const t of types) { const own = t.rooms.some((r) => new RegExp(`\\b${r}\\b[^,]*\\(${t.code}\\)`, "i").test(acc)); if (own) t.accessible = true; }
  }
  return { inventory: { types, source: "migrated" }, notes };
}

module.exports = { normalize, total, hasInventory, compress, floorOf, perFloor, derive, parseRoomList, parseRoomListByType, parseRoomTypeLine, fromLegacy, roomSort, MAX_TYPES };
