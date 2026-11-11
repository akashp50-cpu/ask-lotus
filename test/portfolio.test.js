// API tests for brand groups: Needs you (/api/home), the Owner's Portfolio and its switch, suggestions between hotels in a group,
// Add hotel copy rules, and brands / PMS lists. They start the real server against DATABASE_URL (a throwaway database) and are skipped when it is not set.
const test = require("node:test");
const assert = require("node:assert");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB = process.env.DATABASE_URL;
const skip = !DB && "DATABASE_URL is not set";
const ROOT = path.join(__dirname, "..");
const PW = "Test-password-1234";
// Group X = tbx|tpx (A live, B live, C live, D setup). Group Y = tby|tpx (E live, same PMS, other brand). Group Z = tbx|tpz (F live: other PMS).
const A = "tpfa", B = "tpfb", C = "tpfc", D = "tpfd", E = "tpfe", F = "tpff";
const HOTELS = [A, B, C, D, E, F];
const WHO = [["tpf_mgr", "Manager", A], ["tpf_gma", "GM", A], ["tpf_gmb", "GM", B], ["tpf_gmc", "GM", C], ["tpf_owner", "Owner", A]];
let srv, base, pool;
const jar = {};
async function call(user, method, url, body) {
  const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(jar[user] ? { cookie: jar[user] } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get("set-cookie");
  if (sc) jar[user] = sc.split(";")[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}
const sopBody = (title, extra = {}) => ({ title, cat: "Tpf cat", steps: [{ t: "Do the thing.", img: null }], script: "", flag: "", kw: "", status: "live", ...extra });
const st = async (h, id) => ((await pool.query("SELECT status FROM sops WHERE hotel_id=$1 AND id=$2", [h, id])).rows[0] || {}).status;
const sugs = async (user, h) => (await call(user, "GET", `/api/suggestions?hotel=${h}`)).body;

test.before(async () => {
  if (skip) return;
  execFileSync("node", ["db/migrate.js"], { cwd: ROOT, env: process.env, stdio: "ignore" });
  ({ pool } = require("../src/db"));
  const clean = async () => {
    await pool.query("DELETE FROM users WHERE username LIKE 'tpf\\_%'");
    await pool.query("DELETE FROM hotels WHERE id = ANY($1) OR name LIKE 'Tpf %'", [HOTELS]);
    await pool.query("DELETE FROM brands WHERE id IN ('tbx','tby') OR name LIKE 'Tpf %'");
    await pool.query("DELETE FROM pms WHERE id IN ('tpx','tpz') OR name LIKE 'Tpf %'");
    await pool.query("DELETE FROM imports WHERE filenames = '{tpf.pdf}'");
  };
  test.clean = clean;
  await clean();
  await pool.query("INSERT INTO brands (id,name,sort) VALUES ('tbx','Tpf Brand X',90),('tby','Tpf Brand Y',91)");
  await pool.query("INSERT INTO pms (id,name,staff_name,rules,sort) VALUES ('tpx','Tpf PMS X','TPX','Say TPX.',90),('tpz','Tpf PMS Z','TPZ','',91)");
  const H = (id, name, brand, system, setup, answers = "{}") => pool.query(
    "INSERT INTO hotels (id,name,brand,system,setup,ready,answers,details) VALUES ($1,$2,$3,$4,$5,$6,$7,'{}')", [id, name, brand, system, setup, setup === "live", answers]);
  await H(A, "Tpf Alpha Inn", "tbx", "tpx", "live"); await H(B, "Tpf Bravo Inn", "tbx", "tpx", "live", '{"pool":false}'); await H(C, "Tpf Charlie Inn", "tbx", "tpx", "live");
  await H(D, "Tpf Delta Inn", "tbx", "tpx", "setup"); await H(E, "Tpf Echo Inn", "tby", "tpx", "live"); await H(F, "Tpf Foxtrot Inn", "tbx", "tpz", "live");
  for (const h of HOTELS) await pool.query("INSERT INTO categories (hotel_id,name,prefix) VALUES ($1,'Tpf cat','ZT')", [h]);
  const hash = await bcrypt.hash(PW, 4);
  for (const [u, role, h] of WHO) {
    const id = (await pool.query("INSERT INTO users (name,username,role,password_hash,must_change_pw) VALUES ($1,$2,$3,$4,FALSE) RETURNING id", [`${u} P`, u, role, hash])).rows[0].id;
    await pool.query("INSERT INTO user_hotels VALUES ($1,$2)", [id, h]);
  }
  // Seed SOPs at A: general (live), PMS (live), brand (off), a draft, and one that needs a pool. kind and family are filled in by the server on save.
  const port = 4900 + Math.floor(Math.random() * 90);
  srv = spawn("node", ["src/server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), APP_SECRET: "x".repeat(40), NODE_ENV: "test" }, stdio: ["ignore", "pipe", "inherit"] });
  base = `http://127.0.0.1:${port}`;
  await new Promise((res, rej) => { srv.stdout.on("data", (b) => /listening/.test(String(b)) && res()); srv.on("exit", () => rej(new Error("server exited"))); });
  for (const [u] of WHO) assert.strictEqual((await call(u, "POST", "/api/login", { username: u, password: PW })).status, 200);
  const mk = async (title, extra) => { const r = await call("tpf_gma", "POST", `/api/sops?hotel=${A}`, sopBody(title, extra)); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); return r.body; };
  test.mk = mk;
});
test.after(async () => {
  if (srv) srv.kill();
  if (pool) { if (test.clean) await test.clean(); await pool.end(); }
});

test("saving a SOP classifies its kind (general, PMS, brand) and gives it a family; the editor's Type wins", { skip }, async () => {
  const g = await test.mk("Tpf fire drill", { steps: [{ t: "Walk the floors.", img: null }] });
  assert.strictEqual(g.kind, "general");
  assert.strictEqual(g.family, `${A}:${g.id}`);
  const p = await test.mk("Tpf pms check-in", { steps: [{ t: "Open the reservation in the folio tab.", img: null }], hotelOnly: true });
  assert.strictEqual(p.kind, "pms");
  const b = await test.mk("Tpf honors arrival", { steps: [{ t: "Greet the Hilton Honors guest.", img: null }], hotelOnly: true });
  assert.strictEqual(b.kind, "brand");
  const forced = await test.mk("Tpf forced", { kind: "brand", hotelOnly: true });
  assert.strictEqual(forced.kind, "brand");
  test.sops = { g, p, b, forced };
});

test("a new live SOP is suggested to the other live hotels in its group only, never across groups or to a hotel in setup", { skip }, async () => {
  const { g } = test.sops;
  const sb = await sugs("tpf_gmb", B), sc = await sugs("tpf_gmc", C);
  assert.strictEqual(sb.length, 1); assert.strictEqual(sc.length, 1);
  assert.strictEqual(sb[0].type, "new"); assert.strictEqual(sb[0].family, g.family); assert.strictEqual(sb[0].label, "New");
  assert.strictEqual(sb[0].from.id, A); assert.strictEqual(sb[0].title, "Tpf fire drill");
  for (const h of [D, E, F]) assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM sop_suggestions WHERE to_hotel=$1", [h])).rows[0].n, 0, h);
  assert.deepStrictEqual(await sugs("tpf_gma", A), []); // not to itself
});

test("'This hotel only' publishes without suggesting (kinds above were saved that way)", { skip }, async () => {
  const sb = await sugs("tpf_gmb", B);
  assert.ok(sb.every((x) => x.title === "Tpf fire drill"));
  const r = await call("tpf_gma", "POST", `/api/sops?hotel=${A}`, sopBody("Tpf quiet one", { hotelOnly: true }));
  assert.strictEqual(r.body.suggested, 0);
  assert.strictEqual((await sugs("tpf_gmb", B)).length, 1);
});

test("suggestions are GM and up, and a GM only sees and handles their own hotel's", { skip }, async () => {
  assert.strictEqual((await call("tpf_mgr", "GET", `/api/suggestions?hotel=${A}`)).status, 403);
  assert.strictEqual((await call("tpf_gmb", "GET", `/api/suggestions?hotel=${A}`)).status, 403); // not their hotel
  const id = (await sugs("tpf_gmb", B))[0].id;
  assert.strictEqual((await call("tpf_gmc", "POST", `/api/suggestions/${id}/add?hotel=${C}`, {})).status, 404); // C's GM cannot act on B's row
  assert.strictEqual((await call("tpf_gmb", "POST", `/api/suggestions/${id}/add?hotel=${A}`, {})).status, 403);
});

test("Add makes the SOP live at the hotel with the same family and kind; the suggestion is done", { skip }, async () => {
  const { g } = test.sops;
  const id = (await sugs("tpf_gmb", B))[0].id;
  const r = await call("tpf_gmb", "POST", `/api/suggestions/${id}/add?hotel=${B}`, {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.sop.family, g.family); assert.strictEqual(r.body.sop.kind, "general"); assert.strictEqual(r.body.sop.status, "live");
  assert.deepStrictEqual(await sugs("tpf_gmb", B), []);
  assert.strictEqual((await call("tpf_gmb", "POST", `/api/suggestions/${id}/add?hotel=${B}`, {})).status, 400); // already handled
  // Skip leaves nothing behind at C
  const sc = (await sugs("tpf_gmc", C))[0];
  assert.strictEqual((await call("tpf_gmc", "POST", `/api/suggestions/${sc.id}/skip?hotel=${C}`, {})).status, 200);
  assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM sops WHERE hotel_id=$1 AND title='Tpf fire drill'", [C])).rows[0].n, 0);
  assert.deepStrictEqual(await sugs("tpf_gmc", C), []);
});

test("a change to a SOP the group shares becomes a 'change' suggestion; a newer one supersedes the older open one", { skip }, async () => {
  const { g } = test.sops;
  const put = (extra) => call("tpf_gma", "PUT", `/api/sops/${g.id}?hotel=${A}`, sopBody("Tpf fire drill", extra));
  assert.strictEqual((await put({ steps: [{ t: "Walk the floors twice.", img: null }] })).status, 200);
  const first = await sugs("tpf_gmb", B);
  assert.strictEqual(first.length, 1);
  assert.strictEqual(first[0].type, "change"); assert.deepStrictEqual(first[0].changed, ["steps"]); assert.strictEqual(first[0].label, "Steps changed");
  assert.strictEqual(first[0].own.id, (await pool.query("SELECT id FROM sops WHERE hotel_id=$1 AND family=$2", [B, g.family])).rows[0].id);
  assert.strictEqual(first[0].own.status, "live");
  // C skipped the new one earlier, so the change arrives as New for C (it does not have it)
  assert.strictEqual((await sugs("tpf_gmc", C))[0].type, "new");
  // a second edit supersedes the first (still one open suggestion per hotel)
  assert.strictEqual((await put({ steps: [{ t: "Walk the floors twice.", img: null }], script: "Stay calm." })).status, 200);
  const second = await sugs("tpf_gmb", B);
  assert.strictEqual(second.length, 1); assert.notStrictEqual(second[0].id, first[0].id);
  assert.deepStrictEqual(second[0].changed, ["steps", "script"]);
  assert.strictEqual((await pool.query("SELECT status FROM sop_suggestions WHERE id=$1", [first[0].id])).rows[0].status, "superseded");
  // an off/on switch alone suggests nothing new, and "this hotel only" suppresses the change
  assert.strictEqual((await put({ steps: [{ t: "A private tweak.", img: null }], hotelOnly: true })).body.suggested, 0);
  assert.strictEqual((await sugs("tpf_gmb", B))[0].id, second[0].id);
  test.change = second[0];
});

test("Use replaces our copy with the group's wording and bumps its version; Keep mine leaves it", { skip }, async () => {
  const sg = test.change, own = sg.own.id;
  const v0 = (await pool.query("SELECT version, steps FROM sops WHERE hotel_id=$1 AND id=$2", [B, own])).rows[0];
  const keep = await call("tpf_gmb", "POST", `/api/suggestions/${sg.id}/keep?hotel=${B}`, {});
  assert.strictEqual(keep.status, 200);
  assert.strictEqual((await pool.query("SELECT version FROM sops WHERE hotel_id=$1 AND id=$2", [B, own])).rows[0].version, v0.version);
  assert.deepStrictEqual(await sugs("tpf_gmb", B), []);
  // the next change from A comes again
  await call("tpf_gma", "PUT", `/api/sops/${test.sops.g.id}?hotel=${A}`, sopBody("Tpf fire drill", { steps: [{ t: "Walk and count.", img: null }] }));
  const again = (await sugs("tpf_gmb", B))[0];
  const use = await call("tpf_gmb", "POST", `/api/suggestions/${again.id}/use?hotel=${B}`, {});
  assert.strictEqual(use.status, 200, JSON.stringify(use.body));
  const after = (await pool.query("SELECT version, steps FROM sops WHERE hotel_id=$1 AND id=$2", [B, own])).rows[0];
  assert.strictEqual(after.version, v0.version + 1);
  assert.strictEqual(after.steps[0].t, "Walk and count.");
  assert.deepStrictEqual(await sugs("tpf_gmb", B), []);
});

test("Tweak: the seed gives the group's wording and saving it closes the suggestion", { skip }, async () => {
  const r = await call("tpf_gma", "POST", `/api/sops?hotel=${A}`, sopBody("Tpf lost keys"));
  const sg = (await sugs("tpf_gmc", C)).find((x) => x.title === "Tpf lost keys");
  assert.ok(sg);
  const seed = await call("tpf_gmc", "GET", `/api/suggestions/${sg.id}/seed?hotel=${C}`);
  assert.strictEqual(seed.status, 200); assert.strictEqual(seed.body.type, "new"); assert.strictEqual(seed.body.draft.title, "Tpf lost keys");
  const save = await call("tpf_gmc", "POST", `/api/sops?hotel=${C}`, sopBody("Tpf lost keys (our way)", { suggestion: sg.id, hotelOnly: true }));
  assert.strictEqual(save.status, 200, JSON.stringify(save.body));
  assert.strictEqual(save.body.family, r.body.family); // the same SOP to the group
  assert.ok(!(await sugs("tpf_gmc", C)).some((x) => x.id === sg.id));
});

test("a suggestion for a SOP that needs an amenity the hotel said it doesn't have is not sent", { skip }, async () => {
  const r = await call("tpf_gma", "POST", `/api/sops?hotel=${A}`, sopBody("Tpf pool rules"));
  await pool.query("UPDATE sops SET requires='pool' WHERE hotel_id=$1 AND id=$2", [A, r.body.id]);
  await call("tpf_gma", "PUT", `/api/sops/${r.body.id}?hotel=${A}`, sopBody("Tpf pool rules", { steps: [{ t: "Check the gate.", img: null }] }));
  assert.ok(!(await sugs("tpf_gmb", B)).some((x) => x.title === "Tpf pool rules")); // B has no pool (answers.pool=false)
  assert.ok((await sugs("tpf_gmc", C)).some((x) => x.title === "Tpf pool rules"));
});

test("GET /api/home carries suggestions, drafts, waiting imports and missing details; GM and up only; no master updates", { skip }, async () => {
  assert.strictEqual((await call("tpf_mgr", "GET", `/api/home?hotel=${A}`)).status, 403);
  await call("tpf_gma", "POST", `/api/sops?hotel=${A}`, sopBody("Tpf draft one", { status: "draft" }));
  await pool.query("INSERT INTO imports (hotel_id,kind,filenames,status,result) VALUES ($1,'ai','{tpf.pdf}','review','{\"matches\":[],\"details\":[],\"new\":[{\"title\":\"T\",\"state\":null},{\"title\":\"U\",\"state\":\"added\"}]}')", [A]);
  const a = (await call("tpf_gma", "GET", `/api/home?hotel=${A}`)).body;
  assert.strictEqual(a.drafts, 1); assert.strictEqual(a.imports.length, 1); assert.strictEqual(a.imports[0].open, 1);
  assert.strictEqual(a.updates, undefined); assert.strictEqual(a.fresh, undefined);
  assert.strictEqual(a.brand, "tbx"); assert.strictEqual(a.system, "tpx");
  const c = (await call("tpf_gmc", "GET", `/api/home?hotel=${C}`)).body;
  assert.ok(c.suggestions.length >= 1); assert.deepStrictEqual(c.imports, []);
});

test("GET /api/owner/portfolio is Owner only: one group per brand + PMS, hotels as columns, SOP families as rows with on/off/sug/none", { skip }, async () => {
  assert.strictEqual((await call("tpf_gma", "GET", "/api/owner/portfolio")).status, 403);
  const { status, body } = await call("tpf_owner", "GET", "/api/owner/portfolio");
  assert.strictEqual(status, 200);
  const grp = (k) => body.groups.find((x) => x.key === k);
  assert.deepStrictEqual(grp("tbx|tpx").hotels.map((h) => h.id).sort(), [A, B, C, D]);
  assert.deepStrictEqual(grp("tby|tpx").hotels.map((h) => h.id), [E]);
  assert.deepStrictEqual(grp("tbx|tpz").hotels.map((h) => h.id), [F]);
  assert.strictEqual(grp("tbx|tpx").name, "Tpf Brand X · Tpf PMS X");
  const X = grp("tbx|tpx"), cols = X.hotels.map((h) => h.id);
  assert.match(X.hotels.find((h) => h.id === D).status, /^Setup/); assert.strictEqual(X.hotels.find((h) => h.id === A).status, "Live");
  const rows = X.sections.flatMap((s) => s.sops), row = (t) => rows.find((r) => r.title === t);
  const cellOf = (r, h) => r.cells[cols.indexOf(h)];
  const fire = row("Tpf fire drill");
  assert.strictEqual(fire.kind, "general");
  assert.strictEqual(cellOf(fire, A).s, "on"); assert.strictEqual(cellOf(fire, B).s, "on"); // B used the change, so nothing is waiting
  assert.strictEqual(cellOf(fire, D).s, "none");
  const lost = row("Tpf lost keys");
  assert.strictEqual(cellOf(lost, B).s, "sug"); assert.strictEqual(cellOf(lost, B).b, "none");
  const draft = row("Tpf draft one");
  assert.strictEqual(cellOf(draft, A).s, "off"); // a draft counts as off
  assert.ok(!grp("tby|tpx").sections.flatMap((s) => s.sops).some((r) => r.title === "Tpf fire drill")); // nothing crosses groups
  assert.ok(body.brands.some((b) => b.id === "tbx")); assert.ok(body.pms.some((p) => p.id === "tpx" && p.staff === "TPX"));
});

test("PUT /api/owner/hotels/:hotelId/sops/:family: Owner only, switches a SOP, adds a missing one from the group, refuses a hotel not live", { skip }, async () => {
  const url = (h, f) => `/api/owner/hotels/${h}/sops/${encodeURIComponent(f)}`;
  const g = test.sops.g, fam = g.family;
  assert.strictEqual((await call("tpf_gma", "PUT", url(A, fam), { on: false })).status, 403);
  assert.strictEqual((await call("tpf_owner", "PUT", url(A, fam), {})).status, 400);
  assert.strictEqual((await call("tpf_owner", "PUT", url(A, fam), { on: false })).status, 200);
  assert.strictEqual(await st(A, g.id), "off");
  assert.strictEqual((await call("tpf_owner", "PUT", url(A, fam), { on: true })).status, 200);
  assert.strictEqual(await st(A, g.id), "live");
  // C skipped it: adding turns it on there with the same family
  assert.strictEqual((await call("tpf_owner", "PUT", url(C, fam), { on: true })).status, 200);
  const row = (await pool.query("SELECT status, family, kind FROM sops WHERE hotel_id=$1 AND family=$2", [C, fam])).rows[0];
  assert.deepStrictEqual({ ...row }, { status: "live", family: fam, kind: "general" });
  // refusals: a hotel not live, a PMS SOP into another PMS's group (no hotel there has it), unknown hotel
  assert.strictEqual((await call("tpf_owner", "PUT", url(D, fam), { on: true })).status, 400);
  assert.strictEqual((await call("tpf_owner", "PUT", url(F, test.sops.p.family), { on: true })).status, 400);
  assert.strictEqual((await call("tpf_owner", "PUT", url("nope", fam), { on: true })).status, 404);
});

test("Add hotel copies general always, PMS only on the same PMS, brand only on the same brand; keeps family, kind and status", { skip }, async () => {
  assert.strictEqual((await call("tpf_gma", "POST", "/api/owner/hotels", { name: "Tpf x", brand: "tbx", system: "tpx" })).status, 403);
  // the source: A has general (live), PMS (live, hotel only), brand (live, hotel only) and an off general
  await pool.query("UPDATE sops SET status='off' WHERE hotel_id=$1 AND title='Tpf quiet one'", [A]);
  const make = (name, brand, system) => call("tpf_owner", "POST", "/api/owner/hotels", { name, brand, system, copyFrom: A });
  const kinds = async (id) => Object.fromEntries((await pool.query("SELECT title, kind, status, family FROM sops WHERE hotel_id=$1 AND title LIKE 'Tpf %'", [id])).rows.map((r) => [r.title, r]));
  const same = await make("Tpf New Same", "tbx", "tpx");
  assert.strictEqual(same.status, 200, JSON.stringify(same.body));
  assert.ok(same.body.copied.general >= 1 && same.body.copied.pms >= 1 && same.body.copied.brand >= 1);
  const s = await kinds(same.body.id);
  assert.strictEqual(s["Tpf pms check-in"].kind, "pms"); assert.strictEqual(s["Tpf honors arrival"].kind, "brand");
  assert.strictEqual(s["Tpf quiet one"].status, "off"); assert.strictEqual(s["Tpf fire drill"].status, "live"); // start as they are at the source
  assert.strictEqual(s["Tpf fire drill"].family, test.sops.g.family);
  assert.ok(!s["Tpf draft one"]); // drafts are not copied
  const otherPms = await make("Tpf New OtherPms", "tbx", "tpz");
  const o = await kinds(otherPms.body.id);
  assert.ok(o["Tpf fire drill"] && o["Tpf honors arrival"]); assert.ok(!o["Tpf pms check-in"]); // PMS differs: left out; brand matches: copied
  assert.ok(otherPms.body.left.pms >= 1);
  const otherBrand = await make("Tpf New OtherBrand", "tby", "tpx");
  const b = await kinds(otherBrand.body.id);
  assert.ok(b["Tpf pms check-in"] && !b["Tpf honors arrival"]); // brand differs: left out
  const fresh = await make("Tpf New Fresh", "tby", "tpz"); // a new brand + PMS group gets general only
  const f = await kinds(fresh.body.id);
  assert.ok(f["Tpf fire drill"]); assert.ok(!f["Tpf pms check-in"] && !f["Tpf honors arrival"]);
  // the copy preview says the same
  const pv = (await call("tpf_owner", "GET", `/api/owner/copy-preview?from=${A}&brand=tby&system=tpz`)).body;
  assert.strictEqual(pv.pms.copied, false); assert.strictEqual(pv.brand.copied, false); assert.strictEqual(pv.general.copied, true);
  // refusals
  assert.strictEqual((await call("tpf_owner", "POST", "/api/owner/hotels", { name: "Tpf New Same", brand: "tbx", system: "tpx" })).status, 400); // name taken
  assert.strictEqual((await call("tpf_owner", "POST", "/api/owner/hotels", { name: "Tpf Z", brand: "nope", system: "tpx" })).status, 400);
  assert.strictEqual((await call("tpf_owner", "POST", "/api/owner/hotels", { name: "Tpf Z", brand: "tbx", system: "tpx", copyFrom: "nope" })).status, 400);
});

test("brands and PMS are Owner-editable lists", { skip }, async () => {
  assert.strictEqual((await call("tpf_gma", "POST", "/api/owner/brands", { name: "Tpf Nope" })).status, 403);
  const b = await call("tpf_owner", "POST", "/api/owner/brands", { name: "Tpf Marriott" });
  assert.strictEqual(b.status, 200); assert.strictEqual(b.body.name, "Tpf Marriott");
  assert.strictEqual((await call("tpf_owner", "POST", "/api/owner/brands", { name: "tpf marriott" })).status, 400); // a duplicate
  assert.strictEqual((await call("tpf_owner", "POST", "/api/owner/brands", { name: " " })).status, 400);
  const p = await call("tpf_owner", "POST", "/api/owner/pms", { name: "Tpf Opera", staff: "Opera", rules: 'Say "Opera".' });
  assert.strictEqual(p.status, 200); assert.strictEqual(p.body.staff, "Opera");
  const put = await call("tpf_owner", "PUT", `/api/owner/pms/${p.body.id}`, { name: "Tpf Opera Cloud", staff: "Opera", rules: "The folio is the Guest Ledger." });
  assert.strictEqual(put.status, 200); assert.strictEqual(put.body.rules, "The folio is the Guest Ledger.");
  assert.strictEqual((await call("tpf_owner", "PUT", "/api/owner/pms/nope", { name: "x" })).status, 404);
  const me = (await call("tpf_gma", "GET", "/api/me")).body;
  assert.ok(me.brands.some((x) => x.id === b.body.id)); assert.ok(me.pms.some((x) => x.id === p.body.id && x.name === "Tpf Opera Cloud"));
  // a hotel's PMS rules reach the bootstrap the app reads (the AI prompts use the same row)
  await pool.query("UPDATE hotels SET system=$2 WHERE id=$1", [F, p.body.id]);
  const boot = (await call("tpf_owner", "GET", `/api/bootstrap?hotel=${F}`)).body;
  assert.strictEqual(boot.info.pms, "Tpf Opera Cloud"); assert.strictEqual(boot.info.pmsStaff, "Opera");
  await pool.query("UPDATE hotels SET system='tpz' WHERE id=$1", [F]);
  await pool.query("DELETE FROM pms WHERE id=$1", [p.body.id]); await pool.query("DELETE FROM brands WHERE id=$1", [b.body.id]);
});

test("the master update pipeline is gone: no master or updates routes, and nothing in the old matrix", { skip }, async () => {
  for (const [m, u] of [["GET", "/api/master"], ["GET", "/api/owner/matrix"], ["GET", `/api/updates?hotel=${A}`], ["POST", `/api/updates/X-01/accept?hotel=${A}`]]) {
    assert.ok([404, 405].includes((await call("tpf_owner", m, u, m === "POST" ? {} : undefined)).status), `${m} ${u}`);
  }
});
