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
app.use(express.json({ limit: "6mb" }));
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
const RANK = { "Front Desk": 0, Manager: 1, Admin: 2 };
const tempPassword = () => crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 10) + "!7";
const cleanEmail = (e) => String(e || "").trim().toLowerCase();

async function loadUser(id) {
  const { rows } = await q(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.must_change_pw, u.last_seen,
            COALESCE(array_agg(uh.hotel_id) FILTER (WHERE uh.hotel_id IS NOT NULL), '{}') AS hotels
       FROM users u LEFT JOIN user_hotels uh ON uh.user_id = u.id
      WHERE u.id = $1 GROUP BY u.id`,
    [id]
  );
  return rows[0] || null;
}

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

// SOP text as staff would see it, for the model: contact tokens filled in,
// [CHECK] manager notes removed, [FILL] gaps marked as "ask a manager".
function forModel(sop, contacts) {
  const n = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
  const fill = (t) =>
    String(t || "")
      .replace(/\{([^}]+)\}/g, (m, r) => {
        const c = contacts.find((x) => n(x.role) === n(r));
        return c ? `${c.name} (${c.role}) ${c.phone}` : m;
      })
      .replace(/\[CHECK:[^\]]*\]|\[CHECK\]/g, "")
      .replace(/\[FILL:?[^\]]*\]/g, "(not set: ask a manager)")
      .trim();
  const steps = (Array.isArray(sop.steps) ? sop.steps : []).map((x) => fill(typeof x === "string" ? x : x.t)).filter(Boolean);
  return { id: sop.id, title: sop.title, category: sop.category, steps, script: fill(sop.script), flag: fill(sop.flag) };
}

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
});

// ---------- auth ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

app.post(
  "/api/login",
  loginLimiter,
  wrap(async (req, res) => {
    const email = cleanEmail(req.body.email);
    const pw = String(req.body.password || "");
    if (!email || !pw) return bad(res, 400, "Enter your email and password.");
    const { rows } = await q("SELECT id, password_hash, status FROM users WHERE email=$1", [email]);
    const u = rows[0];
    if (!u || !(await bcrypt.compare(pw, u.password_hash))) return bad(res, 401, "That email and password don't match.");
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
    const hotels = (await q("SELECT id, name, ready FROM hotels ORDER BY name")).rows;
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
    const mgr = RANK[req.user.role] >= 1;
    const [cats, sops, contacts, routes, s] = await Promise.all([
      q("SELECT name, prefix FROM categories WHERE hotel_id=$1 ORDER BY sort", [req.hotel]),
      q(`SELECT * FROM sops WHERE hotel_id=$1 ${mgr ? "" : "AND status='live'"} ORDER BY id`, [req.hotel]),
      q("SELECT id, role, name, phone FROM contacts WHERE hotel_id=$1 ORDER BY id", [req.hotel]),
      q("SELECT id, label, sub, first_role AS first, then_role AS then, joiner AS join FROM routes WHERE hotel_id=$1 ORDER BY sort", [req.hotel]),
      settingsRow(),
    ]);
    res.json({
      hotel: req.hotel,
      cats: cats.rows,
      sops: sops.rows.map(sopOut),
      contacts: contacts.rows,
      routes: routes.rows,
      settings: publicSettings(s, req.user.role === "Admin"),
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
    const sops = (await q("SELECT * FROM sops WHERE hotel_id=$1 AND status='live'", [req.hotel])).rows;
    const s = await settingsRow();
    const cfg = aiConfig(s);
    let sop = null,
      by = "none",
      general = null,
      aiError = null;
    if (cfg) {
      try {
        const shortlist = rank(question, sops, 8).map((x) => ({ ...x.s, category: x.s.category }));
        const out = await ai.pickSop(cfg, question, shortlist, sops, { sourceOnly: s.source_only });
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
        const contacts = (await q("SELECT role, name, phone FROM contacts WHERE hotel_id=$1", [req.hotel])).rows;
        answer = await ai.answerFromSop(cfg, question, forModel(sop, contacts));
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
    status: b.status === "draft" ? "draft" : "live",
  };
}

app.post(
  "/api/sops",
  auth("Manager"),
  hotel,
  wrap(async (req, res) => {
    const d = validSop(req.body);
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
      await c.query("INSERT INTO sop_history (hotel_id, sop_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4,$5)", [
        req.hotel, cur.id, cur.version, JSON.stringify(sopOut(cur)), req.user.id,
      ]);
      const r = await c.query(
        `UPDATE sops SET category=$3, title=$4, steps=$5, script=$6, flag=$7, keywords=$8, status=$9,
                version=version+1, updated_at=now(), updated_by=$10
          WHERE hotel_id=$1 AND id=$2 RETURNING *`,
        [req.hotel, req.params.id, d.cat || cur.category, d.title, JSON.stringify(d.steps), d.script, d.flag, d.kw, d.status, req.user.id]
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
      `SELECT u.id, u.name, u.email, u.role, u.status, u.must_change_pw, u.last_seen,
              COALESCE(array_agg(uh.hotel_id) FILTER (WHERE uh.hotel_id IS NOT NULL), '{}') AS hotels
         FROM users u LEFT JOIN user_hotels uh ON uh.user_id=u.id
        GROUP BY u.id ORDER BY u.name`
    );
    // Managers only see people who share at least one of their hotels.
    const visible = req.user.role === "Admin" ? rows : rows.filter((u) => u.hotels.some((h) => req.user.hotels.includes(h)));
    res.json(visible);
  })
);

function checkUserEdit(req, target, body) {
  const role = body.role;
  if (!RANK.hasOwnProperty(role)) return "Pick a role.";
  if (req.user.role !== "Admin" && (role === "Admin" || (target && target.role === "Admin")))
    return "Only an Admin can manage Admin accounts.";
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
    const email = cleanEmail(req.body.email);
    if (!name) return bad(res, 400, "Add their name.");
    if (!/^\S+@\S+\.\S+$/.test(email)) return bad(res, 400, "Enter a valid work email.");
    const err = checkUserEdit(req, null, req.body);
    if (err) return bad(res, 400, err);
    if ((await q("SELECT 1 FROM users WHERE email=$1", [email])).rows.length) return bad(res, 400, "Someone already uses that email.");
    const pw = tempPassword();
    const id = await tx(async (c) => {
      const r = await c.query(
        "INSERT INTO users (name, email, role, password_hash, must_change_pw) VALUES ($1,$2,$3,$4,TRUE) RETURNING id",
        [name, email, req.body.role, await bcrypt.hash(pw, 12)]
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
    const email = cleanEmail(req.body.email);
    if (!name) return bad(res, 400, "Add their name.");
    if (!/^\S+@\S+\.\S+$/.test(email)) return bad(res, 400, "Enter a valid work email.");
    if ((await q("SELECT 1 FROM users WHERE email=$1 AND id<>$2", [email, target.id])).rows.length)
      return bad(res, 400, "Someone already uses that email.");
    const self = target.id === req.user.id;
    const status = self ? "active" : req.body.status === "off" ? "off" : "active";
    if (self && req.body.role !== req.user.role) return bad(res, 400, "You can't change your own role.");
    await tx(async (c) => {
      await c.query("UPDATE users SET name=$1, email=$2, role=$3, status=$4 WHERE id=$5", [name, email, req.body.role, status, target.id]);
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
    if (target.role === "Admin" && req.user.role !== "Admin") return bad(res, 403, "Only an Admin can reset an Admin.");
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

// ---------- admin settings ----------
app.put(
  "/api/settings",
  auth("Admin"),
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
  auth("Admin"),
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
  console.error(err);
  if (res.headersSent) return next(err);
  bad(res, 500, "Something went wrong on our side. Try again.");
});

app.listen(PORT, () => console.log(`Ask Lotus listening on ${PORT}`));
