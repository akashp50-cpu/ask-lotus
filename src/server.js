const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const PgStore = require("connect-pg-simple")(session);
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const { pool, q, tx } = require("./db");
const { best, rank } = require("./match");
const ai = require("./ai");
const { encrypt, decrypt } = require("./crypto");
const { tokKey, forModel } = require("./tokens");
const { ROUTES } = require("./defaults");
const imp = require("./importer");

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production";
if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32) {
  console.error("APP_SECRET must be set to a random string of at least 32 characters.");
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
      },
    },
  })
);
// Import uploads carry base64 documents (3 x 10 MB), so only those two routes get a bigger JSON limit, and only after sign-in.
const jsonSmall = express.json({ limit: "6mb" });
const jsonBig = express.json({ limit: "42mb" });
app.use((req, res, next) => (/^\/api\/import\/(upload|sheet)$/.test(req.path) ? next() : jsonSmall(req, res, next)));
app.use(
  session({
    store: new PgStore({ pool, tableName: "session" }),
    secret: process.env.APP_SECRET,
    name: "asklotus.sid",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 1000 * 60 * 60 * 12 },
  })
);

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, code, msg) => res.status(code).json({ error: msg });
const RANK = { "Front Desk": 0, Manager: 1, GM: 2, Owner: 3 };
const isOwner = (u) => u.role === "Owner";
const isGM = (u) => RANK[u.role] >= RANK.GM; // GM or Owner
const canManage = (u) => RANK[u.role] >= RANK.Manager; // Manager and up
const tempPassword = () => crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 10) + "!7";
const cleanEmail = (e) => String(e || "").trim().toLowerCase();
const cleanUsername = (u) => String(u || "").trim().toLowerCase();
// Returns an error message, or null when the username is acceptable.
const usernameError = (u) =>
  !u ? "Add a username."
  : u.length < 3 || u.length > 32 ? "Username must be 3 to 32 characters."
  : !/^[a-z0-9._-]+$/.test(u) ? "Username can use letters, numbers, dots, dashes and underscores only."
  : null;
// Email is optional: returns an error message only when something was entered and it isn't an email.
const optionalEmailError = (e) => (e && !/^\S+@\S+\.\S+$/.test(e) ? "That email doesn't look right. Leave it blank if they don't have one." : null);

async function loadUser(id) {
  const { rows } = await q(
    `SELECT u.id, u.name, u.username, u.email, u.role, u.status, u.must_change_pw, u.last_seen,
            COALESCE(array_agg(uh.hotel_id) FILTER (WHERE uh.hotel_id IS NOT NULL), '{}') AS hotels
       FROM users u LEFT JOIN user_hotels uh ON uh.user_id = u.id
      WHERE u.id = $1 GROUP BY u.id`,
    [id]
  );
  return rows[0] || null;
}

const allHotelIds = async () => (await q("SELECT id FROM hotels ORDER BY name")).rows.map((r) => r.id);

const auth = (minRole = "Front Desk") =>
  wrap(async (req, res, next) => {
    if (!req.session.uid) return bad(res, 401, "Please sign in.");
    const u = await loadUser(req.session.uid);
    if (!u || u.status !== "active") {
      req.session.destroy(() => {});
      return bad(res, 401, "Your account is turned off. Ask your manager.");
    }
    if (u.must_change_pw && !req.path.startsWith("/api/password") && req.path !== "/api/me") {
      return bad(res, 403, "Set a new password first.");
    }
    if (RANK[u.role] < RANK[minRole]) return bad(res, 403, "You don't have access to that.");
    // The Owner counts as assigned to every hotel.
    if (isOwner(u)) u.hotels = await allHotelIds();
    req.user = u;
    next();
  });

// Which hotel this request is for; the user must be assigned to it.
const hotel = wrap(async (req, res, next) => {
  const h = String(req.query.hotel || req.body?.hotel || req.user.hotels[0] || "");
  if (!req.user.hotels.includes(h)) return bad(res, 403, "You don't have access to that hotel.");
  req.hotel = h;
  next();
});

async function settingsRow() {
  return (await q("SELECT * FROM settings WHERE id=1")).rows[0];
}

function publicSettings(s, full) {
  const base = { showSource: s.show_source, aiOn: !!(s.key_enc && s.provider !== "none") };
  if (!full) return base;
  return {
    ...base,
    provider: s.provider,
    model: s.model,
    baseUrl: s.base_url,
    connected: !!s.key_enc,
    last4: s.key_last4,
    addedBy: s.key_added_by,
    addedAt: s.key_added_at,
    sourceOnly: s.source_only,
    fallback: s.fallback,
    providers: Object.entries(ai.PROVIDERS).map(([id, p]) => ({ id, ...p })),
  };
}

function aiConfig(s) {
  if (!s.key_enc || s.provider === "none") return null;
  try {
    return { provider: s.provider, model: s.model, baseUrl: s.base_url, apiKey: decrypt(s.key_enc) };
  } catch (e) {
    // e.g. APP_SECRET changed since the key was saved: fall back to keyword matching
    console.error("Saved AI key can't be decrypted; re-enter it in Settings.", e.message);
    return null;
  }
}

const hotelRow = async (id) => (await q("SELECT id, name, ready, brand, system, setup, details FROM hotels WHERE id=$1", [id])).rows[0];

const sopOut = (r) => ({
  id: r.id,
  cat: r.category,
  title: r.title,
  steps: r.steps,
  script: r.script,
  flag: r.flag,
  kw: r.keywords,
  status: r.status,
  ver: r.version,
  updated: r.updated_at,
  master: r.master_id || null,
  kept: !!r.kept,
});

// ---------- auth ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

app.post(
  "/api/login",
  loginLimiter,
  wrap(async (req, res) => {
    // Accept {username}; older clients may still send {email}. A value with '@' is matched on email.
    const who = cleanUsername(req.body.username ?? req.body.email);
    const pw = String(req.body.password || "");
    if (!who || !pw) return bad(res, 400, "Enter your username and password.");
    const { rows } = who.includes("@")
      ? await q("SELECT id, password_hash, status FROM users WHERE email=$1", [who])
      : await q("SELECT id, password_hash, status FROM users WHERE lower(username)=$1", [who]);
    const u = rows[0];
    if (!u || !(await bcrypt.compare(pw, u.password_hash))) return bad(res, 401, "That username and password don't match.");
    if (u.status !== "active") return bad(res, 403, "This account is turned off. Ask your manager to turn it back on.");
    await q("UPDATE users SET last_seen=now() WHERE id=$1", [u.id]);
    req.session.regenerate((err) => {
      if (err) return bad(res, 500, "Couldn't start your session. Try again.");
      req.session.uid = u.id;
      res.json({ ok: true });
    });
  })
);

app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get(
  "/api/me",
  auth(),
  wrap(async (req, res) => {
    const hotels = (
      await q("SELECT id, name, ready, brand, system, setup FROM hotels WHERE id = ANY($1) ORDER BY name", [req.user.hotels])
    ).rows;
    res.json({ user: req.user, hotels });
  })
);

app.post(
  "/api/password",
  auth(),
  wrap(async (req, res) => {
    const { current, next } = req.body;
    if (!next || String(next).length < 10) return bad(res, 400, "Use at least 10 characters.");
    const { rows } = await q("SELECT password_hash FROM users WHERE id=$1", [req.user.id]);
    if (!(await bcrypt.compare(String(current || ""), rows[0].password_hash)))
      return bad(res, 400, "Your current password isn't right.");
    await q("UPDATE users SET password_hash=$1, must_change_pw=FALSE WHERE id=$2", [await bcrypt.hash(String(next), 12), req.user.id]);
    res.json({ ok: true });
  })
);

// ---------- staff ----------
app.get(
  "/api/bootstrap",
  auth(),
  hotel,
  wrap(async (req, res) => {
    const mgr = canManage(req.user);
    const [cats, sops, contacts, routes, s, h] = await Promise.all([
      q("SELECT name, prefix FROM categories WHERE hotel_id=$1 ORDER BY sort", [req.hotel]),
      q(`SELECT * FROM sops WHERE hotel_id=$1 ${mgr ? "" : "AND status='live'"} ORDER BY id`, [req.hotel]),
      q("SELECT id, role, name, phone FROM contacts WHERE hotel_id=$1 ORDER BY id", [req.hotel]),
      q("SELECT id, label, sub, first_role AS first, then_role AS then, joiner AS join FROM routes WHERE hotel_id=$1 ORDER BY sort", [req.hotel]),
      settingsRow(),
      hotelRow(req.hotel),
    ]);
    res.json({
      hotel: req.hotel,
      info: { id: h.id, name: h.name, brand: h.brand, system: h.system, setup: h.setup, ready: h.ready },
      details: h.details || {},
      cats: cats.rows,
      sops: sops.rows.map(sopOut),
      contacts: contacts.rows,
      routes: routes.rows,
      settings: publicSettings(s, isOwner(req.user)),
    });
  })
);

app.post(
  "/api/ask",
  auth(),
  hotel,
  wrap(async (req, res) => {
    const question = String(req.body.q || "").trim().slice(0, 500);
    if (!question) return bad(res, 400, "Type a question.");
    const h = await hotelRow(req.hotel);
    if (!h.ready) return bad(res, 400, "This hotel isn't open to staff yet.");
    const sops = (await q("SELECT * FROM sops WHERE hotel_id=$1 AND status='live'", [req.hotel])).rows;
    const contacts = (await q("SELECT role, name, phone FROM contacts WHERE hotel_id=$1", [req.hotel])).rows;
    const s = await settingsRow();
    const cfg = aiConfig(s);
    let sop = null,
      by = "none",
      general = null,
      aiError = null;
    if (cfg) {
      try {
        // The model reads the same text staff would see: tokens filled in, manager notes removed.
        const shortlist = rank(question, sops, 8).map((x) => {
          const m = forModel(x.s, contacts, h.details);
          return { id: m.id, category: m.category, title: m.title, steps: m.steps.map((t) => ({ t })) };
        });
        const out = await ai.pickSop(cfg, question, shortlist, sops, { sourceOnly: s.source_only, hotelName: h.name });
        if (out.sopId) {
          sop = sops.find((x) => x.id === out.sopId);
          by = "ai";
        }
        general = out.general;
      } catch (e) {
        aiError = e.message;
        console.error("AI provider error:", e.message);
        if (s.fallback) {
          sop = best(question, sops);
          if (sop) by = "keyword";
        }
      }
    } else {
      sop = best(question, sops);
      if (sop) by = "keyword";
    }
    // AI answer to the exact question, guided by the matched SOP. Any failure just
    // leaves the SOP card on its own.
    let answer = null;
    if (cfg && sop && !aiError) {
      try {
        answer = await ai.answerFromSop(cfg, question, forModel(sop, contacts, h.details));
      } catch (e) {
        console.error("AI answer error:", e.message);
      }
    }
    const ins = await q(
      "INSERT INTO questions (hotel_id, user_id, question, sop_id, matched_by) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [req.hotel, req.user.id, question, sop ? sop.id : null, by]
    );
    res.json({ logId: ins.rows[0].id, sop: sop ? sopOut(sop) : null, answer, general, aiDown: !!aiError && !sop });
  })
);

app.post(
  "/api/feedback",
  auth(),
  wrap(async (req, res) => {
    const fb = req.body.fb === "n" ? "n" : "y";
    await q("UPDATE questions SET feedback=$1 WHERE id=$2 AND user_id=$3", [fb, req.body.logId, req.user.id]);
    res.json({ ok: true });
  })
);

app.get(
  "/api/images/:id",
  auth(),
  wrap(async (req, res) => {
    const { rows } = await q(
      "SELECT mime, data, hotel_id FROM images WHERE id=$1",
      [req.params.id]
    );
    const img = rows[0];
    if (!img || !req.user.hotels.includes(img.hotel_id)) return res.status(404).end();
    res.set("Content-Type", img.mime).set("Cache-Control", "private, max-age=86400").send(img.data);
  })
);

// ---------- managers ----------
app.post(
  "/api/images",
  auth("Manager"),
  hotel,
  wrap(async (req, res) => {
    const m = String(req.body.dataUrl || "").match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    if (!m) return bad(res, 400, "Upload a JPG, PNG or WebP image.");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 3 * 1024 * 1024) return bad(res, 400, "That image is too large (3 MB max).");
    const id = crypto.randomUUID();
    await q("INSERT INTO images (id, hotel_id, mime, data, created_by) VALUES ($1,$2,$3,$4,$5)", [id, req.hotel, m[1], buf, req.user.id]);
    res.json({ id });
  })
);

function validSop(b) {
  const steps = (Array.isArray(b.steps) ? b.steps : [])
    .map((s) => ({ t: String(s.t || "").trim().slice(0, 1000), img: s.img ? String(s.img) : null }))
    .filter((s) => s.t || s.img);
  return {
    title: String(b.title || "").trim().slice(0, 200),
    cat: String(b.cat || "").trim(),
    steps,
    script: String(b.script || "").trim().slice(0, 1000),
    flag: String(b.flag || "").trim().slice(0, 1000),
    kw: String(b.kw || "").trim().slice(0, 1000),
    status: b.status === "draft" ? "draft" : b.status === "off" ? "off" : "live",
  };
}

app.post(
  "/api/sops",
  auth("Manager"),
  hotel,
  wrap(async (req, res) => {
    const d = validSop(req.body);
    if (d.status === "off" && !isGM(req.user)) d.status = "draft"; // only a GM turns SOPs off
    if (!d.title) return bad(res, 400, "Add a title.");
    if (!d.steps.length) return bad(res, 400, "Add at least one step.");
    const cat = (await q("SELECT prefix FROM categories WHERE hotel_id=$1 AND name=$2", [req.hotel, d.cat])).rows[0];
    if (!cat) return bad(res, 400, "Pick a category.");
    const out = await tx(async (c) => {
      const { rows } = await c.query(
        "SELECT id FROM sops WHERE hotel_id=$1 AND id LIKE $2 FOR UPDATE",
        [req.hotel, cat.prefix + "-%"]
      );
      const n = Math.max(0, ...rows.map((r) => parseInt(r.id.split("-")[1], 10) || 0)) + 1;
      const id = `${cat.prefix}-${String(n).padStart(2, "0")}`;
      const r = await c.query(
        `INSERT INTO sops (hotel_id, id, category, title, steps, script, flag, keywords, status, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.hotel, id, d.cat, d.title, JSON.stringify(d.steps), d.script, d.flag, d.kw, d.status, req.user.id]
      );
      return r.rows[0];
    });
    res.json(sopOut(out));
  })
);

app.put(
  "/api/sops/:id",
  auth("Manager"),
  hotel,
  wrap(async (req, res) => {
    const d = validSop(req.body);
    if (!d.title) return bad(res, 400, "Add a title.");
    if (!d.steps.length) return bad(res, 400, "Add at least one step.");
    const out = await tx(async (c) => {
      const cur = (await c.query("SELECT * FROM sops WHERE hotel_id=$1 AND id=$2 FOR UPDATE", [req.hotel, req.params.id])).rows[0];
      if (!cur) return null;
      if (d.status === "off" && cur.status !== "off" && !isGM(req.user)) d.status = "draft";
      // Only a change to the wording marks a master-linked copy as "kept"; switching it on or off does not.
      const norm = (x) => JSON.stringify([x.title, x.cat ?? x.category, (x.steps || []).map((t) => [t.t || "", t.img || null]), x.script || "", x.flag || "", x.kw ?? x.keywords ?? ""]);
      const contentChanged = norm({ ...d, cat: d.cat || cur.category }) !== norm({ ...cur, cat: cur.category });
      await c.query("INSERT INTO sop_history (hotel_id, sop_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4,$5)", [
        req.hotel, cur.id, cur.version, JSON.stringify(sopOut(cur)), req.user.id,
      ]);
      const r = await c.query(
        `UPDATE sops SET category=$3, title=$4, steps=$5, script=$6, flag=$7, keywords=$8, status=$9,
                version=version+1, updated_at=now(), updated_by=$10,
                kept = (kept OR ($11 AND master_id IS NOT NULL))
          WHERE hotel_id=$1 AND id=$2 RETURNING *`,
        [req.hotel, req.params.id, d.cat || cur.category, d.title, JSON.stringify(d.steps), d.script, d.flag, d.kw, d.status, req.user.id, contentChanged]
      );
      return r.rows[0];
    });
    if (!out) return bad(res, 404, "That SOP no longer exists.");
    res.json(sopOut(out));
  })
);

app.delete(
  "/api/sops/:id",
  auth("Manager"),
  hotel,
  wrap(async (req, res) => {
    const cur = (await q("SELECT * FROM sops WHERE hotel_id=$1 AND id=$2", [req.hotel, req.params.id])).rows[0];
    if (!cur) return bad(res, 404, "That SOP no longer exists.");
    await q("INSERT INTO sop_history (hotel_id, sop_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4,$5)", [
      req.hotel, cur.id, cur.version, JSON.stringify({ ...sopOut(cur), deleted: true }), req.user.id,
    ]);
    await q("DELETE FROM sops WHERE hotel_id=$1 AND id=$2", [req.hotel, req.params.id]);
    res.json({ ok: true });
  })
);

app.get(
  "/api/activity",
  auth("Manager"),
  hotel,
  wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT qn.id, qn.user_id AS uid, u.name AS user_name, qn.question AS q, qn.sop_id AS sop,
              qn.matched_by, qn.feedback AS fb, qn.dismissed, qn.asked_at AS "when"
         FROM questions qn LEFT JOIN users u ON u.id = qn.user_id
        WHERE qn.hotel_id=$1 AND qn.asked_at > now() - interval '90 days'
        ORDER BY qn.asked_at DESC LIMIT 2000`,
      [req.hotel]
    );
    res.json(rows);
  })
);

app.post(
  "/api/activity/:id/dismiss",
  auth("Manager"),
  hotel,
  wrap(async (req, res) => {
    await q("UPDATE questions SET dismissed=TRUE WHERE id=$1 AND hotel_id=$2", [req.params.id, req.hotel]);
    res.json({ ok: true });
  })
);

// ----- team -----
app.get(
  "/api/users",
  auth("Manager"),
  wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT u.id, u.name, u.username, u.email, u.role, u.status, u.must_change_pw, u.last_seen,
              COALESCE(array_agg(uh.hotel_id) FILTER (WHERE uh.hotel_id IS NOT NULL), '{}') AS hotels
         FROM users u LEFT JOIN user_hotels uh ON uh.user_id=u.id
        GROUP BY u.id ORDER BY u.name`
    );
    // Everyone but the Owner sees only people who share at least one of their hotels.
    const visible = isOwner(req.user) ? rows : rows.filter((u) => u.hotels.some((h) => req.user.hotels.includes(h)));
    res.json(visible);
  })
);

// Who can hand out which role. Owner: anything. GM: up to GM. Manager: Front Desk and Manager.
const GRANTABLE = {
  Owner: ["Front Desk", "Manager", "GM", "Owner"],
  GM: ["Front Desk", "Manager", "GM"],
  Manager: ["Front Desk", "Manager"],
};
const canGrant = (u, role) => (GRANTABLE[u.role] || []).includes(role);
const sharesHotel = (u, target) => isOwner(u) || (target.hotels || []).some((h) => u.hotels.includes(h));

function checkUserEdit(req, target, body) {
  const role = body.role;
  if (!RANK.hasOwnProperty(role)) return "Pick a role.";
  if (target && !canGrant(req.user, target.role))
    return target.role === "Owner" ? "Only an Owner can manage Owner accounts." : `You can't manage ${target.role} accounts.`;
  if (!canGrant(req.user, role)) return role === "Owner" ? "Only an Owner can make someone an Owner." : `You can't give the ${role} role.`;
  if (target && !sharesHotel(req.user, target)) return "That person isn't at one of your hotels.";
  const hotels = Array.isArray(body.hotels) ? body.hotels.map(String) : [];
  if (!hotels.length) return "Pick at least one hotel.";
  if (hotels.some((h) => !req.user.hotels.includes(h))) return "You can only assign hotels you have access to.";
  return null;
}

app.post(
  "/api/users",
  auth("Manager"),
  wrap(async (req, res) => {
    const name = String(req.body.name || "").trim();
    const username = cleanUsername(req.body.username);
    const email = cleanEmail(req.body.email) || null;
    if (!name) return bad(res, 400, "Add their name.");
    const uerr = usernameError(username) || optionalEmailError(email);
    if (uerr) return bad(res, 400, uerr);
    const err = checkUserEdit(req, null, req.body);
    if (err) return bad(res, 400, err);
    if ((await q("SELECT 1 FROM users WHERE lower(username)=$1", [username])).rows.length) return bad(res, 400, "That username is taken.");
    if (email && (await q("SELECT 1 FROM users WHERE email=$1", [email])).rows.length) return bad(res, 400, "Someone already uses that email.");
    const pw = tempPassword();
    const id = await tx(async (c) => {
      const r = await c.query(
        "INSERT INTO users (name, username, email, role, password_hash, must_change_pw) VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id",
        [name, username, email, req.body.role, await bcrypt.hash(pw, 12)]
      );
      for (const h of req.body.hotels) await c.query("INSERT INTO user_hotels VALUES ($1,$2)", [r.rows[0].id, h]);
      return r.rows[0].id;
    });
    res.json({ id, tempPassword: pw });
  })
);

app.put(
  "/api/users/:id",
  auth("Manager"),
  wrap(async (req, res) => {
    const target = await loadUser(req.params.id);
    if (!target) return bad(res, 404, "That person no longer exists.");
    const err = checkUserEdit(req, target, req.body);
    if (err) return bad(res, 400, err);
    const name = String(req.body.name || "").trim();
    const username = cleanUsername(req.body.username);
    const email = cleanEmail(req.body.email) || null;
    if (!name) return bad(res, 400, "Add their name.");
    const uerr = usernameError(username) || optionalEmailError(email);
    if (uerr) return bad(res, 400, uerr);
    if ((await q("SELECT 1 FROM users WHERE lower(username)=$1 AND id<>$2", [username, target.id])).rows.length)
      return bad(res, 400, "That username is taken.");
    if (email && (await q("SELECT 1 FROM users WHERE email=$1 AND id<>$2", [email, target.id])).rows.length)
      return bad(res, 400, "Someone already uses that email.");
    const self = target.id === req.user.id;
    const status = self ? "active" : req.body.status === "off" ? "off" : "active";
    if (self && req.body.role !== req.user.role) return bad(res, 400, "You can't change your own role.");
    await tx(async (c) => {
      await c.query("UPDATE users SET name=$1, username=$2, email=$3, role=$4, status=$5 WHERE id=$6", [name, username, email, req.body.role, status, target.id]);
      // Keep hotels the editor can't see; replace the ones they can.
      await c.query("DELETE FROM user_hotels WHERE user_id=$1 AND hotel_id = ANY($2)", [target.id, req.user.hotels]);
      for (const h of req.body.hotels) await c.query("INSERT INTO user_hotels VALUES ($1,$2) ON CONFLICT DO NOTHING", [target.id, h]);
    });
    if (status === "off") await q(`DELETE FROM "session" WHERE (sess->>'uid')::int = $1`, [target.id]);
    res.json({ ok: true });
  })
);

app.post(
  "/api/users/:id/reset",
  auth("Manager"),
  wrap(async (req, res) => {
    const target = await loadUser(req.params.id);
    if (!target) return bad(res, 404, "That person no longer exists.");
    if (!canGrant(req.user, target.role)) return bad(res, 403, target.role === "Owner" ? "Only an Owner can reset an Owner." : `You can't manage ${target.role} accounts.`);
    if (!sharesHotel(req.user, target)) return bad(res, 403, "That person isn't at one of your hotels.");
    const pw = tempPassword();
    await q("UPDATE users SET password_hash=$1, must_change_pw=TRUE WHERE id=$2", [await bcrypt.hash(pw, 12), target.id]);
    await q(`DELETE FROM "session" WHERE (sess->>'uid')::int = $1`, [target.id]);
    res.json({ tempPassword: pw });
  })
);

// ----- contacts and call routes -----
const cleanPhone = (p) => String(p || "").trim();
app.post(
  "/api/contacts",
  auth("Manager"),
  hotel,
  wrap(async (req, res) => {
    const { role, name } = req.body;
    const phone = cleanPhone(req.body.phone);
    if (!String(role || "").trim()) return bad(res, 400, "Add the role.");
    if (!String(name || "").trim()) return bad(res, 400, "Add their name.");
    if (phone.replace(/\D/g, "").length < 10) return bad(res, 400, "Enter a 10-digit phone number.");
    try {
      const r = await q("INSERT INTO contacts (hotel_id, role, name, phone) VALUES ($1,$2,$3,$4) RETURNING id", [
        req.hotel, role.trim(), name.trim(), phone,
      ]);
      res.json({ id: r.rows[0].id });
    } catch (e) {
      if (e.code === "23505") return bad(res, 400, "That role already exists.");
      throw e;
    }
  })
);

app.put(
  "/api/contacts/:id",
  auth("Manager"),
  hotel,
  wrap(async (req, res) => {
    const role = String(req.body.role || "").trim();
    const name = String(req.body.name || "").trim();
    const phone = cleanPhone(req.body.phone);
    if (!role || !name) return bad(res, 400, "Add the role and name.");
    if (phone.replace(/\D/g, "").length < 10) return bad(res, 400, "Enter a 10-digit phone number.");
    try {
      await tx(async (c) => {
        const cur = (await c.query("SELECT role FROM contacts WHERE id=$1 AND hotel_id=$2", [req.params.id, req.hotel])).rows[0];
        if (!cur) throw Object.assign(new Error("gone"), { status: 404 });
        await c.query("UPDATE contacts SET role=$1, name=$2, phone=$3 WHERE id=$4", [role, name, phone, req.params.id]);
        if (cur.role !== role) {
          await c.query("UPDATE routes SET first_role=$1 WHERE hotel_id=$2 AND first_role=$3", [role, req.hotel, cur.role]);
          await c.query("UPDATE routes SET then_role=$1 WHERE hotel_id=$2 AND then_role=$3", [role, req.hotel, cur.role]);
        }
      });
      res.json({ ok: true });
    } catch (e) {
      if (e.status === 404) return bad(res, 404, "That contact no longer exists.");
      if (e.code === "23505") return bad(res, 400, "That role already exists.");
      throw e;
    }
  })
);

app.delete(
  "/api/contacts/:id",
  auth("Manager"),
  hotel,
  wrap(async (req, res) => {
    const cur = (await q("SELECT role FROM contacts WHERE id=$1 AND hotel_id=$2", [req.params.id, req.hotel])).rows[0];
    if (!cur) return bad(res, 404, "That contact no longer exists.");
    const used = (await q("SELECT label FROM routes WHERE hotel_id=$1 AND first_role=$2", [req.hotel, cur.role])).rows[0];
    if (used) return bad(res, 400, `Pick someone else for "${used.label}" first.`);
    await q("UPDATE routes SET then_role='' WHERE hotel_id=$1 AND then_role=$2", [req.hotel, cur.role]);
    await q("DELETE FROM contacts WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  })
);

app.put(
  "/api/routes/:id",
  auth("Manager"),
  hotel,
  wrap(async (req, res) => {
    const field = req.body.field === "then" ? "then_role" : "first_role";
    const value = String(req.body.value || "");
    if (field === "first_role" && !value) return bad(res, 400, "Pick who to call first.");
    if (value && !(await q("SELECT 1 FROM contacts WHERE hotel_id=$1 AND role=$2", [req.hotel, value])).rows.length)
      return bad(res, 400, "That role doesn't exist.");
    await q(`UPDATE routes SET ${field}=$1 WHERE hotel_id=$2 AND id=$3`, [value, req.hotel, req.params.id]);
    res.json({ ok: true });
  })
);

// ---------- hotel details (GM and up) ----------
// Cleans a {name: value} map: trimmed, capped, blanks dropped (or, when keepBlank, kept as "" so a merge can clear them).
function cleanDetails(src, keepBlank) {
  const out = {};
  for (const [k, v] of Object.entries(src && typeof src === "object" ? src : {})) {
    const key = String(k).trim().slice(0, 80);
    const val = String(v ?? "").trim().slice(0, 500);
    if (key && (val || keepBlank)) out[key] = val;
  }
  return out;
}
// Applies incoming values onto the saved ones: a blank value clears that detail.
function mergeDetails(cur, incoming) {
  const out = { ...(cur || {}) };
  for (const [k, v] of Object.entries(incoming)) {
    const existing = Object.keys(out).find((x) => tokKey(x) === tokKey(k)) || k;
    if (v) out[existing] = v; else delete out[existing];
  }
  return out;
}

// Replaces the hotel's details; with {merge: true} only the details sent are changed (blank clears one).
app.put(
  "/api/hotel/details",
  auth("GM"),
  hotel,
  wrap(async (req, res) => {
    const merge = req.body.merge === true;
    const incoming = cleanDetails(req.body.details, merge);
    let out = incoming;
    if (merge) {
      const cur = (await q("SELECT details FROM hotels WHERE id=$1", [req.hotel])).rows[0].details || {};
      out = mergeDetails(cur, incoming);
    }
    await q("UPDATE hotels SET details=$1 WHERE id=$2", [JSON.stringify(out), req.hotel]);
    res.json({ details: out });
  })
);

// After go-live: the same yes/no detail questions as setup. They fill in details only; they never switch SOPs on or off.
app.put(
  "/api/hotel/answers",
  auth("GM"),
  hotel,
  wrap(async (req, res) => {
    const given = req.body.answers && typeof req.body.answers === "object" ? req.body.answers : {};
    const sdef = await setupDefaults();
    const out = await tx(async (c) => {
      const h = (await c.query("SELECT id, answers, details FROM hotels WHERE id=$1 FOR UPDATE", [req.hotel])).rows[0];
      const old = h.answers && typeof h.answers === "object" ? h.answers : {};
      let details = { ...(h.details || {}) };
      const patch = {};
      for (const k of DETAIL_QS) {
        if (given[k] === undefined) continue;
        const yes = !!given[k];
        if (old[k] === undefined || !!old[k] !== yes) details = applyQuestionDefaults(details, k, yes, sdef);
        patch[k] = yes;
      }
      if (!Object.keys(patch).length) return { answers: {}, details };
      await c.query("UPDATE hotels SET answers = COALESCE(answers,'{}'::jsonb) || $2::jsonb, details=$3 WHERE id=$1", [h.id, JSON.stringify(patch), JSON.stringify(details)]);
      return { answers: patch, details };
    });
    res.json(out);
  })
);

// ---------- master library (Owner) ----------
const AMENITIES = ["breakfast", "pool", "pets", "laundry", "market"];

const masterOut = (r) => ({
  id: r.id,
  cat: r.category,
  title: r.title,
  steps: r.steps,
  script: r.script,
  script_hk: r.script_hk,
  flag: r.flag,
  flag_hk: r.flag_hk,
  kw: r.keywords,
  applies: r.applies,
  requires: r.requires,
  hk_status: r.hk_status,
  status: r.status || "live",
  ver: r.version,
  updated: r.updated_at,
});

const nullIfBlank = (x, max) => {
  const t = String(x ?? "").trim().slice(0, max);
  return t ? t : null;
};

function validMaster(b) {
  const steps = (Array.isArray(b.steps) ? b.steps : [])
    .map((s) => ({ t: String(s.t || "").trim().slice(0, 1000), hk: nullIfBlank(s.hk, 1000), img: s.img ? String(s.img) : null }))
    .filter((s) => s.t || s.img);
  return {
    title: String(b.title || "").trim().slice(0, 200),
    cat: String(b.cat || "").trim(),
    steps,
    script: String(b.script || "").trim().slice(0, 1000),
    script_hk: nullIfBlank(b.script_hk, 1000),
    flag: String(b.flag || "").trim().slice(0, 1000),
    flag_hk: nullIfBlank(b.flag_hk, 1000),
    kw: String(b.kw || "").trim().slice(0, 1000),
    applies: b.applies === "hilton" ? "hilton" : "all",
    requires: AMENITIES.includes(b.requires) ? b.requires : null,
  };
}

// The part of a master SOP that is HotelKey-specific, to tell when its wording changed.
const hkSig = (steps, scriptHk, flagHk) => JSON.stringify([(steps || []).map((s) => s.hk || null), scriptHk || null, flagHk || null]);
const hasHk = (steps, scriptHk, flagHk) => (steps || []).some((s) => s.hk) || !!scriptHk || !!flagHk;

app.get(
  "/api/master",
  auth("Owner"),
  wrap(async (req, res) => {
    const [cats, sops, dk, roles] = await Promise.all([
      q("SELECT name, prefix FROM master_categories ORDER BY sort"),
      q("SELECT * FROM master_sops ORDER BY id"),
      q("SELECT key, example FROM master_details ORDER BY sort, key"),
      q("SELECT DISTINCT role FROM contacts"),
    ]);
    // Detail names = the ones the master file lists plus any {Token} used in SOP text that isn't a contact role.
    const contactRoles = new Set(roles.rows.map((r) => tokKey(r.role)));
    const uses = {};
    for (const s of sops.rows) {
      const text = JSON.stringify([s.steps, s.script, s.script_hk, s.flag, s.flag_hk]);
      for (const m of text.matchAll(/\{([^{}"\\]+)\}/g)) {
        const k = m[1].trim();
        if (!contactRoles.has(tokKey(k))) uses[k] = (uses[k] || 0) + 1;
      }
    }
    const details = dk.rows.map((d) => ({ key: d.key, example: d.example, uses: uses[d.key] || 0 }));
    for (const k of Object.keys(uses)) if (!details.some((d) => tokKey(d.key) === tokKey(k))) details.push({ key: k, example: "", uses: uses[k] });
    res.json({ cats: cats.rows, details, sops: sops.rows.map(masterOut) });
  })
);

app.put(
  "/api/master/:id",
  auth("Owner"),
  wrap(async (req, res) => {
    const d = validMaster(req.body);
    if (!d.title) return bad(res, 400, "Add a title.");
    if (!d.steps.length) return bad(res, 400, "Add at least one step.");
    const out = await tx(async (c) => {
      const cur = (await c.query("SELECT * FROM master_sops WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
      if (!cur) return null;
      const cat = d.cat || cur.category;
      if (!(await c.query("SELECT 1 FROM master_categories WHERE name=$1", [cat])).rows.length) throw Object.assign(new Error("cat"), { status: 400 });
      let hk = cur.hk_status;
      if (!hasHk(d.steps, d.script_hk, d.flag_hk)) hk = "same";
      else if (hkSig(d.steps, d.script_hk, d.flag_hk) !== hkSig(cur.steps, cur.script_hk, cur.flag_hk) || cur.hk_status === "same") hk = "draft";
      await c.query("INSERT INTO master_history (master_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4)", [
        cur.id, cur.version, JSON.stringify(cur), req.user.id,
      ]);
      const r = await c.query(
        `UPDATE master_sops SET category=$2, title=$3, steps=$4, script=$5, script_hk=$6, flag=$7, flag_hk=$8, keywords=$9,
                applies=$10, requires=$11, hk_status=$12, version=version+1, updated_at=now(), updated_by=$13
          WHERE id=$1 RETURNING *`,
        [cur.id, cat, d.title, JSON.stringify(d.steps), d.script, d.script_hk, d.flag, d.flag_hk, d.kw, d.applies, d.requires, hk, req.user.id]
      );
      return r.rows[0];
    }).catch((e) => (e.status === 400 ? "badcat" : Promise.reject(e)));
    if (out === "badcat") return bad(res, 400, "Pick a category.");
    if (!out) return bad(res, 404, "That master SOP no longer exists.");
    const n = (await q("SELECT count(DISTINCT hotel_id)::int AS n FROM sops WHERE master_id=$1 AND master_version < $2", [out.id, out.version])).rows[0].n;
    res.json({ ...masterOut(out), hotelsWithUpdate: n });
  })
);

app.post(
  "/api/master",
  auth("Owner"),
  wrap(async (req, res) => {
    const d = validMaster(req.body);
    if (!d.title) return bad(res, 400, "Add a title.");
    if (!d.steps.length) return bad(res, 400, "Add at least one step.");
    const cat = (await q("SELECT prefix FROM master_categories WHERE name=$1", [d.cat])).rows[0];
    if (!cat) return bad(res, 400, "Pick a category.");
    const out = await tx(async (c) => {
      await c.query("LOCK TABLE master_sops IN SHARE ROW EXCLUSIVE MODE");
      // Next number across the master and every hotel's copies, so a hotel-only SOP never clashes later.
      const { rows } = await c.query(
        `SELECT id FROM master_sops WHERE id LIKE $1 UNION SELECT id FROM sops WHERE id LIKE $1`,
        [cat.prefix + "-%"]
      );
      const n = Math.max(0, ...rows.map((r) => parseInt(r.id.split("-")[1], 10) || 0)) + 1;
      const id = `${cat.prefix}-${String(n).padStart(2, "0")}`;
      const r = await c.query(
        `INSERT INTO master_sops (id, category, title, steps, script, script_hk, flag, flag_hk, keywords, applies, requires, hk_status, updated_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft') RETURNING *`,
        [id, d.cat, d.title, JSON.stringify(d.steps), d.script, d.script_hk, d.flag, d.flag_hk, d.kw, d.applies, d.requires,
          hasHk(d.steps, d.script_hk, d.flag_hk) ? "draft" : "same", req.user.id]
      );
      return r.rows[0];
    });
    res.json(masterOut(out));
  })
);

app.post(
  "/api/master/:id/approve-hk",
  auth("Owner"),
  wrap(async (req, res) => {
    const r = await q("UPDATE master_sops SET hk_status='approved' WHERE id=$1 AND hk_status='draft' RETURNING *", [req.params.id]);
    if (!r.rows.length) {
      const cur = (await q("SELECT * FROM master_sops WHERE id=$1", [req.params.id])).rows[0];
      if (!cur) return bad(res, 404, "That master SOP no longer exists.");
      return res.json(masterOut(cur)); // nothing to approve
    }
    res.json(masterOut(r.rows[0]));
  })
);

// Offer a draft master SOP to hotels (they see it as "New from Lotus"). Not reversible from the app: once hotels copy it, it is theirs to switch off.
app.post(
  "/api/master/:id/publish",
  auth("Owner"),
  wrap(async (req, res) => {
    const r = await q("UPDATE master_sops SET status='live', updated_at=now(), updated_by=$2 WHERE id=$1 AND status='draft' RETURNING *", [req.params.id, req.user.id]);
    if (!r.rows.length) {
      const cur = (await q("SELECT * FROM master_sops WHERE id=$1", [req.params.id])).rows[0];
      if (!cur) return bad(res, 404, "That master SOP no longer exists.");
      return res.json(masterOut(cur)); // already published
    }
    res.json(masterOut(r.rows[0]));
  })
);

// ---------- updates from the master (GM and up) ----------
// What a hotel copy would look like if rebuilt from a master row: the hotel's system picks the HotelKey wording or the default.
// A step (or script/flag) whose chosen text is exactly SKIP_TEXT is left out at that hotel.
const SKIP_TEXT = "Skip this step at this hotel.";
function variantOf(m, system) {
  const pick = (t, hk) => (system === "hotelkey" && hk != null && hk !== "" ? hk : t);
  const one = (t, hk) => { const x = pick(t, hk); return x === SKIP_TEXT ? "" : x; };
  return {
    title: m.title,
    category: m.category,
    steps: (m.steps || [])
      .map((x) => ({ t: pick(x.t, x.hk), img: x.img || null }))
      .filter((x) => x.t !== SKIP_TEXT),
    script: one(m.script, m.script_hk),
    flag: one(m.flag, m.flag_hk),
    keywords: m.keywords,
  };
}
const FIELD_NAMES = { title: "title", category: "category", steps: "steps", script: "script", flag: "flag", keywords: "keywords" };

// SOPs at a hotel whose master has moved on (master_version < master.version).
async function pendingUpdates(hotelId) {
  const { rows } = await q(
    `SELECT s.id, s.title, s.status, s.kept, s.master_id, s.master_version AS have,
            m.version AS latest, m.title AS master_title, m.updated_at AS master_updated,
            to_jsonb(m) AS cur, h.system
       FROM sops s
       JOIN master_sops m ON m.id = s.master_id
       JOIN hotels h ON h.id = s.hotel_id
      WHERE s.hotel_id = $1 AND s.master_version < m.version
      ORDER BY s.id`,
    [hotelId]
  );
  const out = [];
  for (const r of rows) {
    const hist = (await q("SELECT snapshot FROM master_history WHERE master_id=$1 AND version=$2 ORDER BY id DESC LIMIT 1", [r.master_id, r.have])).rows[0];
    let changed = [];
    let relevant = true;
    if (hist) {
      const a = variantOf(hist.snapshot, r.system), b = variantOf(r.cur, r.system);
      changed = Object.keys(FIELD_NAMES).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      relevant = changed.length > 0;
    }
    out.push({
      sopId: r.id, title: r.title, masterTitle: r.master_title, status: r.status, kept: r.kept,
      have: r.have, latest: r.latest, changed, relevant, updated: r.master_updated,
    });
  }
  return out;
}

// Copies a master step's photo into the hotel so the hotel owns it (images are scoped per hotel).
async function ownImages(c, steps, hotelId) {
  const out = [];
  for (const s of steps) {
    let img = s.img || null;
    if (img) {
      const row = (await c.query("SELECT hotel_id, mime, data FROM images WHERE id=$1", [img])).rows[0];
      if (!row) img = null;
      else if (row.hotel_id !== hotelId) {
        img = crypto.randomUUID();
        await c.query("INSERT INTO images (id, hotel_id, mime, data, created_by) VALUES ($1,$2,$3,$4,NULL)", [img, hotelId, row.mime, row.data]);
      }
    }
    out.push({ t: s.t, img });
  }
  return out;
}

// Makes sure the hotel has a category (named like the master's), appended at the end.
async function ensureCategory(c, hotelId, name) {
  if ((await c.query("SELECT 1 FROM categories WHERE hotel_id=$1 AND name=$2", [hotelId, name])).rows.length) return;
  const mc = (await c.query("SELECT prefix, sort FROM master_categories WHERE name=$1", [name])).rows[0];
  const mx = (await c.query("SELECT COALESCE(max(sort),-1)+1 AS n FROM categories WHERE hotel_id=$1", [hotelId])).rows[0].n;
  await c.query("INSERT INTO categories (hotel_id, name, prefix, sort) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [hotelId, name, mc ? mc.prefix : "SOP", mx]);
}

app.get(
  "/api/updates",
  auth("GM"),
  hotel,
  wrap(async (req, res) => {
    res.json(await pendingUpdates(req.hotel));
  })
);

// Load a hotel copy that is behind its master, locked for the update.
async function lockUpdatable(c, hotelId, sopId) {
  const sop = (await c.query("SELECT * FROM sops WHERE hotel_id=$1 AND id=$2 AND master_id IS NOT NULL FOR UPDATE", [hotelId, sopId])).rows[0];
  if (!sop) return { err: [404, "That SOP isn't linked to the master library."] };
  const m = (await c.query("SELECT * FROM master_sops WHERE id=$1", [sop.master_id])).rows[0];
  if (!m) return { err: [404, "The master SOP no longer exists."] };
  if (sop.master_version >= m.version) return { err: [400, "That SOP is already up to date."] };
  return { sop, m };
}

app.post(
  "/api/updates/:sopId/accept",
  auth("GM"),
  hotel,
  wrap(async (req, res) => {
    const out = await tx(async (c) => {
      const { sop, m, err } = await lockUpdatable(c, req.hotel, req.params.sopId);
      if (err) return { err };
      const sys = (await c.query("SELECT system FROM hotels WHERE id=$1", [req.hotel])).rows[0].system;
      const v = variantOf(m, sys);
      await ensureCategory(c, req.hotel, v.category);
      await c.query("INSERT INTO sop_history (hotel_id, sop_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4,$5)", [
        req.hotel, sop.id, sop.version, JSON.stringify(sopOut(sop)), req.user.id,
      ]);
      const steps = await ownImages(c, v.steps, req.hotel);
      const r = await c.query(
        `UPDATE sops SET category=$3, title=$4, steps=$5, script=$6, flag=$7, keywords=$8,
                version=version+1, updated_at=now(), updated_by=$9, master_version=$10, kept=FALSE
          WHERE hotel_id=$1 AND id=$2 RETURNING *`,
        [req.hotel, sop.id, v.category, v.title, JSON.stringify(steps), v.script, v.flag, v.keywords, req.user.id, m.version]
      );
      return { row: r.rows[0] };
    });
    if (out.err) return bad(res, out.err[0], out.err[1]);
    res.json(sopOut(out.row));
  })
);

app.post(
  "/api/updates/:sopId/keep",
  auth("GM"),
  hotel,
  wrap(async (req, res) => {
    const out = await tx(async (c) => {
      const { sop, m, err } = await lockUpdatable(c, req.hotel, req.params.sopId);
      if (err) return { err };
      const r = await c.query("UPDATE sops SET master_version=$3, kept=TRUE WHERE hotel_id=$1 AND id=$2 RETURNING *", [req.hotel, sop.id, m.version]);
      return { row: r.rows[0] };
    });
    if (out.err) return bad(res, out.err[0], out.err[1]);
    res.json(sopOut(out.row));
  })
);

// ---------- setup, hotel home and SOP switches (GM and up) ----------
const NOT_OFFERED = "not offered at this hotel";
// Yes/no setup questions that only fill in hotel details (they never switch SOPs on or off). Their wording comes from setup_defaults.
const DETAIL_QS = ["cash", "rollaways", "pack_and_plays", "connecting_rooms"];
const DETAIL_GROUP_TITLE = { cash: "Payments & cash", early_checkin: "Early check-in", rooms_policy: "Rooms & bedding" };
const AMEN_TITLE = { breakfast: "Breakfast", pool: "Pool", pets: "Pets", laundry: "Laundry", market: "Market" };
// How the general (non-amenity) details are grouped on screen. Anything not listed falls under "Other details".
const DETAIL_SECTION = {};
[
  ["Hotel identity", ["Hotel name", "Hotel short name", "Hotel welcome name", "Hotel location check", "State", "Hotel code"]],
  ["Timing & policies", ["Check-in time", "Check-out time", "Late check-out cutoff", "Entrance lock time", "Parking pass days", "Smoking fee", "Debit hold amount", "Quiet hours", "Visitor policy", "Occupancy limit", "Weapons policy"]],
  ["Rooms", ["Accessible rooms", "Accessible room list", "Hearing kit location", "Room type 1", "Room type 2", "Room type 3", "Room type 4", "Room type 5", "Room type 6", "Room type 7", "Fridge and microwave rooms", "Sofa sleeper rooms"]],
  ["Payments & cash", ["Cash policy", "Cash payment step", "Cash payment script", "Cash deposit step", "Shop payment step", "Starting cash note", "Card machine down cash step"]],
  ["Early check-in", ["Early check-in cutoff", "Early check-in occupancy limit", "Early check-in fee"]],
  ["Rooms & bedding", ["Rollaway policy", "Rollaway script", "Rollaway crib script", "Pack-and-play policy", "Connecting rooms policy", "Connecting rooms script"]],
  ["Supplies & storage", ["Coffee supplies storage", "Fridge and microwave storage", "Toiletries storage", "Pillow storage", "Crib storage", "Cribs on hand", "Bath amenities storage", "Audit envelope drop-off"]],
  ["Tools & systems", ["Wi-Fi network", "Wi-Fi network name", "ID scanner", "DNR system", "Card authorization tool", "Log book app", "Key system", "Manual key steps", "Housekeeping chat app"]],
].forEach(([sec, keys]) => keys.forEach((k) => (DETAIL_SECTION[k] = sec)));

// The plan's rule: a master SOP is suggested ON when (applies all, or the hotel is Hilton) and (no amenity needed, or the hotel has it).
const fitsBrand = (m, brand) => m.applies === "all" || brand === "hilton";
const suggestedOn = (m, brand, amen) => fitsBrand(m, brand) && (!m.requires || !!amen[m.requires]);
// Suggestion plus the GM's own switches (answers.selection = {on:[ids], off:[ids]}). Hilton-only SOPs never turn on at an independent hotel.
function selectedIds(masters, brand, amen, sel) {
  const on = new Set(sel.on || []), off = new Set(sel.off || []);
  return masters.filter((m) => fitsBrand(m, brand) && (on.has(m.id) ? true : off.has(m.id) ? false : suggestedOn(m, brand, amen))).map((m) => m.id);
}

// Setup state kept in hotels.answers: the five yes/no answers, the GM's switches, and where they left off.
function readSetup(h) {
  const a = h.answers && typeof h.answers === "object" ? h.answers : {};
  const amen = {};
  for (const k of AMENITIES) if (a[k] !== undefined) amen[k] = !!a[k];
  const qa = {};
  for (const k of DETAIL_QS) if (a[k] !== undefined) qa[k] = !!a[k];
  const ids = (x) => (Array.isArray(x) ? x.map(String) : []);
  return { amen, qa, selection: { on: ids(a.selection && a.selection.on), off: ids(a.selection && a.selection.off) }, stage: a.stage || "start", copyFrom: a.copyFrom || null };
}

// The wording the yes/no detail questions fill in: { cash: {no:{key:value}, yes:{...}}, early_checkin: {default:{...}}, ... }.
async function setupDefaults() {
  const r = (await q("SELECT value FROM master_meta WHERE key='setup_defaults'")).rows[0];
  return r && r.value && typeof r.value === "object" ? r.value : {};
}
// Detail names that belong to each question block (setup step 2 and Hotel details): { cash: [keys], ..., early_checkin: [keys] }.
function questionKeys(defaults) {
  const out = {};
  for (const k of [...DETAIL_QS, "early_checkin"]) {
    const keys = new Set();
    for (const variant of Object.values((defaults && defaults[k]) || {})) for (const key of Object.keys(variant || {})) keys.add(key);
    if (keys.size) out[k] = [...keys];
  }
  return out;
}
async function detailDefs(defaults) {
  const [{ rows }, qk] = await Promise.all([q("SELECT key, example, grp FROM master_details ORDER BY sort, key"), defaults ? questionKeys(defaults) : setupDefaults().then(questionKeys)]);
  const owner = new Map();
  for (const [k, keys] of Object.entries(qk)) for (const key of keys) owner.set(tokKey(key), k);
  return rows.map((d) => {
    const amen = AMENITIES.includes(d.grp);
    return {
      key: d.key, hint: d.example, group: amen ? d.grp : null, q: owner.get(tokKey(d.key)) || null,
      section: amen ? AMEN_TITLE[d.grp] : DETAIL_GROUP_TITLE[d.grp] || DETAIL_SECTION[d.key] || "Other details",
    };
  });
}

// Fills the details a yes/no question owns with the wording for the answer. A detail is only replaced when it is empty
// or still holds the other answer's wording, so text the GM typed is never overwritten.
function applyQuestionDefaults(details, question, yes, defaults) {
  const set = (defaults && defaults[question]) || {};
  const mine = set[yes ? "yes" : "no"], other = set[yes ? "no" : "yes"] || {};
  if (!mine) return details;
  const out = { ...details };
  for (const [key, val] of Object.entries(mine)) {
    const have = Object.keys(out).find((x) => tokKey(x) === tokKey(key));
    const cur = have === undefined ? "" : String(out[have] ?? "").trim();
    const otherVal = other[key] !== undefined ? String(other[key]).trim() : null;
    if (!cur || (otherVal !== null && cur === otherVal)) out[have === undefined ? key : have] = val;
  }
  return out;
}

// Detail names an SOP will show to staff at a hotel of this system (a step skipped there doesn't count).
function detailsUsedBy(m, system, byKey) {
  const v = variantOf(m, system);
  const text = [v.title, ...v.steps.map((x) => x.t), v.script, v.flag].join("\n");
  const out = new Set();
  for (const mt of text.matchAll(/\{([^{}]+)\}/g)) {
    const d = byKey.get(tokKey(mt[1]));
    if (d) out.add(d);
  }
  return [...out];
}

const hotelFull = async (id, c) => ((c || { query: (...a) => q(...a) }).query("SELECT id, name, brand, system, setup, ready, answers, details FROM hotels WHERE id=$1", [id])).then((r) => r.rows[0]);

app.get(
  "/api/setup",
  auth("GM"),
  hotel,
  wrap(async (req, res) => {
    const h = await hotelFull(req.hotel);
    const sdef = await setupDefaults();
    const [cats, ms, defs, cur, srcs, cc] = await Promise.all([
      q("SELECT name, prefix FROM master_categories ORDER BY sort"),
      q("SELECT id, category, title, applies, requires, steps, script, script_hk, flag, flag_hk, keywords, version FROM master_sops WHERE status='live' ORDER BY id"),
      detailDefs(sdef),
      q("SELECT master_id, status FROM sops WHERE hotel_id=$1 AND master_id IS NOT NULL", [req.hotel]),
      q(
        `SELECT h.id, h.name, h.brand, h.system,
                (SELECT count(*)::int FROM sops s WHERE s.hotel_id = h.id AND s.status = 'live' AND s.master_id IS NOT NULL) AS live
           FROM hotels h WHERE h.setup = 'live' AND h.id = ANY($1) AND h.id <> $2 ORDER BY h.name`,
        [req.user.hotels, req.hotel]
      ),
      q("SELECT count(*)::int AS n FROM contacts WHERE hotel_id=$1", [req.hotel]),
    ]);
    const st = readSetup(h);
    const byKey = new Map(defs.map((d) => [tokKey(d.key), d.key]));
    const have = new Map(cur.rows.map((r) => [r.master_id, r.status]));
    res.json({
      hotel: { id: h.id, name: h.name, brand: h.brand, system: h.system, setup: h.setup },
      stage: st.stage,
      copyFrom: st.copyFrom,
      answers: { ...st.amen, ...st.qa },
      qkeys: questionKeys(sdef),
      selection: st.selection,
      details: h.details || {},
      cats: cats.rows,
      detailDefs: defs,
      sops: ms.rows.map((m) => ({
        id: m.id, cat: m.category, title: m.title, applies: m.applies, requires: m.requires,
        uses: detailsUsedBy(m, h.system, byKey), st: have.get(m.id) || null,
      })),
      sources: srcs.rows,
      contacts: cc.rows[0].n,
    });
  })
);

// Step 1: pick how to start. "copy" takes the SOPs that are live at another hotel as the starting selection.
app.post(
  "/api/setup/start",
  auth("GM"),
  hotel,
  wrap(async (req, res) => {
    const h = await hotelFull(req.hotel);
    if (h.setup === "live") return bad(res, 400, "This hotel is already live.");
    let patch;
    if (req.body.mode === "copy") {
      const from = String(req.body.from || "");
      if (!from || from === req.hotel || !req.user.hotels.includes(from)) return bad(res, 400, "Pick a hotel to copy from.");
      const src = (await q("SELECT setup FROM hotels WHERE id=$1", [from])).rows[0];
      if (!src || src.setup !== "live") return bad(res, 400, "You can only copy a hotel that is live.");
      const live = new Set((await q("SELECT master_id FROM sops WHERE hotel_id=$1 AND status='live' AND master_id IS NOT NULL", [from])).rows.map((r) => r.master_id));
      const all = (await q("SELECT id FROM master_sops WHERE status='live' ORDER BY id")).rows.map((r) => r.id);
      patch = { stage: "review", copyFrom: from, selection: { on: all.filter((id) => live.has(id)), off: all.filter((id) => !live.has(id)) } };
    } else {
      patch = { stage: "about" };
      if (readSetup(h).copyFrom) { patch.copyFrom = null; patch.selection = { on: [], off: [] }; } // starting over from questions
    }
    await q("UPDATE hotels SET setup='setup', ready=FALSE, answers = COALESCE(answers,'{}'::jsonb) || $2::jsonb WHERE id=$1", [req.hotel, JSON.stringify(patch)]);
    res.json({ ok: true });
  })
);

// Step 2: save the yes/no answers and any details typed so far. Only the details sent are changed (blank clears one).
app.put(
  "/api/setup/answers",
  auth("GM"),
  hotel,
  wrap(async (req, res) => {
    const out = await tx(async (c) => {
      const h = (await c.query("SELECT id, brand, system, setup, answers, details FROM hotels WHERE id=$1 FOR UPDATE", [req.hotel])).rows[0];
      if (h.setup === "live") return { err: "This hotel is already live. Change details from Hotel home." };
      const old = readSetup(h);
      const given = req.body.answers && typeof req.body.answers === "object" ? req.body.answers : {};
      const amen = { ...old.amen };
      for (const k of AMENITIES) if (given[k] !== undefined) amen[k] = !!given[k];
      // An answer that changed resets the GM's own switches for the SOPs that depend on it.
      const changed = AMENITIES.filter((k) => !!old.amen[k] !== !!amen[k]);
      let selection = old.selection;
      if (changed.length) {
        const drop = new Set((await c.query("SELECT id FROM master_sops WHERE requires = ANY($1)", [changed])).rows.map((r) => r.id));
        selection = { on: selection.on.filter((id) => !drop.has(id)), off: selection.off.filter((id) => !drop.has(id)) };
      }
      // Details: merge what was sent, then settle the amenity groups ("no" fills the empty ones with a plain note).
      const incoming = cleanDetails(req.body.details, true);
      let details = mergeDetails(h.details, incoming);
      const defs = (await c.query("SELECT key, grp FROM master_details WHERE grp = ANY($1)", [AMENITIES])).rows;
      for (const d of defs) {
        const key = Object.keys(details).find((x) => tokKey(x) === tokKey(d.key));
        const sent = Object.keys(incoming).some((x) => tokKey(x) === tokKey(d.key) && incoming[x]);
        if (amen[d.grp] === false && !key) details[d.key] = NOT_OFFERED;
        else if (amen[d.grp] === true && key && details[key] === NOT_OFFERED && !sent) delete details[key];
      }
      // Yes/no questions that only fill in details: new (or first) answers write their wording into the empty details.
      const qa = { ...old.qa }, sdef = await setupDefaults();
      for (const k of DETAIL_QS) {
        if (given[k] === undefined) continue;
        const yes = !!given[k];
        if (old.qa[k] === undefined || old.qa[k] !== yes) details = applyQuestionDefaults(details, k, yes, sdef);
        qa[k] = yes;
      }
      const patch = { ...amen, ...qa, selection };
      if (req.body.stage === "about" || req.body.stage === "review") patch.stage = req.body.stage;
      await c.query("UPDATE hotels SET answers = COALESCE(answers,'{}'::jsonb) || $2::jsonb, details=$3 WHERE id=$1", [req.hotel, JSON.stringify(patch), JSON.stringify(details)]);
      return { answers: { ...amen, ...qa }, selection, details };
    });
    if (out.err) return bad(res, 400, out.err);
    res.json(out);
  })
);

// Step 3: the GM's own switches (replaces the saved list).
app.put(
  "/api/setup/selection",
  auth("GM"),
  hotel,
  wrap(async (req, res) => {
    const h = await hotelFull(req.hotel);
    if (h.setup === "live") return bad(res, 400, "This hotel is already live. Use the SOP switches on Hotel home.");
    const valid = new Set((await q("SELECT id FROM master_sops WHERE status='live'")).rows.map((r) => r.id));
    const pick = (x) => [...new Set((Array.isArray(x) ? x : []).map(String).filter((id) => valid.has(id)))];
    const on = pick(req.body.on), onSet = new Set(on);
    const off = pick(req.body.off).filter((id) => !onSet.has(id));
    await q("UPDATE hotels SET answers = COALESCE(answers,'{}'::jsonb) || $2::jsonb WHERE id=$1", [req.hotel, JSON.stringify({ selection: { on, off } })]);
    res.json({ selection: { on, off } });
  })
);

// Build and insert hotel copies of master SOPs. Steps follow the hotel's system; skipped steps are left out; photos are copied.
async function insertMasterCopies(c, hotelId, system, masters, statusOf, userId) {
  const rows = [];
  for (const m of masters) {
    const v = variantOf(m, system);
    const steps = await ownImages(c, v.steps, hotelId);
    rows.push([hotelId, m.id, v.category, v.title, JSON.stringify(steps), v.script, v.flag, v.keywords, statusOf(m), userId, m.id, m.version]);
  }
  let n = 0;
  for (let i = 0; i < rows.length; i += 80) {
    const part = rows.slice(i, i + 80), params = [];
    const vals = part.map((r, j) => { params.push(...r); const b = j * 12; return `(${Array.from({ length: 12 }, (_, k) => "$" + (b + k + 1)).join(",")},FALSE)`; });
    const r = await c.query(
      `INSERT INTO sops (hotel_id, id, category, title, steps, script, flag, keywords, status, updated_by, master_id, master_version, kept)
       VALUES ${vals.join(",")} ON CONFLICT (hotel_id, id) DO NOTHING`,
      params
    );
    n += r.rowCount;
  }
  return n;
}

app.post(
  "/api/setup/go-live",
  auth("GM"),
  hotel,
  wrap(async (req, res) => {
    const out = await tx(async (c) => {
      const h = (await c.query("SELECT id, brand, system, setup, answers FROM hotels WHERE id=$1 FOR UPDATE", [req.hotel])).rows[0];
      if (h.setup === "live") return { err: "This hotel is already live." };
      const masters = (await c.query("SELECT * FROM master_sops WHERE status='live' ORDER BY id")).rows;
      const st = readSetup(h);
      const sel = new Set(selectedIds(masters, h.brand, st.amen, st.selection));
      if (!sel.size) return { err: "Turn on at least one SOP before going live." };
      const mcats = (await c.query("SELECT name, prefix, sort FROM master_categories ORDER BY sort")).rows;
      for (const mc of mcats) {
        await c.query("INSERT INTO categories (hotel_id, name, prefix, sort) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [h.id, mc.name, mc.prefix, mc.sort]);
      }
      await insertMasterCopies(c, h.id, h.system, masters, (m) => (sel.has(m.id) ? "live" : "off"), req.user.id);
      if (!(await c.query("SELECT 1 FROM routes WHERE hotel_id=$1 LIMIT 1", [h.id])).rows.length) {
        let i = 0;
        for (const [id, label, sub, first, then, joiner] of ROUTES) {
          await c.query("INSERT INTO routes (hotel_id, id, label, sub, first_role, then_role, joiner, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [h.id, id, label, sub, first, then, joiner, i++]);
        }
      }
      // An amenity the GM never answered (the copy path) is taken from what ended up on.
      const patch = { stage: "live" };
      for (const k of AMENITIES) if (st.amen[k] === undefined) patch[k] = masters.some((m) => m.requires === k && sel.has(m.id));
      await c.query("UPDATE hotels SET setup='live', ready=TRUE, answers = COALESCE(answers,'{}'::jsonb) || $2::jsonb WHERE id=$1", [h.id, JSON.stringify(patch)]);
      return { on: sel.size, off: masters.length - sel.size };
    });
    if (out.err) return bad(res, 400, out.err);
    res.json({ ok: true, ...out });
  })
);

// Switch master SOPs on or off at a live hotel. A master SOP the hotel doesn't have yet is added on demand.
app.post(
  "/api/hotel/sops-toggle",
  auth("GM"),
  hotel,
  wrap(async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String))].slice(0, 400);
    const on = req.body.on === true;
    if (!ids.length) return bad(res, 400, "Pick at least one SOP.");
    const out = await tx(async (c) => {
      const h = (await c.query("SELECT id, brand, system FROM hotels WHERE id=$1 FOR UPDATE", [req.hotel])).rows[0];
      const masters = (await c.query("SELECT * FROM master_sops WHERE id = ANY($1) AND status='live'", [ids])).rows;
      const mine = new Map((await c.query("SELECT id, master_id FROM sops WHERE hotel_id=$1 AND id = ANY($2)", [req.hotel, ids])).rows.map((r) => [r.id, r.master_id]));
      let changed = 0, skipped = 0;
      const missing = [];
      for (const m of masters) {
        if (on && !fitsBrand(m, h.brand)) { skipped++; continue; } // Hilton-only SOPs stay off at an independent hotel
        if (!mine.has(m.id)) { missing.push(m); continue; }
        if (mine.get(m.id) !== m.id) { skipped++; continue; } // a hotel-only SOP that reuses the id
        const r = await c.query("UPDATE sops SET status=$3, updated_by=$4 WHERE hotel_id=$1 AND id=$2 AND status <> $3", [req.hotel, m.id, on ? "live" : "off", req.user.id]);
        changed += r.rowCount;
      }
      for (const m of missing) await ensureCategory(c, req.hotel, m.category);
      if (missing.length) changed += await insertMasterCopies(c, req.hotel, h.system, missing, () => (on ? "live" : "off"), req.user.id);
      return { changed, skipped };
    });
    res.json(out);
  })
);

// Master SOPs this hotel has no copy of yet and that suit it (brand and amenities).
async function freshMasters(hotelId) {
  const h = await hotelFull(hotelId);
  const amen = readSetup(h).amen;
  const { rows } = await q(
    `SELECT m.id, m.title, m.category, m.applies, m.requires, m.version, m.updated_at
       FROM master_sops m WHERE m.status='live' AND NOT EXISTS (SELECT 1 FROM sops s WHERE s.hotel_id=$1 AND s.id=m.id) ORDER BY m.id`,
    [hotelId]
  );
  return rows
    .filter((m) => fitsBrand(m, h.brand) && (!m.requires || amen[m.requires] !== false))
    .map((m) => ({ id: m.id, title: m.title, cat: m.category, version: m.version, updated: m.updated_at }));
}

app.get("/api/updates/new", auth("GM"), hotel, wrap(async (req, res) => res.json(await freshMasters(req.hotel))));

// Add a new master SOP to this hotel (live) or skip it (kept as an Off copy so it isn't offered again).
for (const [verb, status] of [["add", "live"], ["skip", "off"]]) {
  app.post(
    `/api/updates/new/:id/${verb}`,
    auth("GM"),
    hotel,
    wrap(async (req, res) => {
      const out = await tx(async (c) => {
        const h = (await c.query("SELECT id, brand, system FROM hotels WHERE id=$1 FOR UPDATE", [req.hotel])).rows[0];
        const m = (await c.query("SELECT * FROM master_sops WHERE id=$1 AND status='live'", [req.params.id])).rows[0];
        if (!m) return { err: [404, "That SOP no longer exists in the master library."] };
        if (!fitsBrand(m, h.brand)) return { err: [400, "That SOP is for Hilton hotels only."] };
        if ((await c.query("SELECT 1 FROM sops WHERE hotel_id=$1 AND id=$2", [req.hotel, m.id])).rows.length) return { err: [400, "This hotel already has that SOP."] };
        await ensureCategory(c, req.hotel, m.category);
        await insertMasterCopies(c, req.hotel, h.system, [m], () => status, req.user.id);
        return { ok: true };
      });
      if (out.err) return bad(res, out.err[0], out.err[1]);
      res.json({ ok: true, status });
    })
  );
}

// Everything Hotel home shows in one call.
app.get(
  "/api/home",
  auth("GM"),
  hotel,
  wrap(async (req, res) => {
    const h = await hotelFull(req.hotel);
    const [updates, fresh, counts, defs, cc] = await Promise.all([
      pendingUpdates(req.hotel),
      freshMasters(req.hotel),
      q(
        `SELECT count(*) FILTER (WHERE status='live')::int AS live, count(*) FILTER (WHERE status='off')::int AS off,
                count(*) FILTER (WHERE status='draft')::int AS draft, count(*) FILTER (WHERE master_id IS NULL)::int AS own
           FROM sops WHERE hotel_id=$1`,
        [req.hotel]
      ),
      detailDefs(),
      q("SELECT count(*)::int AS n FROM contacts WHERE hotel_id=$1", [req.hotel]),
    ]);
    const det = h.details || {};
    const filled = defs.filter((d) => String(det[d.key] ?? "").trim()).length;
    res.json({ updates, fresh, counts: counts.rows[0], details: { filled, total: defs.length }, contacts: cc.rows[0].n, system: h.system, brand: h.brand, setup: h.setup });
  })
);

// ---------- owner: portfolio of hotels ----------
app.get(
  "/api/owner/hotels",
  auth("Owner"),
  wrap(async (req, res) => {
    const [hs, gms] = await Promise.all([
      q(
        `SELECT h.id, h.name, h.brand, h.system, h.setup, h.ready,
                (SELECT count(*)::int FROM sops s WHERE s.hotel_id = h.id AND s.status = 'live') AS live,
                (SELECT count(*)::int FROM sops s WHERE s.hotel_id = h.id) AS total,
                (SELECT count(*)::int FROM sops s JOIN master_sops m ON m.id = s.master_id
                  WHERE s.hotel_id = h.id AND s.master_version < m.version) AS pending
           FROM hotels h ORDER BY h.name`
      ),
      q(
        `SELECT uh.hotel_id, u.id, u.name, u.username, u.status, u.must_change_pw
           FROM user_hotels uh JOIN users u ON u.id = uh.user_id
          WHERE u.role = 'GM' ORDER BY u.name`
      ),
    ]);
    res.json(
      hs.rows.map((h) => ({
        ...h,
        gms: gms.rows.filter((g) => g.hotel_id === h.id).map(({ hotel_id, ...g }) => g),
      }))
    );
  })
);

app.post(
  "/api/owner/hotels",
  auth("Owner"),
  wrap(async (req, res) => {
    const name = String(req.body.name || "").trim().slice(0, 80);
    const brand = req.body.brand === "hilton" ? "hilton" : req.body.brand === "independent" ? "independent" : null;
    const system = req.body.system === "pep" ? "pep" : req.body.system === "hotelkey" ? "hotelkey" : null;
    if (!name) return bad(res, 400, "Add the hotel's name.");
    if (!brand) return bad(res, 400, "Pick Hilton or Independent.");
    if (!system) return bad(res, 400, "Pick PEP or HotelKey.");
    if ((await q("SELECT 1 FROM hotels WHERE lower(name)=lower($1)", [name])).rows.length) return bad(res, 400, "A hotel with that name already exists.");
    // Short id from the initials of the name, e.g. "Hotel Lotus Merriam" -> hlm. Numbered if taken.
    const words = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    let base = words.map((w) => w[0]).join("").slice(0, 4);
    if (base.length < 2) base = (words.join("") || "hotel").slice(0, 4);
    let id = base, n = 1;
    while ((await q("SELECT 1 FROM hotels WHERE id=$1", [id])).rows.length) id = base + ++n;
    await q("INSERT INTO hotels (id, name, brand, system, setup, ready) VALUES ($1,$2,$3,$4,'new',FALSE)", [id, name, brand, system]);
    res.json({ id, name, brand, system, setup: "new", ready: false, live: 0, total: 0, pending: 0, gms: [] });
  })
);

app.put(
  "/api/owner/hotels/:id",
  auth("Owner"),
  wrap(async (req, res) => {
    const h = (await q("SELECT id, name, brand, system, setup, ready FROM hotels WHERE id=$1", [req.params.id])).rows[0];
    if (!h) return bad(res, 404, "That hotel no longer exists.");
    const name = req.body.name === undefined ? h.name : String(req.body.name || "").trim().slice(0, 80);
    const brand = req.body.brand === undefined ? h.brand : req.body.brand === "hilton" ? "hilton" : req.body.brand === "independent" ? "independent" : null;
    const system = req.body.system === undefined ? h.system : req.body.system === "pep" ? "pep" : req.body.system === "hotelkey" ? "hotelkey" : null;
    if (!name) return bad(res, 400, "Add the hotel's name.");
    if (!brand) return bad(res, 400, "Pick Hilton or Independent.");
    if (!system) return bad(res, 400, "Pick PEP or HotelKey.");
    if (h.setup === "live" && (brand !== h.brand || system !== h.system)) return bad(res, 400, "Brand and system can't change once a hotel is live.");
    if ((await q("SELECT 1 FROM hotels WHERE lower(name)=lower($1) AND id<>$2", [name, h.id])).rows.length) return bad(res, 400, "A hotel with that name already exists.");
    await q("UPDATE hotels SET name=$2, brand=$3, system=$4 WHERE id=$1", [h.id, name, brand, system]);
    res.json({ id: h.id, name, brand, system, setup: h.setup, ready: h.ready });
  })
);

// ---------- owner settings ----------
app.put(
  "/api/settings",
  auth("Owner"),
  wrap(async (req, res) => {
    const b = req.body;
    const s = await settingsRow();
    const provider = b.provider && (b.provider === "none" || ai.PROVIDERS[b.provider]) ? b.provider : s.provider;
    const switching = provider !== s.provider;
    const fields = {
      provider,
      model: b.model !== undefined ? String(b.model).trim().slice(0, 100) : switching ? "" : s.model,
      base_url: b.baseUrl !== undefined ? String(b.baseUrl).trim().slice(0, 300) : switching ? "" : s.base_url,
      source_only: b.sourceOnly !== undefined ? !!b.sourceOnly : s.source_only,
      show_source: b.showSource !== undefined ? !!b.showSource : s.show_source,
      fallback: b.fallback !== undefined ? !!b.fallback : s.fallback,
    };
    if (fields.base_url && !/^https:\/\//.test(fields.base_url)) return bad(res, 400, "The URL must start with https://");
    let keySql = "";
    const params = [fields.provider, fields.model, fields.base_url, fields.source_only, fields.show_source, fields.fallback];
    if (b.apiKey) {
      const k = String(b.apiKey).trim();
      if (k.length < 12) return bad(res, 400, "That key looks too short.");
      params.push(encrypt(k), k.slice(-4), req.user.name);
      keySql = ", key_enc=$7, key_last4=$8, key_added_by=$9, key_added_at=now()";
    } else if (switching || b.removeKey) {
      keySql = ", key_enc=NULL, key_last4=NULL, key_added_by=NULL, key_added_at=NULL";
    }
    await q(
      `UPDATE settings SET provider=$1, model=$2, base_url=$3, source_only=$4, show_source=$5, fallback=$6${keySql} WHERE id=1`,
      params
    );
    res.json(publicSettings(await settingsRow(), true));
  })
);

app.post(
  "/api/settings/test",
  auth("Owner"),
  wrap(async (req, res) => {
    const cfg = aiConfig(await settingsRow());
    if (!cfg) return bad(res, 400, "Save a provider and API key first.");
    try {
      const r = await ai.testConnection(cfg);
      res.json({ ok: true, ms: r.ms });
    } catch (e) {
      res.status(502).json({ error: `The provider didn't accept the request: ${e.message.slice(0, 200)}` });
    }
  })
);

// ---------- import (Owner -> master library, GM -> their hotel) ----------
// Everything imported lands as a review item first. Hotel-only SOPs start as drafts; nothing goes live by itself.
const importLimiter = rateLimit({ windowMs: 30 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many imports. Wait a few minutes and try again." } });

// Where this request imports to: "master" (Owner only) or a hotel the user is assigned to.
const importTarget = (req, res, next) => {
  const t = String(req.query.target || req.body?.target || (isOwner(req.user) ? "master" : req.user.hotels[0] || ""));
  if (t === "master") {
    if (!isOwner(req.user)) return bad(res, 403, "Only the Owner can import into the master library.");
    req.target = null;
  } else {
    if (!req.user.hotels.includes(t)) return bad(res, 403, "You don't have access to that hotel.");
    req.target = t;
  }
  next();
};

const canUseBatch = (u, b) => (b.hotel_id ? u.hotels.includes(b.hotel_id) : isOwner(u));

// What the AI and the spreadsheet match against: id, title, category of the target's SOPs, plus valid categories and detail names.
async function importCtx(target) {
  const [cat, dk] = await Promise.all([q("SELECT name FROM master_categories ORDER BY sort"), q("SELECT key FROM master_details ORDER BY sort, key")]);
  const categories = cat.rows.map((r) => r.name);
  const detailKeys = dk.rows.map((r) => r.key);
  let catalog;
  let inSetup = false;
  if (target) {
    catalog = (await q("SELECT id, title, category FROM sops WHERE hotel_id=$1 ORDER BY id", [target])).rows;
    // A hotel that hasn't gone live has no copies of the library yet, so match against the published master SOPs too.
    inSetup = (await q("SELECT setup FROM hotels WHERE id=$1", [target])).rows[0]?.setup !== "live";
    if (inSetup) {
      const have = new Set(catalog.map((r) => r.id));
      const ms = (await q("SELECT id, title, category FROM master_sops WHERE status='live' ORDER BY id")).rows;
      catalog = [...catalog, ...ms.filter((r) => !have.has(r.id))].sort((a, b) => (a.id < b.id ? -1 : 1));
    }
    for (const r of (await q("SELECT name FROM categories WHERE hotel_id=$1 ORDER BY sort", [target])).rows) if (!categories.includes(r.name)) categories.push(r.name);
    const h = (await q("SELECT details FROM hotels WHERE id=$1", [target])).rows[0];
    for (const k of Object.keys((h && h.details) || {})) if (!detailKeys.some((x) => tokKey(x) === tokKey(k))) detailKeys.push(k);
  } else {
    catalog = (await q("SELECT id, title, category FROM master_sops ORDER BY id")).rows;
  }
  return { catalog, categories, detailKeys, inSetup, targetLabel: target ? (inSetup ? "the Lotus library" : "this hotel's SOPs") : "the master library" };
}

const stepTexts = (steps) => (Array.isArray(steps) ? steps : []).map((x) => (typeof x === "string" ? x : x.t || "")).filter(Boolean);
const sameText = (a, b) => JSON.stringify(a.map((x) => imp.norm(x))) === JSON.stringify(b.map((x) => imp.norm(x)));
// New step list from plain text, keeping the photo and HotelKey wording of any step whose text is unchanged.
const carryOver = (oldSteps, texts) => {
  const old = new Map();
  for (const s of Array.isArray(oldSteps) ? oldSteps : []) if (s && s.t) old.set(imp.norm(s.t), s);
  return texts.map((t) => {
    const o = old.get(imp.norm(t));
    return { t, hk: o && o.hk ? o.hk : null, img: o && o.img ? o.img : null };
  });
};

const itemCount = (r) => ["matches", "new", "details"].reduce((n, g) => n + (r[g] || []).length, 0);
const openCount = (r) => ["matches", "new", "details"].reduce((n, g) => n + (r[g] || []).filter((x) => !x.state).length, 0);

// The batch as the review screen needs it: items with their state, and for matches what the library has now.
async function batchView(row) {
  const r = row.result || {};
  const ctx = await importCtx(row.hotel_id);
  const ids = (r.matches || []).map((m) => m.sop_id);
  const ours = new Map();
  if (ids.length) {
    const rows = row.hotel_id
      ? (await q("SELECT id, title, category, steps, script, flag FROM sops WHERE hotel_id=$1 AND id = ANY($2)", [row.hotel_id, ids])).rows
      : (await q("SELECT id, title, category, steps, script, flag FROM master_sops WHERE id = ANY($1)", [ids])).rows;
    for (const s of rows) ours.set(s.id, { id: s.id, title: s.title, cat: s.category, steps: stepTexts(s.steps), script: s.script, flag: s.flag });
    // Before go-live the hotel has no copy yet: show the library's wording ("Already in the library").
    if (row.hotel_id && ctx.inSetup) {
      const missing = ids.filter((id) => !ours.has(id));
      if (missing.length) {
        for (const s of (await q("SELECT id, title, category, steps, script, flag FROM master_sops WHERE id = ANY($1) AND status='live'", [missing])).rows) {
          ours.set(s.id, { id: s.id, title: s.title, cat: s.category, steps: stepTexts(s.steps), script: s.script, flag: s.flag, library: true });
        }
      }
    }
  }
  const by = row.created_by ? (await q("SELECT name FROM users WHERE id=$1", [row.created_by])).rows[0] : null;
  const cats = ctx.categories;
  return {
    cats,
    id: row.id, target: row.hotel_id || "master", kind: row.kind, status: row.status, files: row.filenames, created: row.created_at, by: by ? by.name : null,
    meta: r.meta || {},
    setup: !!(row.hotel_id && ctx.inSetup),
    matches: (r.matches || []).map((m, i) => ({ ...m, i, ours: ours.get(m.sop_id) || null })),
    new: (r.new || []).map((n, i) => ({ ...n, i })),
    details: (r.details || []).map((d, i) => ({ ...d, i })),
    open: openCount(r),
  };
}

async function saveBatchResult(c, row, result) {
  const status = openCount(result) === 0 ? "done" : "review";
  await c.query("UPDATE imports SET result=$2, status=$3 WHERE id=$1", [row.id, JSON.stringify(result), status]);
  row.status = status;
}

async function newImportRow(user, target, kind, filenames, result) {
  return (
    await q("INSERT INTO imports (hotel_id, created_by, kind, filenames, result) VALUES ($1,$2,$3,$4,$5) RETURNING *", [target, user.id, kind, filenames, JSON.stringify(result)])
  ).rows[0];
}
const withStates = (r) => ({
  ...r,
  matches: r.matches.map((x) => ({ ...x, state: null })),
  new: r.new.map((x) => ({ ...x, state: null })),
  details: r.details.map((x) => ({ ...x, state: null })),
});

app.get(
  "/api/import/info",
  auth("GM"),
  wrap(async (req, res) => {
    const hs = (await q("SELECT id, name, setup FROM hotels WHERE id = ANY($1) ORDER BY name", [req.user.hotels])).rows;
    res.json({
      aiOn: !!aiConfig(await settingsRow()) || ai.mockEnabled(),
      canMaster: isOwner(req.user),
      hotels: hs,
      maxFiles: imp.MAX_FILES,
      maxMb: imp.MAX_FILE_BYTES / 1048576,
      types: imp.EXTS,
    });
  })
);

app.get(
  "/api/import/template.xlsx",
  auth("GM"),
  wrap(async (req, res) => {
    const cats = (await q("SELECT name FROM master_categories ORDER BY sort")).rows.map((r) => r.name);
    const buf = await imp.buildTemplate(cats);
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="ask-lotus-sop-template.xlsx"',
      "Cache-Control": "no-store",
    }).send(buf);
  })
);

// Recent batches for one target, newest first.
app.get(
  "/api/imports",
  auth("GM"),
  importTarget,
  wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT i.id, i.kind, i.status, i.filenames, i.created_at, i.result, u.name AS by
         FROM imports i LEFT JOIN users u ON u.id = i.created_by
        WHERE i.hotel_id IS NOT DISTINCT FROM $1 AND i.status <> 'discarded' ORDER BY i.id DESC LIMIT 15`,
      [req.target]
    );
    res.json(rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, files: r.filenames, created: r.created_at, by: r.by, total: itemCount(r.result || {}), open: openCount(r.result || {}) })));
  })
);

const loadFiles = (list) => {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) throw new imp.ImportError("Choose a file first.");
  if (arr.length > imp.MAX_FILES) throw new imp.ImportError(`Choose up to ${imp.MAX_FILES} files at a time.`);
  return arr.map((f) => {
    const name = String((f && f.name) || "file").replace(/[\\/]/g, "_").slice(0, 120);
    return { name, buf: imp.decodeUpload(f && f.data) };
  });
};
const importFail = (res, e) => {
  if (e instanceof imp.ImportError) return bad(res, 400, e.message);
  throw e;
};

app.post(
  "/api/import/upload",
  auth("GM"),
  importLimiter,
  jsonBig,
  importTarget,
  wrap(async (req, res) => {
    try {
      const cfg = aiConfig(await settingsRow()) || (ai.mockEnabled() ? { provider: "mock" } : null);
      if (!cfg) return res.status(400).json({ error: "Reading documents needs an AI key, and none is set up yet. The Owner can add one in Settings. You can still import with the spreadsheet template.", noAi: true });
      const files = loadFiles(req.body.files);
      const { text, truncated, empty } = await imp.extractAll(files);
      if (!text) throw new imp.ImportError("We couldn't find any text in those files. Scanned pages and photos can't be read. Try a text version or the spreadsheet template.");
      const ctx = await importCtx(req.target);
      const { result, failedParts, parts } = await imp.analyzeText((system, user, opts) => ai.complete(cfg, system, user, opts), text, ctx);
      if (!result.matches.length && !result.new.length && !result.details.length) throw new imp.ImportError("We didn't find any procedures or hotel details in that text.");
      const row = await newImportRow(req.user, req.target, "ai", files.map((f) => f.name), {
        ...withStates(result),
        meta: { truncated, failedParts, parts, emptyFiles: empty, chars: text.length },
      });
      res.json(await batchView(row));
    } catch (e) {
      importFail(res, e);
    }
  })
);

app.post(
  "/api/import/sheet",
  auth("GM"),
  importLimiter,
  jsonBig,
  importTarget,
  wrap(async (req, res) => {
    try {
      const [file] = loadFiles(req.body.file ? [req.body.file] : []);
      const rows = await imp.sheetRowsFromFile(file.name, file.buf);
      const ctx = await importCtx(req.target);
      const out = imp.parseSheetRows(rows, ctx);
      if (!out.matches.length && !out.new.length) {
        const why = out.skipped.length ? ` ${out.skipped.length} row(s) were skipped (${[...new Set(out.skipped.map((s) => s.reason))].join("; ")}).` : out.examples ? " Only the example rows were found. Replace them with your own." : "";
        throw new imp.ImportError("No procedures found in that file." + why);
      }
      const row = await newImportRow(req.user, req.target, "sheet", [file.name], {
        ...withStates({ matches: out.matches, new: out.new, details: [] }),
        meta: { skipped: out.skipped.slice(0, 50), skippedCount: out.skipped.length, examples: out.examples },
      });
      res.json(await batchView(row));
    } catch (e) {
      importFail(res, e);
    }
  })
);

app.get(
  "/api/import/:id(\\d+)",
  auth("GM"),
  wrap(async (req, res) => {
    const row = (await q("SELECT * FROM imports WHERE id=$1", [req.params.id])).rows[0];
    if (!row || !canUseBatch(req.user, row)) return bad(res, 404, "That import no longer exists.");
    res.json(await batchView(row));
  })
);

app.post(
  "/api/import/:id(\\d+)/discard",
  auth("GM"),
  wrap(async (req, res) => {
    const row = (await q("SELECT * FROM imports WHERE id=$1", [req.params.id])).rows[0];
    if (!row || !canUseBatch(req.user, row)) return bad(res, 404, "That import no longer exists.");
    await q("UPDATE imports SET status='discarded' WHERE id=$1", [row.id]);
    res.json({ ok: true });
  })
);

// Next free SOP number for a prefix, counting the master and every hotel so ids never clash later.
async function nextSopId(c, prefix) {
  const { rows } = await c.query(`SELECT id FROM master_sops WHERE id LIKE $1 UNION SELECT id FROM sops WHERE id LIKE $1`, [prefix + "-%"]);
  const n = Math.max(0, ...rows.map((r) => parseInt(r.id.split("-")[1], 10) || 0)) + 1;
  return `${prefix}-${String(n).padStart(2, "0")}`;
}
async function prefixFor(c, hotelId, category) {
  const m = (await c.query("SELECT prefix FROM master_categories WHERE name=$1", [category])).rows[0];
  if (m) return m.prefix;
  const h = hotelId ? (await c.query("SELECT prefix FROM categories WHERE hotel_id=$1 AND name=$2", [hotelId, category])).rows[0] : null;
  return h ? h.prefix : "SOP";
}

// "Use theirs" on a master SOP: new steps (and script/flag if the import has them), version bumped so hotels see an update.
async function importUseMaster(c, m, user) {
  const cur = (await c.query("SELECT * FROM master_sops WHERE id=$1 FOR UPDATE", [m.sop_id])).rows[0];
  if (!cur) return { err: [404, "That master SOP no longer exists."] };
  const steps = carryOver(cur.steps, m.steps);
  const script = m.script || cur.script, flag = m.flag || cur.flag;
  const scriptHk = script !== cur.script ? null : cur.script_hk, flagHk = flag !== cur.flag ? null : cur.flag_hk;
  if (sameText(stepTexts(cur.steps), m.steps) && script === cur.script && flag === cur.flag) return { same: true };
  let hk = cur.hk_status;
  if (!hasHk(steps, scriptHk, flagHk)) hk = "same";
  else if (hkSig(steps, scriptHk, flagHk) !== hkSig(cur.steps, cur.script_hk, cur.flag_hk) || cur.hk_status === "same") hk = "draft";
  await c.query("INSERT INTO master_history (master_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4)", [cur.id, cur.version, JSON.stringify(cur), user.id]);
  const r = await c.query(
    `UPDATE master_sops SET steps=$2, script=$3, script_hk=$4, flag=$5, flag_hk=$6, hk_status=$7, version=version+1, updated_at=now(), updated_by=$8 WHERE id=$1 RETURNING *`,
    [cur.id, JSON.stringify(steps), script, scriptHk, flag, flagHk, hk, user.id]
  );
  const n = (await c.query("SELECT count(DISTINCT hotel_id)::int AS n FROM sops WHERE master_id=$1 AND master_version < $2", [cur.id, r.rows[0].version])).rows[0].n;
  return { note: `Updated ${cur.id} to v${r.rows[0].version}${n ? ` · ${n} hotel${n === 1 ? " has" : "s have"} an update` : ""}` };
}

async function importUseHotel(c, hotelId, m, user) {
  const cur = (await c.query("SELECT * FROM sops WHERE hotel_id=$1 AND id=$2 FOR UPDATE", [hotelId, m.sop_id])).rows[0];
  if (!cur) {
    const inLib = (await c.query("SELECT 1 FROM master_sops WHERE id=$1", [m.sop_id])).rows.length;
    return { err: [inLib ? 400 : 404, inLib ? "This SOP is still in the Lotus library. After you go live you can update its wording from the Library." : "That SOP no longer exists at this hotel."] };
  }
  const steps = carryOver(cur.steps, m.steps).map((s) => ({ t: s.t, img: s.img }));
  const script = m.script || cur.script, flag = m.flag || cur.flag;
  if (sameText(stepTexts(cur.steps), m.steps) && script === cur.script && flag === cur.flag) return { same: true };
  await c.query("INSERT INTO sop_history (hotel_id, sop_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4,$5)", [hotelId, cur.id, cur.version, JSON.stringify(sopOut(cur)), user.id]);
  const r = await c.query(
    `UPDATE sops SET steps=$3, script=$4, flag=$5, version=version+1, updated_at=now(), updated_by=$6, kept = (kept OR master_id IS NOT NULL)
      WHERE hotel_id=$1 AND id=$2 RETURNING *`,
    [hotelId, cur.id, JSON.stringify(steps), script, flag, user.id]
  );
  return { note: `Updated ${cur.id} to v${r.rows[0].version}${r.rows[0].master_id ? " · marked as your own wording" : ""}` };
}

// Adds one reviewed "new" item. Master: a new master SOP (every hotel / Hilton, as the sheet said). Hotel: a hotel-only draft.
async function importAdd(c, hotelId, item, category, user) {
  await c.query("LOCK TABLE master_sops IN SHARE ROW EXCLUSIVE MODE");
  const prefix = await prefixFor(c, hotelId, category);
  const id = await nextSopId(c, prefix);
  const title = item.title.slice(0, 200);
  if (!hotelId) {
    const steps = item.steps.map((t) => ({ t, hk: null, img: null }));
    await c.query(
      `INSERT INTO master_sops (id, category, title, steps, script, flag, keywords, applies, requires, hk_status, updated_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,'',$7,$8,'same',$9,'draft')`,
      [id, category, title, JSON.stringify(steps), item.script || "", item.flag || "", item.applies === "hilton" ? "hilton" : "all", AMENITIES.includes(item.requires) ? item.requires : null, user.id]
    );
    return { id, note: `Added ${id} to the master library as a draft. Publish it from the Master library when it is ready for hotels.` };
  }
  await ensureCategory(c, hotelId, category);
  const steps = item.steps.map((t) => ({ t, img: null }));
  await c.query(
    `INSERT INTO sops (hotel_id, id, category, title, steps, script, flag, keywords, status, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'','draft',$8)`,
    [hotelId, id, category, title, JSON.stringify(steps), item.script || "", item.flag || "", user.id]
  );
  return { id, note: `Added ${id} as a draft. Review it in the Library, then switch it live.` };
}

// One action on one item (or "add all new"). Everything runs in a transaction on the locked batch.
app.post(
  "/api/import/:id(\\d+)/act",
  auth("GM"),
  wrap(async (req, res) => {
    const { group, action } = req.body;
    const idx = Number.isInteger(req.body.index) ? req.body.index : -1;
    if (!["matches", "new", "details"].includes(group)) return bad(res, 400, "Unknown item.");
    const out = await tx(async (c) => {
      const row = (await c.query("SELECT * FROM imports WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
      if (!row || !canUseBatch(req.user, row) || row.status === "discarded") return { err: [404, "That import no longer exists."] };
      const result = row.result;
      const list = result[group] || [];
      const hid = row.hotel_id;
      const ctx = await importCtx(hid);
      const allowedCat = (x) => (ctx.categories.includes(x) ? x : null);
      const msgs = [];

      if (group === "new" && action === "addAll") {
        let added = 0, needCat = 0;
        for (const item of list) {
          if (item.state) continue;
          const cat = allowedCat(item.category);
          if (!cat) { needCat++; continue; }
          await importAdd(c, hid, item, cat, req.user);
          item.state = "added"; added++;
        }
        if (!added && !needCat) return { err: [400, "Nothing left to add."] };
        msgs.push(`Added ${added} as ${hid ? "drafts" : "master drafts"}${needCat ? ` · ${needCat} need a category first` : ""}`);
        await saveBatchResult(c, row, result);
        return { row: { ...row, result }, note: msgs[0] };
      }

      const item = list[idx];
      if (!item) return { err: [404, "That item is gone."] };
      if (item.state) return { err: [400, "That one is already handled."] };
      let note = "";
      if (action === "skip") item.state = "skipped";
      else if (group === "matches" && action === "keep") { item.state = "kept"; note = "Kept ours"; }
      else if (group === "matches" && action === "use") {
        const r = hid ? await importUseHotel(c, hid, item, req.user) : await importUseMaster(c, item, req.user);
        if (r.err) return r;
        item.state = "used"; note = r.same ? "Already the same wording" : r.note;
      } else if (group === "new" && action === "add") {
        const cat = allowedCat(String(req.body.category || "").trim()) || allowedCat(item.category);
        if (!cat) return { err: [400, "Pick a category first."] };
        const r = await importAdd(c, hid, item, cat, req.user);
        item.state = "added"; item.sop_id = r.id; note = r.note;
      } else if (group === "details" && action === "apply") {
        const target = hid || String(req.body.hotel || "");
        if (!target || !(await allHotelIds()).includes(target) || !req.user.hotels.includes(target)) return { err: [400, "Pick a hotel for this detail."] };
        const cur = (await c.query("SELECT name, details FROM hotels WHERE id=$1 FOR UPDATE", [target])).rows[0];
        const merged = mergeDetails(cur.details || {}, cleanDetails({ [item.key]: item.value }, true));
        await c.query("UPDATE hotels SET details=$2 WHERE id=$1", [target, JSON.stringify(merged)]);
        item.state = "applied"; item.hotel = target; note = `Saved "${item.key}" for ${cur.name}`;
      } else return { err: [400, "That action doesn't apply here."] };
      await saveBatchResult(c, row, result);
      return { row: { ...row, result }, note };
    });
    if (out.err) return bad(res, out.err[0], out.err[1]);
    const view = await batchView(out.row);
    view.note = out.note;
    res.json(view);
  })
);

// ---------- static app ----------
app.get("/healthz", wrap(async (req, res) => {
  await q("SELECT 1");
  res.json({ ok: true });
}));
// index.html is never cached, and points at versioned app.js/style.css, so a new
// deploy reaches every browser on the next page load.
const BUILD = String(Date.now());
const INDEX = require("fs")
  .readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8")
  .replace('href="/style.css"', `href="/style.css?v=${BUILD}"`)
  .replace('src="/app.js"', `src="/app.js?v=${BUILD}"`);
const sendIndex = (req, res) => res.set("Cache-Control", "no-store").type("html").send(INDEX);
app.get(["/", "/index.html"], sendIndex);
app.use(express.static(path.join(__dirname, "..", "public"), { index: false, maxAge: 0 }));
app.get(/^\/(?!api\/).*/, sendIndex);

app.use((err, req, res, next) => {
  if (err.type === "entity.too.large" || err.status === 413) return bad(res, 413, "That upload is too large. Keep each file under 10 MB.");
  if (err.type === "entity.parse.failed") return bad(res, 400, "That request couldn't be read.");
  console.error(err);
  if (res.headersSent) return next(err);
  if (err.code === "23505") return bad(res, 400, "That's already in use. Try a different one."); // unique clash from a race
  bad(res, 500, "Something went wrong on our side. Try again.");
});

app.listen(PORT, () => console.log(`Ask Lotus listening on ${PORT}`));
