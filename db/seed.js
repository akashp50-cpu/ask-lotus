// Seeds Ask Lotus: hotels, Hampton's categories, SOPs, contacts and call routes, the Owner's master
// library, and the first Owner account. Re-running is safe: existing rows are left alone.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { pool, tx } = require("../src/db");
const hampton = require("./seed-data/hampton-sops.json");

const MASTER_PATH = process.env.MASTER_JSON || path.join(__dirname, "seed-data", "master-sops.json");

const HOTELS = [
  { id: "hop", name: "Hampton Inn Overland Park", brand: "hilton", system: "pep", setup: "live" },
  { id: "hlm", name: "Hotel Lotus Merriam", brand: "independent", system: "hotelkey", setup: "new" },
  { id: "hls", name: "Hotel Lotus Stadium", brand: "independent", system: "hotelkey", setup: "new" },
];

const CONTACTS = [
  ["AGM", "Huraima Khan", "(913) 235-5320"],
  ["GM", "Akash Patel", "(256) 617-1071"],
  ["COO", "Dhruv Patel", "(903) 522-9972"],
  ["Engineer", "Jerry Thate", "(816) 878-1454"],
  ["Head Housekeeper", "Cindy Thate", "(913) 326-2217"],
];

const { ROUTES } = require("../src/defaults");

// Hampton's answers to the setup questions (what the hotel has today). Applied only where an answer is missing.
const HAMPTON_ANSWERS = { breakfast: true, pool: true, pets: true, laundry: true, market: true, cash: false, rollaways: false, pack_and_plays: false, connecting_rooms: false };
// Detail groups that belong to the yes/no setup questions rather than to an amenity.
const NEW_GROUPS = ["cash", "early_checkin", "rooms_policy"];
// Detail names that were dropped from the master file. Removed from master_details when no master SOP text still uses them.
const OBSOLETE_DETAILS = ["Sofa sleeper room type"];

// Which amenity a Hampton SOP depends on, used only when master-sops.json isn't available.
const FALLBACK_REQUIRES = {
  "GR-06": "breakfast", "CP-11": "breakfast", "HK-08": "breakfast",
  "GR-08": "pool", "PO-09": "pool",
  "PO-01": "pets",
  "GR-09": "laundry",
  "PY-13": "market",
};
const HILTON_ONLY_CATS = new Set(["Hilton Honors and brand standards", "PEP tasks"]);

const prefixOf = (sops) => {
  const out = {};
  for (const s of sops) out[s.cat] = out[s.cat] || s.id.split("-")[0];
  return out;
};

// Basic shape check for the Owner-written master file.
function masterShapeOk(j) {
  if (!j || typeof j !== "object" || !Array.isArray(j.cats) || !j.cats.length) return false;
  if (typeof j.details !== "object" || j.details === null) return false;
  if (typeof j.hampton_details !== "object" || j.hampton_details === null) return false;
  if (!Array.isArray(j.sops) || !j.sops.length) return false;
  return j.sops.every(
    (s) =>
      s && typeof s.id === "string" && typeof s.title === "string" && (s.cat || s.category) &&
      Array.isArray(s.steps) && s.steps.every((x) => x && typeof x === "object" && typeof x.t === "string")
  );
}

function loadMaster() {
  try {
    if (fs.existsSync(MASTER_PATH)) {
      const j = JSON.parse(fs.readFileSync(MASTER_PATH, "utf8"));
      if (masterShapeOk(j)) {
        console.log(`Master library source: ${path.basename(MASTER_PATH)} (${j.sops.length} SOPs).`);
        return normalizeMaster(j);
      }
      console.warn(`${MASTER_PATH} doesn't have the expected shape; deriving the master from hampton-sops.json instead.`);
    }
  } catch (e) {
    console.warn(`Couldn't read ${MASTER_PATH} (${e.message}); deriving the master from hampton-sops.json instead.`);
  }
  console.log("Master library source: derived from hampton-sops.json.");
  return {
    cats: hampton.cats,
    details: [],
    hampton_details: {},
    setup_defaults: {},
    sops: hampton.sops.map((s) => ({
      id: s.id,
      cat: s.cat,
      title: s.title,
      steps: s.steps.map((t) => ({ t, hk: null })),
      script: s.script || "",
      script_hk: null,
      flag: s.flag || "",
      flag_hk: null,
      kw: s.kw || "",
      applies: HILTON_ONLY_CATS.has(s.cat) ? "hilton" : "all",
      requires: FALLBACK_REQUIRES[s.id] || null,
      hk_status: "same",
    })),
  };
}

// Tolerant of small naming differences in the master file (cat/category, kw/keywords).
function normalizeMaster(j) {
  const detailKeys = Array.isArray(j.details)
    ? j.details.map((d) => (typeof d === "string" ? { key: d, example: "", group: null } : { key: d.key || d.name || d.label, example: d.example || d.hint || "", group: d.group || null }))
    : Object.entries(j.details).map(([k, v]) => ({ key: k, example: typeof v === "string" ? v : (v && (v.example || v.hint)) || "", group: (v && v.group) || null }));
  let hd = j.hampton_details;
  if (Array.isArray(hd)) hd = Object.fromEntries(hd.map((d) => [d.key || d.name, d.value]));
  return {
    cats: j.cats.map((c) => (typeof c === "string" ? c : c.name)),
    details: detailKeys.filter((d) => d.key),
    hampton_details: hd || {},
    setup_defaults: j.setup_defaults && typeof j.setup_defaults === "object" ? j.setup_defaults : {},
    sops: j.sops.map((s) => ({
      id: s.id,
      cat: s.cat || s.category,
      title: s.title,
      steps: s.steps.map((x) => ({ t: x.t, hk: x.hk == null || x.hk === "" ? null : x.hk, img: x.img || null })),
      script: s.script || "",
      script_hk: s.script_hk || null,
      flag: s.flag || "",
      flag_hk: s.flag_hk || null,
      kw: s.kw ?? s.keywords ?? "",
      applies: s.applies === "hilton" ? "hilton" : "all",
      requires: ["breakfast", "pool", "pets", "laundry", "market"].includes(s.requires) ? s.requires : null,
      hk_status: ["same", "draft", "approved"].includes(s.hk_status) ? s.hk_status : "same",
    })),
  };
}

(async () => {
  const master = loadMaster();

  await tx(async (c) => {
    // ----- hotels -----
    for (const h of HOTELS) {
      await c.query(
        `INSERT INTO hotels (id, name, ready, brand, system, setup) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [h.id, h.name, h.setup === "live", h.brand, h.system, h.setup]
      );
    }
    // Hampton as it existed before multi-hotel: ready, but with the column defaults. Move it to PEP / Hilton / live once.
    await c.query(
      `UPDATE hotels SET brand='hilton', system='pep', setup='live', ready=TRUE
        WHERE id='hop' AND ready AND setup='new' AND brand='independent' AND system='hotelkey'`
    );

    // ----- master library (only when empty) -----
    const mcount = (await c.query("SELECT count(*)::int AS n FROM master_sops")).rows[0].n;
    if (mcount === 0) {
      const prefixes = prefixOf(master.sops);
      let sort = 0;
      for (const cat of master.cats) {
        await c.query("INSERT INTO master_categories (name, prefix, sort) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [cat, prefixes[cat] || "SOP", sort++]);
      }
      for (const s of master.sops) {
        await c.query(
          `INSERT INTO master_sops (id, category, title, steps, script, script_hk, flag, flag_hk, keywords, applies, requires, hk_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
          [s.id, s.cat, s.title, JSON.stringify(s.steps), s.script, s.script_hk, s.flag, s.flag_hk, s.kw, s.applies, s.requires, s.hk_status]
        );
      }
      let d = 0;
      for (const k of master.details) {
        await c.query("INSERT INTO master_details (key, example, sort, grp) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [k.key, k.example || "", d++, k.group || null]);
      }
      console.log(`Loaded ${master.sops.length} master SOPs.`);
    } else {
      console.log(`Master library already loaded (${mcount}); leaving it as it is.`);
    }
    // Detail names and their group (idempotent): add any that are missing. A group is set where none is set yet,
    // and the newer groups (cash, early check-in, rooms policy) also replace an older group.
    let dsort = (await c.query("SELECT COALESCE(max(sort),-1)+1 AS n FROM master_details")).rows[0].n;
    for (const k of master.details) {
      await c.query(
        `INSERT INTO master_details (key, example, sort, grp) VALUES ($1,$2,$3,$4)
         ON CONFLICT (key) DO UPDATE SET grp = CASE WHEN EXCLUDED.grp = ANY($5::text[]) THEN EXCLUDED.grp ELSE COALESCE(master_details.grp, EXCLUDED.grp) END`,
        [k.key, k.example || "", dsort++, k.group || null, NEW_GROUPS]
      );
    }
    // The wording the setup questions fill in (cash, rollaways, ...). The file is the source of truth.
    if (master.setup_defaults && Object.keys(master.setup_defaults).length) {
      await c.query(
        `INSERT INTO master_meta (key, value) VALUES ('setup_defaults', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(master.setup_defaults)]
      );
    }
    // Drop detail names the master no longer has, if nothing in the master text still uses them.
    const inFile = new Set(master.details.map((k) => k.key));
    for (const key of OBSOLETE_DETAILS) {
      if (inFile.has(key)) continue;
      const used = (await c.query(
        `SELECT 1 FROM master_sops WHERE (steps::text || script || COALESCE(script_hk,'') || flag || COALESCE(flag_hk,'') || title) LIKE $1 LIMIT 1`,
        ["%{" + key + "}%"]
      )).rows.length;
      if (!used) await c.query("DELETE FROM master_details WHERE key=$1", [key]);
    }

    // Master SOPs loaded earlier from an older copy of the file: refresh the wording of the ones nobody has touched
    // (still version 1 and no history), so the Owner's edits are never overwritten.
    {
      const cur = new Map((await c.query(
        `SELECT m.* FROM master_sops m WHERE m.version = 1 AND NOT EXISTS (SELECT 1 FROM master_history h WHERE h.master_id = m.id)`
      )).rows.map((r) => [r.id, r]));
      const norm = (steps) => JSON.stringify((steps || []).map((x) => [x.t, x.hk || null, x.img || null]));
      const changedIds = [];
      for (const s of master.sops) {
        const r = cur.get(s.id);
        if (!r) continue;
        const same = r.category === s.cat && r.title === s.title && norm(r.steps) === norm(s.steps) && r.script === s.script &&
          (r.script_hk || null) === s.script_hk && r.flag === s.flag && (r.flag_hk || null) === s.flag_hk && r.keywords === s.kw &&
          r.applies === s.applies && (r.requires || null) === s.requires;
        if (same) continue;
        const hkSame = norm(r.steps.map((x) => ({ t: "", hk: x.hk }))) === norm(s.steps.map((x) => ({ t: "", hk: x.hk }))) &&
          (r.script_hk || null) === s.script_hk && (r.flag_hk || null) === s.flag_hk;
        await c.query(
          `UPDATE master_sops SET category=$2, title=$3, steps=$4, script=$5, script_hk=$6, flag=$7, flag_hk=$8, keywords=$9, applies=$10, requires=$11,
                  hk_status = CASE WHEN $12 THEN hk_status ELSE $13 END, updated_at = now()
            WHERE id=$1 AND version = 1`,
          [s.id, s.cat, s.title, JSON.stringify(s.steps), s.script, s.script_hk, s.flag, s.flag_hk, s.kw, s.applies, s.requires, hkSame, s.hk_status]
        );
        changedIds.push(s.id);
      }
      if (changedIds.length) console.log(`Refreshed the wording of ${changedIds.length} untouched master SOPs: ${changedIds.join(", ")}.`);
    }

    // ----- Hampton -----
    const hotel = "hop";
    const prefixes = prefixOf(hampton.sops);
    let sort = 0;
    for (const cat of hampton.cats) {
      await c.query(
        "INSERT INTO categories (hotel_id, name, prefix, sort) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [hotel, cat, prefixes[cat] || "SOP", sort++]
      );
    }

    const { rows } = await c.query("SELECT count(*)::int AS n FROM sops WHERE hotel_id=$1", [hotel]);
    if (rows[0].n === 0) {
      for (const s of hampton.sops) {
        await c.query(
          `INSERT INTO sops (hotel_id, id, category, title, steps, script, flag, keywords)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [hotel, s.id, s.cat, s.title, JSON.stringify(s.steps.map((t) => ({ t, img: null }))), s.script, s.flag, s.kw]
        );
      }
      console.log(`Loaded ${hampton.sops.length} SOPs.`);
    } else {
      console.log(`SOPs already loaded (${rows[0].n}); leaving them as they are.`);
    }

    // Hampton's details: the file's values for any detail it doesn't have yet (never overwrites what is there).
    if (master.hampton_details && Object.keys(master.hampton_details).length) {
      const cur = (await c.query("SELECT details FROM hotels WHERE id=$1", [hotel])).rows[0].details || {};
      const add = {};
      for (const [k, v] of Object.entries(master.hampton_details)) if (cur[k] === undefined) add[k] = v;
      if (Object.keys(add).length) {
        await c.query("UPDATE hotels SET details = details || $1::jsonb WHERE id=$2", [JSON.stringify(add), hotel]);
        console.log(`Added ${Object.keys(add).length} missing details to Hampton.`);
      }
      // Hampton's answers to the setup questions, only for the ones it hasn't answered.
      const ans = (await c.query("SELECT answers FROM hotels WHERE id=$1", [hotel])).rows[0].answers || {};
      const addA = {};
      for (const [k, v] of Object.entries(HAMPTON_ANSWERS)) if (ans[k] === undefined) addA[k] = v;
      if (Object.keys(addA).length) await c.query("UPDATE hotels SET answers = COALESCE(answers,'{}'::jsonb) || $1::jsonb WHERE id=$2", [JSON.stringify(addA), hotel]);
    }

    // One-time link of Hampton's copies to the master (skipped once any Hampton SOP is linked, so a
    // hotel-only SOP can never be linked later by an id that the master happens to reuse).
    // SOPs edited locally before the link are marked kept, so a master change shows as an update instead of overwriting them.
    const linked = (await c.query("SELECT 1 FROM sops WHERE hotel_id=$1 AND master_id IS NOT NULL LIMIT 1", [hotel])).rows.length;
    if (!linked) {
      const r = await c.query(
        `UPDATE sops s SET master_id = s.id, master_version = 1, kept = (s.version > 1)
           FROM master_sops m WHERE s.hotel_id=$1 AND s.master_id IS NULL AND m.id = s.id`,
        [hotel]
      );
      console.log(`Linked ${r.rowCount} Hampton SOPs to the master library.`);
    }

    for (const [role, name, phone] of CONTACTS) {
      await c.query(
        "INSERT INTO contacts (hotel_id, role, name, phone) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [hotel, role, name, phone]
      );
    }
    let r = 0;
    for (const [id, label, sub, first, then, joiner] of ROUTES) {
      await c.query(
        `INSERT INTO routes (hotel_id, id, label, sub, first_role, then_role, joiner, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [hotel, id, label, sub, first, then, joiner, r++]
      );
    }

    // ----- first Owner -----
    const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase() || null;
    const username = (process.env.ADMIN_USERNAME || (email ? email.split("@")[0] : ""))
      .trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
    const pw = process.env.ADMIN_PASSWORD || "";
    if (username && pw) {
      const exists = await c.query("SELECT id FROM users WHERE lower(username)=$1 OR ($2::text IS NOT NULL AND email=$2)", [username, email]);
      if (!exists.rows.length) {
        const hash = await bcrypt.hash(pw, 12);
        const u = await c.query(
          `INSERT INTO users (name, username, email, role, password_hash, must_change_pw)
           VALUES ($1,$2,$3,'Owner',$4,TRUE) RETURNING id`,
          [process.env.ADMIN_NAME || "Owner", username, email, hash]
        );
        // Owners see every hotel; the assignment rows are kept for the hotels that exist now.
        for (const h of HOTELS) {
          await c.query("INSERT INTO user_hotels (user_id, hotel_id) VALUES ($1,$2)", [u.rows[0].id, h.id]);
        }
        console.log(`Created Owner ${username}. They must change the password at first sign-in.`);
      }
    } else {
      console.log("ADMIN_USERNAME (or ADMIN_EMAIL) / ADMIN_PASSWORD not set; no Owner account created.");
    }
  });
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
