// Content updates loader. Applies every db/seed-data/updates/*.json once, in filename order, on every deploy
// (called from db/seed.js). Applied ids are recorded in master_meta under 'applied_updates', so re-running is a no-op.
//
// File shape (see 2026-11-09-hilton-honors.json):
//   { id, note, images: { name: "img/file.jpg" }, sops: [ ... ] }
//   sop without "patch": { id, cat, title, applies, requires, kw, steps: [{ t, hk?, hampton?, hotels?: {hotelId: text}, img?: name }], script, script_hk?, flag, flag_hk? }
//      -> created in the master library (or, if the id exists, updated: version + 1 and a master_history row), then copied to every live hotel it fits.
//   sop with "patch": { id, patch: { append_step: { t, hk?, hampton?, img? } } }
//      -> the step is appended to the master SOP and to hotel copies that are up to date and not "kept".
// Per-hotel wording of a step: hotels[hotelId] (or "hampton" for hotel 'hop'), else the hotel system's wording (HotelKey: hk ?? t, PEP: t).
// A step whose chosen text is exactly "Skip this step at this hotel." is left out of that hotel's copy.
// A hotel copy marked kept (the hotel chose its own wording) is never overwritten, and no pending update is created for it.
const fs = require("fs");
const path = require("path");

const UPDATES_DIR = process.env.UPDATES_DIR || path.join(__dirname, "seed-data", "updates");
const SKIP_TEXT = "Skip this step at this hotel.";
const AMENITIES = ["breakfast", "pool", "pets", "laundry", "market"];
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

const nz = (x) => (x == null || x === "" ? null : x);
const fitsBrand = (applies, brand) => applies === "all" || brand === "hilton";

function listUpdateFiles(dir = UPDATES_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

// The text of one step at one hotel (null = leave the step out).
function stepTextFor(step, hotel) {
  const own = (step.hotels && step.hotels[hotel.id]) || (hotel.id === "hop" ? step.hampton : null);
  let t = nz(own) ?? (hotel.system === "hotelkey" ? nz(step.hk) ?? step.t : step.t);
  return t === SKIP_TEXT ? null : t;
}
function scriptFor(t, hk, hotel) {
  const x = hotel.system === "hotelkey" && nz(hk) ? hk : t || "";
  return x === SKIP_TEXT ? "" : x;
}

// A deterministic image id for a hotel: the master's image itself at the home hotel, a per-hotel copy elsewhere.
const hotelImageId = (masterImg, homeHotel, hotelId) => (hotelId === homeHotel ? masterImg : `${masterImg}-${hotelId}`);

async function ensureMasterCategory(c, name, idPrefix) {
  if ((await c.query("SELECT 1 FROM master_categories WHERE name=$1", [name])).rows.length) return;
  const mx = (await c.query("SELECT COALESCE(max(sort),-1)+1 AS n FROM master_categories")).rows[0].n;
  await c.query("INSERT INTO master_categories (name, prefix, sort) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [name, idPrefix, mx]);
}
async function ensureHotelCategory(c, hotelId, name) {
  if ((await c.query("SELECT 1 FROM categories WHERE hotel_id=$1 AND name=$2", [hotelId, name])).rows.length) return;
  const mc = (await c.query("SELECT prefix FROM master_categories WHERE name=$1", [name])).rows[0];
  const mx = (await c.query("SELECT COALESCE(max(sort),-1)+1 AS n FROM categories WHERE hotel_id=$1", [hotelId])).rows[0].n;
  await c.query("INSERT INTO categories (hotel_id, name, prefix, sort) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [hotelId, name, mc ? mc.prefix : "SOP", mx]);
}

// Loads the file's images into the images table (hotel `home`), returns name -> image id.
async function loadImages(c, upd, dir, home) {
  const out = {};
  for (const [name, rel] of Object.entries(upd.images || {})) {
    const file = path.resolve(dir, rel);
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime || !fs.existsSync(file)) { console.warn(`  [${upd.id}] image "${name}" skipped (${rel} missing or not a jpg/png/webp).`); continue; }
    const id = `upd-${upd.id}-${name}`;
    await c.query("INSERT INTO images (id, hotel_id, mime, data, created_by) VALUES ($1,$2,$3,$4,NULL) ON CONFLICT (id) DO NOTHING", [id, home, mime, fs.readFileSync(file)]);
    out[name] = id;
  }
  return out;
}

// Makes sure a hotel has its own copy of a master image (images are scoped per hotel).
async function ownImage(c, masterImg, home, hotelId) {
  if (!masterImg) return null;
  const id = hotelImageId(masterImg, home, hotelId);
  if (id === masterImg) return id;
  await c.query(
    `INSERT INTO images (id, hotel_id, mime, data, created_by) SELECT $2, $3, mime, data, NULL FROM images WHERE id=$1 ON CONFLICT (id) DO NOTHING`,
    [masterImg, id, hotelId]
  );
  return id;
}

const hasHk = (steps, scriptHk, flagHk) => (steps || []).some((s) => s.hk) || !!scriptHk || !!flagHk;
const hkSig = (steps, scriptHk, flagHk) => JSON.stringify([(steps || []).map((s) => s.hk || null), scriptHk || null, flagHk || null]);
const sopSnapshot = (r) => ({ id: r.id, cat: r.category, title: r.title, steps: r.steps, script: r.script, flag: r.flag, kw: r.keywords, status: r.status, ver: r.version, updated: r.updated_at, master: r.master_id || null, kept: !!r.kept });

// ---- master side ----
// Returns { master: row after the change, changed, created } for a full SOP definition.
async function upsertMaster(c, s, imgs) {
  const steps = (s.steps || []).map((x) => ({ t: x.t, hk: nz(x.hk), img: x.img ? imgs[x.img] || null : null, _src: x }));
  const clean = steps.map(({ _src, ...x }) => x);
  const scriptHk = nz(s.script_hk), flagHk = nz(s.flag_hk);
  const applies = s.applies === "hilton" ? "hilton" : "all";
  const requires = AMENITIES.includes(s.requires) ? s.requires : null;
  const prefix = String(s.id).split("-")[0];
  await ensureMasterCategory(c, s.cat, prefix);
  const cur = (await c.query("SELECT * FROM master_sops WHERE id=$1 FOR UPDATE", [s.id])).rows[0];
  if (!cur) {
    const r = await c.query(
      `INSERT INTO master_sops (id, category, title, steps, script, script_hk, flag, flag_hk, keywords, applies, requires, hk_status, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'live') RETURNING *`,
      [s.id, s.cat, s.title, JSON.stringify(clean), s.script || "", scriptHk, s.flag || "", flagHk, s.kw || "", applies, requires, hasHk(clean, scriptHk, flagHk) ? "draft" : "same"]
    );
    return { master: r.rows[0], created: true, steps };
  }
  const same = cur.category === s.cat && cur.title === s.title && JSON.stringify(cur.steps) === JSON.stringify(clean) &&
    cur.script === (s.script || "") && nz(cur.script_hk) === scriptHk && cur.flag === (s.flag || "") && nz(cur.flag_hk) === flagHk &&
    cur.keywords === (s.kw || "") && cur.applies === applies && nz(cur.requires) === requires && cur.status === "live";
  if (same) return { master: cur, created: false, unchanged: true, steps };
  let hk = cur.hk_status;
  if (!hasHk(clean, scriptHk, flagHk)) hk = "same";
  else if (hkSig(clean, scriptHk, flagHk) !== hkSig(cur.steps, cur.script_hk, cur.flag_hk) || cur.hk_status === "same") hk = "draft";
  await c.query("INSERT INTO master_history (master_id, version, snapshot, changed_by) VALUES ($1,$2,$3,NULL)", [cur.id, cur.version, JSON.stringify(cur)]);
  const r = await c.query(
    `UPDATE master_sops SET category=$2, title=$3, steps=$4, script=$5, script_hk=$6, flag=$7, flag_hk=$8, keywords=$9,
            applies=$10, requires=$11, hk_status=$12, status='live', version=version+1, updated_at=now(), updated_by=NULL
      WHERE id=$1 RETURNING *`,
    [cur.id, s.cat, s.title, JSON.stringify(clean), s.script || "", scriptHk, s.flag || "", flagHk, s.kw || "", applies, requires, hk]
  );
  return { master: r.rows[0], created: false, steps };
}

// ---- hotel side ----
async function liveHotels(c) {
  return (await c.query("SELECT id, name, brand, system, answers FROM hotels WHERE setup='live' ORDER BY id")).rows;
}
const amenityOk = (h, requires) => !requires || !!((h.answers && h.answers[requires]) === true);

// Writes a full master SOP to every live hotel it fits. `srcSteps` carry the per-hotel overrides from the file.
async function propagateFull(c, upd, s, m, srcSteps, home, log) {
  const counts = { inserted: 0, replaced: 0, pending: 0, skipped: 0 };
  for (const h of await liveHotels(c)) {
    const cur = (await c.query("SELECT * FROM sops WHERE hotel_id=$1 AND id=$2 FOR UPDATE", [h.id, m.id])).rows[0];
    // A new copy is only made where the SOP fits; a copy the hotel already has (even switched off) is kept current.
    if (!cur && (!fitsBrand(m.applies, h.brand) || !amenityOk(h, m.requires))) { counts.skipped++; continue; }
    if (cur && !cur.master_id) { console.warn(`  [${upd.id}] ${h.id} has its own hotel-only ${m.id}; left it alone.`); counts.skipped++; continue; }
    // A copy the hotel changed itself is left as it is. Pending updates are gone (SOPs are shared inside a brand group by suggestions now),
    // so it is marked as up to date with the master instead of being left behind.
    if (cur && cur.master_id === m.id && cur.kept) {
      await c.query("UPDATE sops SET master_version=$3 WHERE hotel_id=$1 AND id=$2 AND master_version < $3", [h.id, m.id, m.version]);
      counts.pending++; log(`  ${h.id} ${m.id}: changed by the hotel, left alone`); continue;
    }
    if (cur && cur.master_version >= m.version) { counts.skipped++; continue; }
    const steps = [];
    for (const x of srcSteps) {
      const t = stepTextFor({ ...x._src, t: x.t, hk: x.hk }, h);
      if (t == null) continue;
      steps.push({ t, img: await ownImage(c, x.img, home, h.id) });
    }
    await ensureHotelCategory(c, h.id, m.category);
    const script = scriptFor(m.script, m.script_hk, h), flag = scriptFor(m.flag, m.flag_hk, h);
    if (!cur) {
      await c.query(
        `INSERT INTO sops (hotel_id, id, category, title, steps, script, flag, keywords, status, updated_by, master_id, master_version, kept)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'live',NULL,$2,$9,FALSE)`,
        [h.id, m.id, m.category, m.title, JSON.stringify(steps), script, flag, m.keywords, m.version]
      );
      counts.inserted++;
    } else {
      await c.query("INSERT INTO sop_history (hotel_id, sop_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4,NULL)", [h.id, cur.id, cur.version, JSON.stringify(sopSnapshot(cur))]);
      await c.query(
        `UPDATE sops SET category=$3, title=$4, steps=$5, script=$6, flag=$7, keywords=$8, status=$9,
                version=version+1, updated_at=now(), updated_by=NULL, master_version=$10, kept=FALSE
          WHERE hotel_id=$1 AND id=$2`,
        [h.id, m.id, m.category, m.title, JSON.stringify(steps), script, flag, m.keywords, cur.status === "off" || cur.status === "draft" ? cur.status : "live", m.version]
      );
      counts.replaced++;
    }
  }
  return counts;
}

async function applyPatch(c, upd, s, imgs, home, log) {
  const step = s.patch && s.patch.append_step;
  if (!step || !step.t) { console.warn(`  [${upd.id}] ${s.id}: unknown patch ignored.`); return; }
  const cur = (await c.query("SELECT * FROM master_sops WHERE id=$1 FOR UPDATE", [s.id])).rows[0];
  if (!cur) { console.warn(`  [${upd.id}] ${s.id}: master SOP not found; patch skipped.`); return; }
  const mstep = { t: step.t, hk: nz(step.hk), img: step.img ? imgs[step.img] || null : null };
  const last = cur.steps[cur.steps.length - 1];
  if (last && last.t === mstep.t) { log(`  ${s.id}: step already there, nothing to append`); return; }
  const steps = [...cur.steps, mstep];
  const hk = hkSig(steps, cur.script_hk, cur.flag_hk) !== hkSig(cur.steps, cur.script_hk, cur.flag_hk) || cur.hk_status === "same" ? "draft" : cur.hk_status;
  await c.query("INSERT INTO master_history (master_id, version, snapshot, changed_by) VALUES ($1,$2,$3,NULL)", [cur.id, cur.version, JSON.stringify(cur)]);
  const m = (await c.query(
    "UPDATE master_sops SET steps=$2, hk_status=$3, version=version+1, updated_at=now(), updated_by=NULL WHERE id=$1 RETURNING *",
    [cur.id, JSON.stringify(steps), hasHk(steps, cur.script_hk, cur.flag_hk) ? hk : "same"]
  )).rows[0];
  const hotels = new Map((await c.query("SELECT id, system FROM hotels")).rows.map((h) => [h.id, h]));
  let n = 0, pend = 0;
  for (const cp of (await c.query("SELECT * FROM sops WHERE master_id=$1 FOR UPDATE", [cur.id])).rows) {
    // Only copies that were up to date and are still the Lotus wording get the step; the others are left alone (no pending update is created).
    if (cp.kept || cp.master_version !== cur.version) {
      await c.query("UPDATE sops SET master_version=$3 WHERE hotel_id=$1 AND id=$2 AND master_version < $3", [cp.hotel_id, cp.id, m.version]);
      pend++; continue;
    }
    const h = hotels.get(cp.hotel_id);
    const t = stepTextFor({ ...step, t: mstep.t, hk: mstep.hk }, h);
    // Nothing to add at this hotel (step skipped there, or the same text is already last): just move the version marker.
    if (t == null || (cp.steps.length && cp.steps[cp.steps.length - 1].t === t)) {
      await c.query("UPDATE sops SET master_version=$3 WHERE hotel_id=$1 AND id=$2", [cp.hotel_id, cp.id, m.version]);
      continue;
    }
    const next = [...cp.steps, { t, img: await ownImage(c, mstep.img, home, cp.hotel_id) }];
    await c.query("INSERT INTO sop_history (hotel_id, sop_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4,NULL)", [cp.hotel_id, cp.id, cp.version, JSON.stringify(sopSnapshot(cp))]);
    await c.query(
      `UPDATE sops SET steps=$3, version=version+1, updated_at=now(), updated_by=NULL, master_version=$4 WHERE hotel_id=$1 AND id=$2`,
      [cp.hotel_id, cp.id, JSON.stringify(next), m.version]
    );
    n++;
  }
  log(`  ${s.id}: step appended to master (v${m.version}); ${n} hotel cop${n === 1 ? "y" : "ies"} got it${pend ? `, ${pend} left alone` : ""}`);
}

async function applyOne(c, upd, dir, log) {
  const live = await liveHotels(c);
  const home = (live.find((h) => h.brand === "hilton") || live[0] || (await c.query("SELECT id FROM hotels ORDER BY id LIMIT 1")).rows[0] || {}).id;
  if (!home) throw new Error("no hotel to hold the update images");
  const imgs = await loadImages(c, upd, dir, home);
  for (const s of upd.sops || []) {
    if (!s || !s.id) continue;
    if (s.patch) { await applyPatch(c, upd, s, imgs, home, log); continue; }
    if (!s.title || !Array.isArray(s.steps) || !s.steps.length || !s.cat) { console.warn(`  [${upd.id}] ${s.id}: missing title, category or steps; skipped.`); continue; }
    const r = await upsertMaster(c, s, imgs);
    const m = r.master;
    const counts = await propagateFull(c, upd, s, m, r.steps, home, log);
    log(`  ${s.id} ${r.created ? "created" : r.unchanged ? "unchanged" : "updated"} in master (v${m.version}); hotels: ${counts.inserted} added, ${counts.replaced} replaced, ${counts.pending} left alone (changed by the hotel)`);
  }
}

// Applies every update file not yet recorded in master_meta 'applied_updates'. `tx` runs a function in a transaction.
async function applyUpdates({ tx, dir = UPDATES_DIR, log = console.log } = {}) {
  const files = listUpdateFiles(dir);
  if (!files.length) return { applied: [] };
  const done = await tx(async (c) => {
    const r = (await c.query("SELECT value FROM master_meta WHERE key='applied_updates'")).rows[0];
    return new Set(Array.isArray(r && r.value) ? r.value : []);
  });
  const applied = [];
  for (const f of files) {
    let upd;
    try { upd = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { console.error(`Update ${f} isn't valid JSON (${e.message}); skipped.`); continue; }
    const id = String((upd && upd.id) || f.replace(/\.json$/, ""));
    upd.id = id;
    if (done.has(id)) continue;
    try {
      log(`Applying content update ${id}${upd.note ? ` (${String(upd.note).slice(0, 80)})` : ""}`);
      await tx(async (c) => {
        await applyOne(c, upd, dir, log);
        await c.query(
          `INSERT INTO master_meta (key, value) VALUES ('applied_updates', $1::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = (SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(NULLIF(master_meta.value, '{}'::jsonb), '[]'::jsonb) || $1::jsonb) AS x)`,
          [JSON.stringify([id])]
        );
      });
      applied.push(id);
    } catch (e) {
      // The whole file rolled back; it is retried on the next deploy. The rest of the deploy carries on.
      console.error(`Content update ${id} FAILED and was rolled back: ${e.stack || e.message}`);
    }
  }
  return { applied };
}

module.exports = { applyUpdates, stepTextFor, listUpdateFiles, SKIP_TEXT };
