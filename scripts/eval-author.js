// Runs three realistic SOP-authoring sessions (a manager briefing the AI with screenshots) through the real ai.authorSop().
// Usage: DATABASE_URL=... APP_SECRET=... node scripts/eval-author.js [filter]
// Uses the AI provider saved in Settings and the screenshots in db/seed-data/updates/img. Reads hotel 'hop' (categories, details,
// contacts, HH-11) and writes nothing to the database. Photo ids here are labels ("img-departure"), not database ids.
const fs = require("fs");
const path = require("path");
const { pool, q } = require("../src/db");
const { decrypt } = require("../src/crypto");
const ai = require("../src/ai");

const HOTEL = "hop";
const IMG_DIR = path.join(__dirname, "..", "db", "seed-data", "updates", "img");
const photo = (id, file, caption) => ({ id, mime: "image/jpeg", b64: fs.readFileSync(path.join(IMG_DIR, file)).toString("base64"), caption });
const PHOTOS = {
  departure: photo("img-departure", "pep-departure-time.jpg"),
  guestline: photo("img-guestline", "pep-guest-line.jpg"),
  quore: photo("img-quore", "quore-late-checkout-example.jpg", "the Quore log book entry we use"),
};

// first: the manager's opening message and photos. replies: answers to questions, in order (a matching option is picked if offered).
// expect.img: photo id -> regex the step carrying it must match. expect.tokens: tokens that should appear somewhere.
const S = [
  {
    name: "new: Diamond Reserve checkout confirm",
    first: { text: "When a Diamond Reserve member checks in we need to confirm their 4 PM checkout. They get 4 PM guaranteed, but ask what time they really want. In PEP you open the reservation, go to the Stay tab and set the Departure Time. Then tell housekeeping on WhatsApp so they can plan the room. Screenshot of the Departure Time field attached.", images: [PHOTOS.departure] },
    replies: ["The AGM", "Housekeeping WhatsApp chat"],
    expect: { img: { "img-departure": /departure|stay tab/i }, maxTurns: 3, any: true },
  },
  {
    name: "new: log book labeling standard (keep their wording)",
    first: { text: "Here is how we label every log book entry in Quore. Open Add Log Book. The headline is the guest line copied from the top of the reservation in PEP (confirmation number / LAST, FIRST / Room - number) and then \"- Department- Topic\", for example \"96879812 / ACKERLEY, LORI / Room - 517- Housekeeping- Late Checkout\". The entry says what we confirmed with the guest, what we changed in PEP and who we told. Date is today and property is this hotel. First picture shows where to copy the guest line, second is a finished entry.", images: [PHOTOS.guestline, PHOTOS.quore] },
    replies: ["No, that's everything"],
    expect: { img: { "img-guestline": /guest line|copy|headline/i, "img-quore": /post|date|property|entry/i }, keep: ["- Department- Topic", "Add Log Book"], maxTurns: 3 },
  },
  {
    name: "edit: add a Quore step to HH-11",
    editId: "HH-11",
    first: { text: "add a step after 3 about checking Quore for an existing late checkout entry first. Screenshot of what an entry looks like is attached.", images: [PHOTOS.quore] },
    replies: [],
    expect: { img: { "img-quore": /quore/i }, stepDelta: 1, stepAt: [3, /quore/i], keepPhotos: true, maxTurns: 2 },
  },
];

const facts = (text) => (String(text).match(/\$\s?\d[\d,.]*|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{1,2}(:\d\d)?\s?(am|pm)\b/gi) || []).map((x) => x.toLowerCase().replace(/\s+/g, ""));

async function main() {
  const filter = (process.argv[2] || "").toLowerCase();
  const s = (await q("SELECT * FROM settings WHERE id=1")).rows[0];
  if (!s.key_enc || s.provider === "none") throw new Error("No AI provider is configured in Settings.");
  const cfg = { provider: s.provider, model: s.model, baseUrl: s.base_url, apiKey: decrypt(s.key_enc) };
  const h = (await q("SELECT id, name, system, details FROM hotels WHERE id=$1", [HOTEL])).rows[0];
  const categories = (await q("SELECT name FROM categories WHERE hotel_id=$1 ORDER BY sort", [HOTEL])).rows.map((r) => r.name);
  const roles = (await q("SELECT role FROM contacts WHERE hotel_id=$1 ORDER BY id", [HOTEL])).rows.map((r) => r.role);
  const detailKeys = Object.entries(h.details || {}).filter(([, v]) => String(v ?? "").trim()).map(([k]) => k);
  const system = h.system === "pep" ? "PEP (Hilton's name for HotelKey NextGen)" : "HotelKey";
  let pass = 0, fail = 0;

  for (const sc of S) {
    if (filter && !sc.name.toLowerCase().includes(filter)) continue;
    let draft = null, existing = null;
    if (sc.editId) {
      const r = (await q("SELECT id, title, category, steps, script, flag, keywords FROM sops WHERE hotel_id=$1 AND id=$2", [HOTEL, sc.editId])).rows[0];
      if (!r) { console.log(`SKIP ${sc.name}: ${sc.editId} not found`); continue; }
      draft = { title: r.title, category: r.category, steps: r.steps.map((x) => ({ t: x.t, img: x.img || null })), script: r.script, flag: r.flag, kw: r.keywords };
      existing = { id: r.id, title: r.title, category: r.category };
    }
    const startSteps = draft ? draft.steps.length : 0;
    const turns = [], checks = [], log = [];
    const sent = [];
    let msg = sc.first, replies = 0, asks = 0, guard = 0, result = null, ms = 0;
    while (msg && guard++ < 6) {
      for (const im of msg.images || []) if (!sent.some((x) => x.id === im.id)) sent.push(im);
      turns.push({ role: "manager", text: msg.text, images: (msg.images || []).map((i) => ({ id: i.id, caption: i.caption })) });
      log.push(`MANAGER: ${msg.text}${(msg.images || []).length ? ` [${msg.images.map((i) => i.id).join(", ")}]` : ""}`);
      const t0 = Date.now();
      let r;
      try {
        r = await ai.authorSop(cfg, { hotelName: h.name, system, categories, detailKeys, roles, existingSop: existing, draft, turns, images: sent.slice(-6), allowedImages: draft ? draft.steps.map((x) => x.img).filter(Boolean) : [], asks });
      } catch (e) { checks.push(["AI answered", false, e.message]); break; }
      ms += Date.now() - t0;
      if (r.action === "ask") {
        asks++;
        turns.push({ role: "assistant", kind: "ask", question: r.question, options: r.options });
        log.push(`AI asks: ${r.question}${r.options.length ? `  [${r.options.join(" | ")}]` : ""}`);
        const want = sc.replies[replies++];
        if (want === undefined) { checks.push(["asked more questions than the script expected", false, r.question]); break; }
        const m = r.options.find((o) => o.toLowerCase() === want.toLowerCase());
        msg = { text: m || want, images: [] };
      } else {
        asks = 0; draft = r.sop; result = r;
        turns.push({ role: "assistant", kind: "draft", notes: r.notes });
        log.push(`AI draft: ${r.sop.title} [${r.sop.category}]`, ...r.sop.steps.map((x, i) => `   ${i + 1}. ${x.t}${x.img ? `  <${x.img}>` : ""}`), r.sop.script ? `   say: ${r.sop.script}` : "", r.sop.flag ? `   call: ${r.sop.flag}` : "", `   kw: ${r.sop.kw}`, `   notes: ${r.notes}`, r.missing.length ? `   missing: ${r.missing.join("; ")}` : "");
        msg = null;
      }
    }
    const ex = sc.expect || {};
    checks.push(["ended in a draft", !!result]);
    checks.push([`within ${ex.maxTurns || 3} AI turns`, turns.filter((t) => t.role === "assistant").length <= (ex.maxTurns || 3)]);
    if (result) {
      const d = result.sop, text = [d.title, ...d.steps.map((x) => x.t), d.script, d.flag].join(" ");
      checks.push(["category is an existing one", categories.includes(d.category)]);
      checks.push(["no [CHECK] text", !/\[CHECK/i.test(text)]);
      checks.push(["steps are short (<= 45 words)", d.steps.every((x) => x.t.split(/\s+/).length <= 45)]);
      const allowed = new Set([...facts(sc.first.text), ...facts(JSON.stringify(sc.replies || [])), ...facts(JSON.stringify(h.details || {})), ...(draft ? facts(JSON.stringify(sc.editId ? startSteps : "")) : [])]);
      const startText = sc.editId ? facts((await q("SELECT steps::text || script || flag AS t FROM sops WHERE hotel_id=$1 AND id=$2", [HOTEL, sc.editId])).rows[0].t) : [];
      const invented = facts(text).filter((f) => !allowed.has(f) && !startText.includes(f));
      checks.push(["no invented prices, phones or times", !invented.length, invented.join(", ")]);
      const badTok = [...text.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).filter((k) => ![...roles, ...detailKeys].some((x) => x.toLowerCase() === k.toLowerCase()));
      checks.push(["only known {tokens}", !badTok.length, badTok.join(", ")]);
      for (const [id, re] of Object.entries(ex.img || {})) {
        const st = d.steps.find((x) => x.img === id);
        checks.push([`photo ${id} placed on a fitting step`, !!st && re.test(st.t), st ? st.t.slice(0, 70) : "not placed"]);
      }
      for (const k of ex.keep || []) checks.push([`kept their wording "${k}"`, text.includes(k)]);
      if (ex.stepDelta !== undefined) checks.push([`one step added (${startSteps} -> ${startSteps + ex.stepDelta})`, d.steps.length === startSteps + ex.stepDelta, `got ${d.steps.length}`]);
      if (ex.stepAt) checks.push([`new step is step ${ex.stepAt[0] + 1}`, !!d.steps[ex.stepAt[0]] && ex.stepAt[1].test(d.steps[ex.stepAt[0]].t), (d.steps[ex.stepAt[0]] || {}).t]);
      if (ex.keepPhotos && sc.editId) {
        const orig = (await q("SELECT steps FROM sops WHERE hotel_id=$1 AND id=$2", [HOTEL, sc.editId])).rows[0].steps.filter((x) => x.img).length;
        checks.push([`existing photos kept (${orig})`, d.steps.filter((x) => x.img && !String(x.img).startsWith("img-")).length === orig]);
      }
    }
    const bad = checks.filter((c) => !c[1]);
    console.log(`\n=== ${sc.name}  (${(ms / 1000).toFixed(1)}s of AI time)\n${log.filter(Boolean).join("\n")}`);
    for (const [n, okc, extra] of checks) console.log(`  ${okc ? "PASS" : "FAIL"} ${n}${!okc && extra ? `: ${extra}` : ""}`);
    if (bad.length) fail++; else pass++;
  }
  console.log(`\n${pass} sessions passed, ${fail} failed.`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(2); });
