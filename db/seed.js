// Seeds Hampton Inn Overland Park: hotels, categories, 234 SOPs, contacts, call routes,
// and the first Admin account. Re-running is safe: existing rows are left alone.
const bcrypt = require("bcryptjs");
const { pool, tx } = require("../src/db");
const data = require("./seed-data/hampton-sops.json");

const HOTELS = [
  { id: "hop", name: "Hampton Inn Overland Park", ready: true },
];

const CONTACTS = [
  ["AGM", "Huraima Khan", "(913) 235-5320"],
  ["GM", "Akash Patel", "(256) 617-1071"],
  ["COO", "Dhruv Patel", "(903) 522-9972"],
  ["Engineer", "Jerry Thate", "(816) 878-1454"],
  ["Head Housekeeper", "Cindy Thate", "(913) 326-2217"],
];

const ROUTES = [
  ["guest", "Guest issues", "Complaints, refunds, anything not covered", "AGM", "GM", "then"],
  ["emergency", "Fire or life-threatening", "Call 911 first", "Engineer", "GM", "and"],
  ["housekeeping", "Housekeeping", "Room status, supplies, lost and found", "Head Housekeeper", "AGM", "then"],
];

(async () => {
  await tx(async (c) => {
    for (const h of HOTELS) {
      await c.query(
        "INSERT INTO hotels (id, name, ready) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING",
        [h.id, h.name, h.ready]
      );
    }

    const hotel = "hop";
    const prefixes = {};
    for (const s of data.sops) prefixes[s.cat] = prefixes[s.cat] || s.id.split("-")[0];
    let sort = 0;
    for (const cat of data.cats) {
      await c.query(
        "INSERT INTO categories (hotel_id, name, prefix, sort) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [hotel, cat, prefixes[cat] || "SOP", sort++]
      );
    }

    const { rows } = await c.query("SELECT count(*)::int AS n FROM sops WHERE hotel_id=$1", [hotel]);
    if (rows[0].n === 0) {
      for (const s of data.sops) {
        await c.query(
          `INSERT INTO sops (hotel_id, id, category, title, steps, script, flag, keywords)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [hotel, s.id, s.cat, s.title, JSON.stringify(s.steps.map((t) => ({ t, img: null }))), s.script, s.flag, s.kw]
        );
      }
      console.log(`Loaded ${data.sops.length} SOPs.`);
    } else {
      console.log(`SOPs already loaded (${rows[0].n}); leaving them as they are.`);
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
           VALUES ($1,$2,$3,'Admin',$4,TRUE) RETURNING id`,
          [process.env.ADMIN_NAME || "Admin", username, email, hash]
        );
        for (const h of HOTELS) {
          await c.query("INSERT INTO user_hotels (user_id, hotel_id) VALUES ($1,$2)", [u.rows[0].id, h.id]);
        }
        console.log(`Created Admin ${username}. They must change the password at first sign-in.`);
      }
    } else {
      console.log("ADMIN_USERNAME (or ADMIN_EMAIL) / ADMIN_PASSWORD not set; no Admin account created.");
    }
  });
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
