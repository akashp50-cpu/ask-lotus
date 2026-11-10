// End-to-end API tests for /api/dashboard and /api/hotel/color. They start the real server against DATABASE_URL
// (a throwaway local database) and are skipped when it is not set.
const test = require("node:test");
const assert = require("node:assert");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB = process.env.DATABASE_URL;
const skip = !DB && "DATABASE_URL is not set";
const ROOT = path.join(__dirname, "..");
const HID = "tapi", OTHER = "tapi2", PW = "Test-password-1234";
const WHO = [["tapi_fd", "Front Desk"], ["tapi_mgr", "Manager"], ["tapi_gm", "GM"], ["tapi_owner", "Owner"]];

let srv, base, pool;
const jar = {};
async function call(user, method, url, body) {
  const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(jar[user] ? { cookie: jar[user] } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get("set-cookie");
  if (sc) jar[user] = sc.split(";")[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

test.before(async () => {
  if (skip) return;
  execFileSync("node", ["db/migrate.js"], { cwd: ROOT, env: process.env, stdio: "ignore" });
  ({ pool } = require("../src/db"));
  await pool.query("DELETE FROM users WHERE username LIKE 'tapi\\_%'");
  await pool.query("DELETE FROM hotels WHERE id = ANY($1)", [[HID, OTHER]]);
  await pool.query("INSERT INTO hotels (id, name, ready, setup) VALUES ($1,'Test Hotel',TRUE,'live'),($2,'Other Hotel',TRUE,'live')", [HID, OTHER]);
  const hash = await bcrypt.hash(PW, 4);
  for (const [u, role] of WHO) {
    const id = (await pool.query("INSERT INTO users (name, username, role, password_hash, must_change_pw) VALUES ($1,$2,$3,$4,FALSE) RETURNING id", [`${u} Person`, u, role, hash])).rows[0].id;
    await pool.query("INSERT INTO user_hotels VALUES ($1,$2)", [id, HID]);
  }
  await pool.query("INSERT INTO sops (hotel_id, id, category, title, steps, status) VALUES ($1,'TT-01','Test','Test topic','[]','live')", [HID]).catch(() => {});
  const uid = (await pool.query("SELECT id FROM users WHERE username='tapi_fd'")).rows[0].id;
  // 3 today (2 answered), 1 yesterday marked not helpful, 1 sent to chat 40 days ago, 1 for another hotel.
  // Times are offsets from the start of the hotel's local day, so the test does not depend on the time it runs.
  const ins = (hotel, sop, fb, esc, shift) => pool.query(
    `INSERT INTO questions (hotel_id, user_id, question, sop_id, matched_by, feedback, escalate_level, asked_at)
     VALUES ($1,$2,'q',$3,'keyword',$4,$5, (date_trunc('day', now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago') + $6::interval)`, [hotel, uid, sop, fb, esc, shift]);
  await ins(HID, "TT-01", null, null, "1 second"); await ins(HID, "TT-01", "y", null, "2 seconds"); await ins(HID, null, null, "urgent", "3 seconds");
  await ins(HID, "TT-01", "n", null, "-12 hours"); await ins(HID, "TT-01", null, "chat", "-40 days"); await ins(OTHER, "ZZ", null, null, "1 second");
  const port = 4100 + Math.floor(Math.random() * 800);
  srv = spawn("node", ["src/server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), APP_SECRET: "x".repeat(40), NODE_ENV: "test" }, stdio: ["ignore", "pipe", "inherit"] });
  base = `http://127.0.0.1:${port}`;
  await new Promise((res, rej) => { srv.stdout.on("data", (b) => /listening/.test(String(b)) && res()); srv.on("exit", () => rej(new Error("server exited"))); });
  for (const [u] of WHO) assert.strictEqual((await call(u, "POST", "/api/login", { username: u, password: PW })).status, 200);
});
test.after(async () => {
  if (srv) srv.kill();
  if (pool) {
    await pool.query("DELETE FROM users WHERE username LIKE 'tapi\\_%'");
    await pool.query("DELETE FROM hotels WHERE id = ANY($1)", [[HID, OTHER]]);
    await pool.end();
  }
});

test("GET /api/dashboard needs Manager: Front Desk gets 403, signed out gets 401", { skip }, async () => {
  assert.strictEqual((await call("tapi_fd", "GET", `/api/dashboard?hotel=${HID}`)).status, 403);
  assert.strictEqual((await call("nobody", "GET", `/api/dashboard?hotel=${HID}`)).status, 401);
});

test("GET /api/dashboard: range validation, answered math, zero-filled days, this hotel only", { skip }, async () => {
  const get = (r) => call("tapi_mgr", "GET", `/api/dashboard?hotel=${HID}${r === undefined ? "" : "&range=" + r}`);
  assert.strictEqual((await get()).body.range, 7);
  for (const bad of ["8", "abc", "0", "-1", "30;1"]) assert.strictEqual((await get(bad)).body.range, 7, bad);
  const r7 = (await get(7)).body;
  assert.strictEqual(r7.days.length, 7);
  assert.strictEqual(r7.days[6].day, r7.today);
  assert.deepStrictEqual(r7.days.map((x) => x.total), [0, 0, 0, 0, 0, 1, 3]);
  assert.deepStrictEqual(r7.kpi, { questions: 4, answered: 2, answeredPct: 50, waiting: 2, sentChat: 0, sentUrgent: 1 });
  assert.deepStrictEqual(r7.topics, [{ sop: "TT-01", title: "Test topic", n: 3 }]);
  assert.strictEqual(r7.empty, false);
  const r30 = (await get(30)).body, r90 = (await get(90)).body;
  assert.strictEqual(r30.days.length, 30);
  assert.strictEqual(r30.kpi.questions, 4);
  assert.strictEqual(r90.days.length, 90);
  assert.strictEqual(r90.kpi.questions, 5);
  assert.strictEqual(r90.kpi.sentChat, 1);
  assert.strictEqual(r90.days.reduce((n, x) => n + x.total, 0), 5);
});

test("GET /api/dashboard refuses a hotel the user is not assigned to", { skip }, async () => {
  assert.strictEqual((await call("tapi_mgr", "GET", `/api/dashboard?hotel=${OTHER}`)).status, 403);
});

test("PUT /api/hotel/color: GM and Owner can set it, Manager and Front Desk get 403", { skip }, async () => {
  for (const u of ["tapi_mgr", "tapi_fd"]) assert.strictEqual((await call(u, "PUT", `/api/hotel/color?hotel=${HID}`, { accent: "#1F3A6E" })).status, 403, u);
  assert.strictEqual((await call("nobody", "PUT", `/api/hotel/color?hotel=${HID}`, { accent: "#1F3A6E" })).status, 401);
  assert.strictEqual((await call("tapi_gm", "PUT", `/api/hotel/color?hotel=${HID}`, { accent: "#1f3a6e" })).body.accent, "#1F3A6E"); // stored upper case
  assert.strictEqual((await call("tapi_owner", "PUT", `/api/hotel/color?hotel=${HID}`, { accent: "#0B5CAD" })).status, 200);
  assert.strictEqual((await pool.query("SELECT accent FROM hotels WHERE id=$1", [HID])).rows[0].accent, "#0B5CAD");
  assert.strictEqual((await pool.query("SELECT accent FROM hotels WHERE id=$1", [OTHER])).rows[0].accent, null); // per hotel
});

test("PUT /api/hotel/color: strict validation, null resets to Lotus gold", { skip }, async () => {
  const put = (b) => call("tapi_gm", "PUT", `/api/hotel/color?hotel=${HID}`, b);
  for (const bad of [{}, { accent: "" }, { accent: "1F3A6E" }, { accent: "#12345" }, { accent: "#1234567" }, { accent: "#ZZZZZZ" }, { accent: "red" }, { accent: 123 }, { accent: "#1F3A6E; x" }]) {
    const r = await put(bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
  }
  assert.strictEqual((await pool.query("SELECT accent FROM hotels WHERE id=$1", [HID])).rows[0].accent, "#0B5CAD"); // untouched by the bad ones
  assert.strictEqual((await put({ accent: null })).body.accent, null);
  assert.strictEqual((await pool.query("SELECT accent FROM hotels WHERE id=$1", [HID])).rows[0].accent, null);
});

test("every user at the hotel gets the accent from /api/me and /api/bootstrap", { skip }, async () => {
  await call("tapi_gm", "PUT", `/api/hotel/color?hotel=${HID}`, { accent: "#4E7A1F" });
  const me = await call("tapi_fd", "GET", "/api/me");
  assert.strictEqual(me.body.hotels.find((h) => h.id === HID).accent, "#4E7A1F");
  const boot = await call("tapi_fd", "GET", `/api/bootstrap?hotel=${HID}`);
  assert.strictEqual(boot.body.info.accent, "#4E7A1F");
});
