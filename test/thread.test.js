// End-to-end tests for reading a staff conversation back from Activity (/api/activity/thread/:convo) and the 48-hour limit.
// They start the real server against DATABASE_URL (a throwaway local database) and are skipped when it is not set.
const test = require("node:test");
const assert = require("node:assert");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB = process.env.DATABASE_URL;
const skip = !DB && "DATABASE_URL is not set";
const ROOT = path.join(__dirname, "..");
const HID = "tthr", OTHER = "tthr2", PW = "Test-password-1234";
const WHO = [["tthr_fd", "Front Desk", HID], ["tthr_mgr", "Manager", HID], ["tthr_gm2", "GM", OTHER]];

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
  await pool.query("DELETE FROM users WHERE username LIKE 'tthr\\_%'");
  await pool.query("DELETE FROM hotels WHERE id = ANY($1)", [[HID, OTHER]]);
  await pool.query("INSERT INTO hotels (id, name, ready, setup) VALUES ($1,'Thread Hotel',TRUE,'live'),($2,'Other Hotel',TRUE,'live')", [HID, OTHER]);
  // No AI key in a fresh database: /api/ask answers by keyword.
  await pool.query("UPDATE settings SET provider='none', key_enc=NULL WHERE id=1");
  await pool.query(
    "INSERT INTO sops (hotel_id, id, category, title, steps, keywords, status) VALUES ($1,'KY-01','Keys','Key card not working','[{\"t\":\"Re-encode the key.\"}]','key card not working, key broken','live')",
    [HID]
  );
  const hash = await bcrypt.hash(PW, 4);
  for (const [u, role, h] of WHO) {
    const id = (await pool.query("INSERT INTO users (name, username, role, password_hash, must_change_pw) VALUES ($1,$2,$3,$4,FALSE) RETURNING id", [`${u} Person`, u, role, hash])).rows[0].id;
    await pool.query("INSERT INTO user_hotels VALUES ($1,$2)", [id, h]);
  }
  const port = 4100 + Math.floor(Math.random() * 800);
  srv = spawn("node", ["src/server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), APP_SECRET: "x".repeat(40), NODE_ENV: "test" }, stdio: ["ignore", "pipe", "inherit"] });
  base = `http://127.0.0.1:${port}`;
  await new Promise((res, rej) => { srv.stdout.on("data", (b) => /listening/.test(String(b)) && res()); srv.on("exit", () => rej(new Error("server exited"))); });
  for (const [u] of WHO) assert.strictEqual((await call(u, "POST", "/api/login", { username: u, password: PW })).status, 200);
});
test.after(async () => {
  if (srv) srv.kill();
  if (pool) {
    await pool.query("DELETE FROM conversations WHERE hotel_id = ANY($1)", [[HID, OTHER]]);
    await pool.query("DELETE FROM users WHERE username LIKE 'tthr\\_%'");
    await pool.query("DELETE FROM hotels WHERE id = ANY($1)", [[HID, OTHER]]);
    await pool.end();
  }
});

let convo;
test("a staff question is kept with the answer staff saw, and Activity marks it readable", { skip }, async () => {
  const a = await call("tthr_fd", "POST", `/api/ask?hotel=${HID}`, { q: "guest key card not working" });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.body.kind, "answer");
  convo = a.body.convoId;
  const act = await call("tthr_mgr", "GET", `/api/activity?hotel=${HID}`);
  assert.strictEqual(act.status, 200);
  const row = act.body.find((r) => r.convo === convo);
  assert.ok(row && row.thread === true);
});

test("Manager reads the full thread; Front Desk can't; another hotel's GM can't", { skip }, async () => {
  const t = await call("tthr_mgr", "GET", `/api/activity/thread/${convo}?hotel=${HID}`);
  assert.strictEqual(t.status, 200);
  assert.strictEqual(t.body.user_name, "tthr_fd Person");
  assert.strictEqual(t.body.turns.length, 2);
  const [me, bot] = t.body.turns;
  assert.strictEqual(me.role, "staff");
  assert.strictEqual(me.text, "guest key card not working");
  assert.ok(me.at);
  assert.strictEqual(bot.kind, "answer");
  assert.strictEqual(bot.sop_id, "KY-01");
  assert.strictEqual(bot.sop_title, "Key card not working");
  assert.ok(bot.at);
  assert.strictEqual((await call("tthr_fd", "GET", `/api/activity/thread/${convo}?hotel=${HID}`)).status, 403);
  assert.notStrictEqual((await call("tthr_gm2", "GET", `/api/activity/thread/${convo}?hotel=${OTHER}`)).status, 200);
  assert.notStrictEqual((await call("tthr_gm2", "GET", `/api/activity/thread/${convo}?hotel=${HID}`)).status, 200);
});

test("after 48 hours the thread is gone but the question row stays in Activity", { skip }, async () => {
  await pool.query("UPDATE conversations SET updated_at = now() - interval '49 hours' WHERE id=$1", [convo]);
  const t = await call("tthr_mgr", "GET", `/api/activity/thread/${convo}?hotel=${HID}`);
  assert.strictEqual(t.status, 404);
  assert.match(t.body.error, /48 hours/);
  const act = await call("tthr_mgr", "GET", `/api/activity?hotel=${HID}`);
  const row = act.body.find((r) => r.convo === convo);
  assert.ok(row, "question row kept");
  assert.strictEqual(row.thread, false);
});
