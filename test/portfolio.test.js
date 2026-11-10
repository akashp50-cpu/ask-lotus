// API tests for the Dashboard's Needs you data (/api/home) and the Owner's Portfolio chart (/api/owner/matrix and the per-hotel switch).
// They start the real server against DATABASE_URL (a throwaway database) and are skipped when it is not set.
const test = require("node:test");
const assert = require("node:assert");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB = process.env.DATABASE_URL;
const skip = !DB && "DATABASE_URL is not set";
const ROOT = path.join(__dirname, "..");
const PW = "Test-password-1234";
const HA = "tpfa", HB = "tpfb", HC = "tpfc"; // Hilton+PEP live, independent+HotelKey live (no pool), independent in setup
const WHO = [["tpf_mgr", "Manager", HA], ["tpf_gm", "GM", HA], ["tpf_owner", "Owner", HA]];
let srv, base, pool;
const jar = {};
async function call(user, method, url, body) {
  const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(jar[user] ? { cookie: jar[user] } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get("set-cookie");
  if (sc) jar[user] = sc.split(";")[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}
const cell = (m, hi) => m.st[hi];

test.before(async () => {
  if (skip) return;
  execFileSync("node", ["db/migrate.js"], { cwd: ROOT, env: process.env, stdio: "ignore" });
  ({ pool } = require("../src/db"));
  const clean = async () => {
    await pool.query("DELETE FROM users WHERE username LIKE 'tpf\\_%'");
    await pool.query("DELETE FROM hotels WHERE id = ANY($1)", [[HA, HB, HC]]);
    await pool.query("DELETE FROM master_sops WHERE id LIKE 'ZT-%'");
    await pool.query("DELETE FROM imports WHERE filenames = '{tpf.pdf}'");
  };
  await clean();
  await pool.query(
    `INSERT INTO hotels (id,name,brand,system,setup,ready,answers,details) VALUES
      ($1,'Tpf Hilton Inn','hilton','pep','live',TRUE,'{"pool":true}','{}'),
      ($2,'Tpf Indie Inn','independent','hotelkey','live',TRUE,'{"pool":false}','{}'),
      ($3,'Tpf Setup Inn','independent','hotelkey','setup',FALSE,'{}','{}')`, [HA, HB, HC]);
  const hash = await bcrypt.hash(PW, 4);
  for (const [u, role, h] of WHO) {
    const id = (await pool.query("INSERT INTO users (name,username,role,password_hash,must_change_pw) VALUES ($1,$2,$3,$4,FALSE) RETURNING id", [`${u} P`, u, role, hash])).rows[0].id;
    await pool.query("INSERT INTO user_hotels VALUES ($1,$2)", [id, h]);
  }
  // Masters: plain, hilton-only, needs a pool, HotelKey wording awaiting review, a draft, and one that moves to v2 (with its history).
  const M = (id, o = {}) => pool.query(
    "INSERT INTO master_sops (id,category,title,steps,applies,requires,hk_status,version,status) VALUES ($1,'Tpf cat',$2,'[{\"t\":\"x\",\"hk\":null,\"img\":null}]',$3,$4,$5,$6,$7)",
    [id, o.title || id, o.applies || "all", o.requires || null, o.hk || "same", o.version || 1, o.status || "live"]);
  await M("ZT-01"); await M("ZT-02", { applies: "hilton" }); await M("ZT-03", { requires: "pool" }); await M("ZT-04", { hk: "draft" });
  await M("ZT-05", { status: "draft" }); await M("ZT-06", { version: 2 }); await M("ZT-07"); await M("ZT-08");
  const copy = (h, id, st, ver = 1, kept = false) => pool.query(
    "INSERT INTO sops (hotel_id,id,category,title,steps,status,master_id,master_version,kept) VALUES ($1,$2,'Tpf cat',$2,'[]',$3,$2,$4,$5)", [h, id, st, ver, kept]);
  await pool.query("INSERT INTO categories (hotel_id,name,prefix) VALUES ($1,'Tpf cat','ZT'),($2,'Tpf cat','ZT')", [HA, HB]);
  await copy(HA, "ZT-01", "live"); await copy(HB, "ZT-01", "off");
  await copy(HA, "ZT-06", "live", 1); await copy(HB, "ZT-06", "live", 1);            // behind the master: Update
  await copy(HA, "ZT-07", "live", 1, true);                                           // the hotel's own wording: Own
  await pool.query("INSERT INTO sops (hotel_id,id,category,title,steps,status) VALUES ($1,'TPF-D1','Tpf cat','Draft one','[]','draft'),($1,'TPF-D2','Tpf cat','Needs {Tpf Blank} filled','[]','live')", [HA]);
  await pool.query("INSERT INTO master_details (key, example, sort) VALUES ('Tpf Blank','x',9999) ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO imports (hotel_id,kind,filenames,status,result) VALUES ($1,'ai','{tpf.pdf}','review','{\"matches\":[],\"details\":[],\"new\":[{\"title\":\"T\",\"state\":null},{\"title\":\"U\",\"state\":\"added\"}]}')", [HA]);
  const port = 4900 + Math.floor(Math.random() * 90);
  srv = spawn("node", ["src/server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), APP_SECRET: "x".repeat(40), NODE_ENV: "test" }, stdio: ["ignore", "pipe", "inherit"] });
  base = `http://127.0.0.1:${port}`;
  await new Promise((res, rej) => { srv.stdout.on("data", (b) => /listening/.test(String(b)) && res()); srv.on("exit", () => rej(new Error("server exited"))); });
  for (const [u] of WHO) assert.strictEqual((await call(u, "POST", "/api/login", { username: u, password: PW })).status, 200);
  test.clean = clean;
});
test.after(async () => {
  if (srv) srv.kill();
  if (pool) {
    if (test.clean) await test.clean();
    await pool.query("DELETE FROM master_details WHERE key='Tpf Blank'");
    await pool.end();
  }
});

test("GET /api/home carries what Needs you shows: drafts, waiting imports, missing details; GM and up only", { skip }, async () => {
  assert.strictEqual((await call("tpf_mgr", "GET", `/api/home?hotel=${HA}`)).status, 403);
  const { status, body } = await call("tpf_gm", "GET", `/api/home?hotel=${HA}`);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.drafts, 1);
  assert.strictEqual(body.imports.length, 1);
  assert.strictEqual(body.imports[0].open, 1); // one undecided, one already added
  assert.deepStrictEqual(body.imports[0].files, ["tpf.pdf"]);
  assert.deepStrictEqual(body.missing, ["Tpf Blank"]);
  assert.ok(body.updates.some((u) => u.sopId === "ZT-06" && !u.kept));
  assert.ok(body.updates.every((u) => u.sopId !== "ZT-07")); // kept copies at the current version are not updates
  // filling the blank clears it
  await pool.query("UPDATE hotels SET details='{\"Tpf Blank\":\"done\"}' WHERE id=$1", [HA]);
  assert.deepStrictEqual((await call("tpf_gm", "GET", `/api/home?hotel=${HA}`)).body.missing, []);
  // hotel scoped: the other hotel has none of it
  await pool.query("INSERT INTO user_hotels SELECT id,$1 FROM users WHERE username='tpf_gm' ON CONFLICT DO NOTHING", [HB]);
  const b = (await call("tpf_gm", "GET", `/api/home?hotel=${HB}`)).body;
  assert.strictEqual(b.drafts, 0); assert.deepStrictEqual(b.imports, []);
});

test("GET /api/owner/matrix is Owner only and gives every state", { skip }, async () => {
  assert.strictEqual((await call("tpf_gm", "GET", "/api/owner/matrix")).status, 403);
  const { status, body } = await call("tpf_owner", "GET", "/api/owner/matrix");
  assert.strictEqual(status, 200);
  const hi = body.hotels.findIndex((h) => h.id === HA), hj = body.hotels.findIndex((h) => h.id === HB), hk = body.hotels.findIndex((h) => h.id === HC);
  assert.ok(hi >= 0 && hj >= 0 && hk >= 0);
  assert.strictEqual(body.hotels[hi].live, true); assert.strictEqual(body.hotels[hk].live, false);
  assert.ok(body.hotels[hi].short.length > 0);
  const m = Object.fromEntries(body.masters.map((x) => [x.id, x]));
  assert.strictEqual(cell(m["ZT-01"], hi), "on"); assert.strictEqual(cell(m["ZT-01"], hj), "off");
  assert.strictEqual(m["ZT-01"].lv[hi], "1"); assert.strictEqual(m["ZT-01"].lv[hj], "0");
  assert.strictEqual(cell(m["ZT-01"], hk), "off"); // no copy counts as off
  assert.strictEqual(cell(m["ZT-02"], hi), "off"); // hilton-only applies at a Hilton hotel (no copy: off)
  assert.strictEqual(cell(m["ZT-02"], hj), "na"); assert.strictEqual(cell(m["ZT-02"], hk), "na");
  assert.strictEqual(cell(m["ZT-03"], hi), "off"); assert.strictEqual(cell(m["ZT-03"], hj), "na"); // needs a pool the hotel doesn't have
  assert.strictEqual(cell(m["ZT-04"], hj), "hk"); assert.strictEqual(cell(m["ZT-04"], hi), "off"); // HotelKey review only at HotelKey hotels
  assert.strictEqual(cell(m["ZT-05"], hi), "off"); assert.strictEqual(m["ZT-05"].s, "draft");
  assert.strictEqual(cell(m["ZT-06"], hi), "upd"); assert.strictEqual(cell(m["ZT-06"], hj), "upd");
  assert.strictEqual(cell(m["ZT-07"], hi), "own");
  assert.ok(Array.isArray(body.cats));
});

test("PUT /api/owner/hotels/:hotelId/sops/:masterId: Owner only, switches a copy, adds a missing one", { skip }, async () => {
  const url = (h, id) => `/api/owner/hotels/${h}/sops/${id}`;
  assert.strictEqual((await call("tpf_gm", "PUT", url(HA, "ZT-01"), { on: false })).status, 403);
  assert.strictEqual((await call("tpf_owner", "PUT", url(HA, "ZT-01"), {})).status, 400);
  const st = async (h, id) => ((await pool.query("SELECT status FROM sops WHERE hotel_id=$1 AND id=$2", [h, id])).rows[0] || {}).status;
  assert.strictEqual((await call("tpf_owner", "PUT", url(HA, "ZT-01"), { on: false })).status, 200);
  assert.strictEqual(await st(HA, "ZT-01"), "off");
  assert.strictEqual((await call("tpf_owner", "PUT", url(HA, "ZT-01"), { on: true })).status, 200);
  assert.strictEqual(await st(HA, "ZT-01"), "live");
  // no copy yet: added from the master, live, with its version
  assert.strictEqual(await st(HB, "ZT-08"), undefined);
  assert.strictEqual((await call("tpf_owner", "PUT", url(HB, "ZT-08"), { on: true })).status, 200);
  assert.strictEqual(await st(HB, "ZT-08"), "live");
  assert.strictEqual((await pool.query("SELECT master_id, master_version FROM sops WHERE hotel_id=$1 AND id='ZT-08'", [HB])).rows[0].master_version, 1);
  // the chart sees it
  const m = (await call("tpf_owner", "GET", "/api/owner/matrix")).body;
  const hj = m.hotels.findIndex((h) => h.id === HB);
  assert.strictEqual(m.masters.find((x) => x.id === "ZT-08").st[hj], "on");
  // refusals: Hilton-only at an independent hotel, a draft master, a hotel that isn't live, unknown ids
  assert.strictEqual((await call("tpf_owner", "PUT", url(HB, "ZT-02"), { on: true })).status, 400);
  assert.strictEqual((await call("tpf_owner", "PUT", url(HA, "ZT-05"), { on: true })).status, 400);
  assert.strictEqual((await call("tpf_owner", "PUT", url(HC, "ZT-01"), { on: true })).status, 400);
  assert.strictEqual((await call("tpf_owner", "PUT", url("nope", "ZT-01"), { on: true })).status, 404);
  assert.strictEqual((await call("tpf_owner", "PUT", url(HA, "NOPE-1"), { on: true })).status, 404);
});
