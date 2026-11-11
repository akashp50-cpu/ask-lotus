// Sharing SOPs inside a brand group (brand + PMS): suggestions, copying SOPs to another hotel, and the pieces the Portfolio and setup use.
// Every function takes a database client `c` (a transaction client or { query }) so the caller decides what runs together.
const crypto = require("crypto");
const { familyOf, FAMILY_SQL, changedFields, changeLabel, classifyKind, copies, groupKey } = require("./groups");

const FAM = FAMILY_SQL("s.");
const KEEP_STATUS = new Set(["live", "off"]);

const snapOf = (r) => ({
  title: r.title, category: r.category ?? r.cat, steps: r.steps || [], script: r.script || "", flag: r.flag || "",
  keywords: r.keywords ?? r.kw ?? "", kind: r.kind || "general", requires: r.requires || null,
});

/* ---------- pictures and ids ---------- */
// Gives the hotel its own copy of a step picture (pictures are scoped per hotel); returns the id to use there.
async function ownImage(c, img, hotelId) {
  if (!img) return null;
  const row = (await c.query("SELECT hotel_id, mime, data FROM images WHERE id=$1", [img])).rows[0];
  if (!row) return null;
  if (row.hotel_id === hotelId) return img;
  const id = crypto.randomUUID();
  await c.query("INSERT INTO images (id, hotel_id, mime, data, created_by) VALUES ($1,$2,$3,$4,NULL)", [id, hotelId, row.mime, row.data]);
  return id;
}
async function ownImages(c, steps, hotelId) {
  const out = [];
  for (const s of Array.isArray(steps) ? steps : []) out.push({ t: typeof s === "string" ? s : s.t, img: await ownImage(c, s && s.img, hotelId) });
  return out;
}

// Makes sure the hotel has the category; the prefix and position come from the hotel the SOP came from when it has one.
async function ensureCategory(c, hotelId, name, fromHotelId) {
  if ((await c.query("SELECT 1 FROM categories WHERE hotel_id=$1 AND name=$2", [hotelId, name])).rows.length) return;
  const src = fromHotelId ? (await c.query("SELECT prefix FROM categories WHERE hotel_id=$1 AND name=$2", [fromHotelId, name])).rows[0] : null;
  const any = src || (await c.query("SELECT prefix FROM categories WHERE name=$1 LIMIT 1", [name])).rows[0];
  const mx = (await c.query("SELECT COALESCE(max(sort),-1)+1 AS n FROM categories WHERE hotel_id=$1", [hotelId])).rows[0].n;
  await c.query("INSERT INTO categories (hotel_id, name, prefix, sort) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [hotelId, name, any ? any.prefix : "SOP", mx]);
}
async function nextId(c, hotelId, prefix) {
  const { rows } = await c.query("SELECT id FROM sops WHERE hotel_id=$1 AND id LIKE $2", [hotelId, prefix + "-%"]);
  const n = Math.max(0, ...rows.map((r) => parseInt(r.id.split("-")[1], 10) || 0)) + 1;
  return `${prefix}-${String(n).padStart(2, "0")}`;
}
async function prefixOf(c, hotelId, category) {
  const r = (await c.query("SELECT prefix FROM categories WHERE hotel_id=$1 AND name=$2", [hotelId, category])).rows[0];
  return r ? r.prefix : "SOP";
}

const hotelOf = async (c, id) => (await c.query("SELECT id, name, brand, system, setup, answers FROM hotels WHERE id=$1", [id])).rows[0];
const ownByFamily = async (c, hotelId, family) =>
  (await c.query(`SELECT s.* FROM sops s WHERE s.hotel_id=$1 AND ${FAM} = $2 ORDER BY s.id LIMIT 1`, [hotelId, family])).rows[0] || null;

/* ---------- suggestions ---------- */
// The other LIVE hotels in this hotel's group.
async function peersOf(c, hotelId) {
  return (await c.query(
    `SELECT p.id, p.answers FROM hotels h JOIN hotels p ON p.brand = h.brand AND p.system = h.system AND p.id <> h.id
      WHERE h.id=$1 AND p.setup='live' ORDER BY p.id`, [hotelId]
  )).rows;
}

// A SOP was published (prev null or a draft) or a live SOP was changed: tell the group. Returns how many hotels got a suggestion.
async function suggest(c, { hotelId, row, userId }) {
  const family = familyOf(row), snap = snapOf(row);
  let n = 0;
  for (const p of await peersOf(c, hotelId)) {
    await c.query(
      "UPDATE sop_suggestions SET status='superseded', resolved_at=now() WHERE to_hotel=$1 AND from_hotel=$2 AND family=$3 AND status='open'",
      [p.id, hotelId, family]
    );
    const own = await ownByFamily(c, p.id, family);
    if (own) { if (!changedFields(snapOf(own), snap).length) continue; }
    else if (snap.requires && p.answers && p.answers[snap.requires] === false) continue; // the hotel said it has no pool, no breakfast...
    await c.query(
      "INSERT INTO sop_suggestions (to_hotel, from_hotel, family, from_sop, snapshot, created_by) VALUES ($1,$2,$3,$4,$5,$6)",
      [p.id, hotelId, family, row.id, JSON.stringify(snap), userId || null]
    );
    n++;
  }
  return n;
}

// Open suggestions for a hotel, each with whether it is new there or a change to a SOP it has, and what changed.
async function listSuggestions(c, hotelId) {
  const { rows } = await c.query(
    `SELECT g.id, g.family, g.from_hotel, g.from_sop, g.snapshot, g.created_at, fh.name AS from_name
       FROM sop_suggestions g JOIN hotels fh ON fh.id = g.from_hotel
      WHERE g.to_hotel=$1 AND g.status='open' ORDER BY g.id DESC`, [hotelId]
  );
  if (!rows.length) return [];
  const own = new Map((await c.query(`SELECT s.*, ${FAM} AS fam FROM sops s WHERE s.hotel_id=$1 AND ${FAM} = ANY($2)`, [hotelId, rows.map((r) => r.family)])).rows.map((r) => [r.fam, r]));
  const out = [], stale = [];
  for (const r of rows) {
    const o = own.get(r.family) || null;
    const changed = o ? changedFields(snapOf(o), r.snapshot) : [];
    if (o && !changed.length) { stale.push(r.id); continue; } // the hotel already has exactly this wording
    out.push({
      id: r.id, type: o ? "change" : "new", family: r.family, title: r.snapshot.title, cat: r.snapshot.category,
      from: { id: r.from_hotel, name: r.from_name }, fromSop: r.from_sop, changed, label: o ? changeLabel(changed) : "New",
      own: o ? { id: o.id, title: o.title, status: o.status } : null, steps: (r.snapshot.steps || []).length, kind: r.snapshot.kind, created: r.created_at,
    });
  }
  if (stale.length) await c.query("UPDATE sop_suggestions SET status='kept', resolved_at=now() WHERE id = ANY($1)", [stale]);
  return out;
}

const SUG_ACTIONS = { add: "added", use: "used", keep: "kept", skip: "skipped" };
// add / use / keep / skip. Returns { error: [code, message] } or { row } (the SOP that was added or updated; null for keep and skip).
async function resolveSuggestion(c, id, hotelId, action, userId) {
  const sg = (await c.query("SELECT * FROM sop_suggestions WHERE id=$1 AND to_hotel=$2 FOR UPDATE", [id, hotelId])).rows[0];
  if (!sg) return { error: [404, "That suggestion no longer exists."] };
  if (sg.status !== "open") return { error: [400, "That suggestion was already handled."] };
  const status = SUG_ACTIONS[action];
  if (!status) return { error: [400, "Unknown action."] };
  let row = null;
  if (action === "add" || action === "use") {
    const r = await applySnapshot(c, { hotelId, sg, userId, mode: action });
    if (r.error) return r;
    row = r.row;
  }
  await c.query("UPDATE sop_suggestions SET status=$2, resolved_by=$3, resolved_at=now() WHERE id=$1", [sg.id, status, userId || null]);
  return { row };
}

// Writes a suggestion's content into the hotel: a new SOP (add) or over the hotel's copy (use). The copy keeps the family.
async function applySnapshot(c, { hotelId, sg, userId, mode }) {
  const snap = sg.snapshot, own = await ownByFamily(c, hotelId, sg.family);
  const steps = await ownImages(c, snap.steps, hotelId);
  if (mode === "add") {
    if (own) return { error: [400, "This hotel already has that SOP. Use the update instead."] };
    await ensureCategory(c, hotelId, snap.category, sg.from_hotel);
    const taken = (await c.query("SELECT 1 FROM sops WHERE hotel_id=$1 AND id=$2", [hotelId, sg.from_sop])).rows.length;
    const id = taken ? await nextId(c, hotelId, await prefixOf(c, hotelId, snap.category)) : sg.from_sop;
    const r = await c.query(
      `INSERT INTO sops (hotel_id, id, category, title, steps, script, flag, keywords, status, updated_by, family, kind, requires)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'live',$9,$10,$11,$12) RETURNING *`,
      [hotelId, id, snap.category, snap.title, JSON.stringify(steps), snap.script, snap.flag, snap.keywords, userId || null, sg.family, snap.kind, snap.requires]
    );
    return { row: r.rows[0] };
  }
  if (!own) return { error: [400, "This hotel doesn't have that SOP. Add it instead."] };
  await ensureCategory(c, hotelId, snap.category, sg.from_hotel);
  await c.query("INSERT INTO sop_history (hotel_id, sop_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4,$5)", [hotelId, own.id, own.version, JSON.stringify(sopSnapshot(own)), userId || null]);
  const r = await c.query(
    `UPDATE sops SET category=$3, title=$4, steps=$5, script=$6, flag=$7, keywords=$8, kind=$9, requires=COALESCE($10, requires),
            family=COALESCE(family, $11), version=version+1, updated_at=now(), updated_by=$12
      WHERE hotel_id=$1 AND id=$2 RETURNING *`,
    [hotelId, own.id, snap.category, snap.title, JSON.stringify(steps), snap.script, snap.flag, snap.keywords, snap.kind, snap.requires, sg.family, userId || null]
  );
  return { row: r.rows[0] };
}
const sopSnapshot = (r) => ({ id: r.id, cat: r.category, title: r.title, steps: r.steps, script: r.script, flag: r.flag, kw: r.keywords, status: r.status, ver: r.version, updated: r.updated_at, master: r.master_id || null, kept: !!r.kept, kind: r.kind || null });

// The suggestion's content for the studio ("Tweak"): pictures are copied into this hotel first, so the editor can show them.
async function seedFromSuggestion(c, id, hotelId) {
  const sg = (await c.query("SELECT * FROM sop_suggestions WHERE id=$1 AND to_hotel=$2 AND status='open'", [id, hotelId])).rows[0];
  if (!sg) return { error: [404, "That suggestion is gone or was already handled."] };
  const own = await ownByFamily(c, hotelId, sg.family);
  const steps = await ownImages(c, sg.snapshot.steps, hotelId);
  return { sg, own, draft: { title: sg.snapshot.title, category: sg.snapshot.category, steps, script: sg.snapshot.script, flag: sg.snapshot.flag, kw: sg.snapshot.keywords, kind: sg.snapshot.kind } };
}
// A GM saved a SOP that came from a suggestion (Tweak): that suggestion is handled.
async function closeSuggestion(c, id, hotelId, status, userId) {
  if (!id) return;
  await c.query("UPDATE sop_suggestions SET status=$3, resolved_by=$4, resolved_at=now() WHERE id=$1 AND to_hotel=$2 AND status='open'", [id, hotelId, status, userId || null]);
}

/* ---------- copying SOPs between hotels ---------- */
// Copies SOPs of src into dst (both hotel rows). Rules: general always; PMS only if the PMS matches; brand only if the brand matches.
// statusOf(row) -> 'live' | 'off' | null (skip). Default: the status the SOP has at the source. Drafts are never copied.
// A SOP dst already has (same family) is left alone. Copies keep family and kind. Returns counts by kind, plus how many were left out by the rules.
async function copySops(c, { src, dst, userId, statusOf, families }) {
  const rows = (await c.query(`SELECT s.*, ${FAM} AS fam FROM sops s WHERE s.hotel_id=$1 AND s.status IN ('live','off') ORDER BY s.id`, [src.id])).rows;
  const have = new Set((await c.query(`SELECT ${FAM} AS fam FROM sops s WHERE s.hotel_id=$1`, [dst.id])).rows.map((r) => r.fam));
  const used = new Set((await c.query("SELECT id FROM sops WHERE hotel_id=$1", [dst.id])).rows.map((r) => r.id));
  const out = { copied: { pms: 0, general: 0, brand: 0 }, left: { pms: 0, general: 0, brand: 0 }, skipped: 0 };
  for (const r of rows) {
    const kind = r.kind || classifyKind(r);
    if (!copies(kind, src, dst)) { out.left[kind]++; continue; }
    if (families && !families.has(r.fam)) continue;
    if (have.has(r.fam)) { out.skipped++; continue; }
    const status = statusOf ? statusOf(r) : r.status;
    if (!status) continue;
    await ensureCategory(c, dst.id, r.category, src.id);
    let id = r.id;
    if (used.has(id)) id = await nextId(c, dst.id, await prefixOf(c, dst.id, r.category));
    used.add(id); have.add(r.fam);
    await c.query(
      `INSERT INTO sops (hotel_id, id, category, title, steps, script, flag, keywords, status, updated_by, family, kind, requires)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [dst.id, id, r.category, r.title, JSON.stringify(await ownImages(c, r.steps, dst.id)), r.script, r.flag, r.keywords, status, userId || null, r.fam, kind, r.requires || null]
    );
    out.copied[kind]++;
  }
  return out;
}

// What copying from src to a hotel with this brand and PMS would do: per kind, how many SOPs and whether they are copied.
async function copyPreview(c, { src, brand, system }) {
  const { rows } = await c.query("SELECT kind, count(*)::int AS n FROM sops WHERE hotel_id=$1 AND status IN ('live','off') GROUP BY kind", [src.id]);
  const n = { pms: 0, general: 0, brand: 0 };
  for (const r of rows) n[r.kind || "general"] += r.n;
  const dst = { brand, system };
  return {
    general: { n: n.general, copied: true },
    pms: { n: n.pms, copied: copies("pms", src, dst) },
    brand: { n: n.brand, copied: copies("brand", src, dst) },
  };
}

// Puts one SOP family into a hotel from another hotel that has it (a group peer first, then any hotel the rules allow). Returns the new row or null.
async function addFamilyFromGroup(c, { hotelId, family, status, userId }) {
  const dst = await hotelOf(c, hotelId);
  const cands = (await c.query(
    `SELECT s.*, h.brand AS h_brand, h.system AS h_system FROM sops s JOIN hotels h ON h.id = s.hotel_id
      WHERE ${FAM} = $1 AND s.hotel_id <> $2 AND s.status IN ('live','off') ORDER BY (h.brand = $3 AND h.system = $4) DESC, (s.status = 'live') DESC, s.hotel_id`,
    [family, hotelId, dst.brand, dst.system]
  )).rows;
  const r = cands.find((x) => copies(x.kind || classifyKind(x), { brand: x.h_brand, system: x.h_system }, dst));
  if (!r) return null;
  const res = await copySops(c, { src: { id: r.hotel_id, brand: r.h_brand, system: r.h_system }, dst, userId, families: new Set([family]), statusOf: () => status });
  if (!res.copied.pms && !res.copied.general && !res.copied.brand) return null;
  await c.query("UPDATE sop_suggestions SET status='added', resolved_by=$3, resolved_at=now() WHERE to_hotel=$1 AND family=$2 AND status='open'", [hotelId, family, userId || null]);
  return ownByFamily(c, hotelId, family);
}

// Switch SOP families on or off at a hotel. A family the hotel doesn't have yet is added from the group (live when switching on, an Off copy otherwise).
async function toggleFamilies(c, { hotelId, families, on, userId }) {
  const status = on ? "live" : "off";
  let changed = 0, skipped = 0;
  for (const family of families) {
    const own = await ownByFamily(c, hotelId, family);
    if (own) {
      const r = await c.query("UPDATE sops SET status=$3, updated_by=$4 WHERE hotel_id=$1 AND id=$2 AND status <> $3", [hotelId, own.id, status, userId || null]);
      changed += r.rowCount;
    } else if (await addFamilyFromGroup(c, { hotelId, family, status, userId })) changed++;
    else skipped++;
  }
  return { changed, skipped };
}

module.exports = {
  FAM, snapOf, ownImage, ownImages, ensureCategory, nextId, prefixOf, hotelOf, ownByFamily, peersOf, suggest, listSuggestions, resolveSuggestion,
  seedFromSuggestion, closeSuggestion, copySops, copyPreview, addFamilyFromGroup, toggleFamilies, sopSnapshot, KEEP_STATUS, groupKey,
};
