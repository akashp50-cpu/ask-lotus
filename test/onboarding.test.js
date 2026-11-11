// API tests for the reworked onboarding: the room inventory, Don't know yet markers, copy per section, the generated cash and rollaway wording
// reaching staff, the Dashboard's Needs you row, and the onboarding migration. Starts the real server against DATABASE_URL (skipped without it).
const test = require("node:test");
const assert = require("node:assert");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB = process.env.DATABASE_URL;
const skip = !DB && "DATABASE_URL is not set";
const ROOT = path.join(__dirname, "..");
const PW = "Test-password-1234";
const NEW = "tobn", SIS = "tobs", LIVE = "tobl";
const HOTELS = [NEW, SIS, LIVE];
let srv, base, pool;
const jar = {};
async function call(user, method, url, body) {
  const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(jar[user] ? { cookie: jar[user] } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get("set-cookie");
  if (sc) jar[user] = sc.split(";")[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}
const row = async (id) => (await pool.query("SELECT details, answers, rooms, setup FROM hotels WHERE id=$1", [id])).rows[0];
const GM = "tob_gm";

test.before(async () => {
  if (skip) return;
  execFileSync("node", ["db/migrate.js"], { cwd: ROOT, env: process.env, stdio: "ignore" });
  ({ pool } = require("../src/db"));
  const clean = async () => {
    await pool.query("DELETE FROM users WHERE username LIKE 'tob\\_%'");
    await pool.query("DELETE FROM hotels WHERE id = ANY($1)", [HOTELS]);
  };
  test.clean = clean;
  await clean();
  const H = (id, name, setup, answers, details) => pool.query("INSERT INTO hotels (id,name,brand,system,setup,ready,answers,details) VALUES ($1,$2,'independent','hotelkey',$3,$4,$5,$6)", [id, name, setup, setup === "live", JSON.stringify(answers), JSON.stringify(details)]);
  await H(NEW, "Tob New Inn", "setup", { stage: "about" }, {});
  await H(SIS, "Tob Sister Inn", "live", { cash: false, pool: true, rollaways: false }, {
    "Hotel name": "the Sister", "Wi-Fi network": "SisterGuest", "Smoking fee": "$300", "Quiet hours": "10 PM–7 AM", "Pool opening time": "9 AM", "Pool closing time": "9 PM", "Crib storage": "closet 2", "AED location": "lobby", "ID scanner": "IDGuru",
    "Pool hours": "9 AM–9 PM", "Cash policy": "The hotel is completely cashless.",
  });
  await H(LIVE, "Tob Old Inn", "live", {}, {
    "Hotel short name": "the Old Inn", "Wi-Fi network name": "OldGuest", "Pool hours": "8 AM–8 PM", "Cash policy": "The hotel is completely cashless: no cash for rooms, deposits or the treat shop.", "Rollaway policy": "No rollaways are available.",
    "Room type 1": "KG: King (3 rooms).", "Room type 2": "QQ: Two Queens (2 rooms).", "Early check-in occupancy limit": "2 people per bed in a room.",
  });
  for (const h of HOTELS) await pool.query("INSERT INTO categories (hotel_id,name,prefix) VALUES ($1,'Tob cat','ZB')", [h]);
  const hash = await bcrypt.hash(PW, 4);
  const id = (await pool.query("INSERT INTO users (name,username,role,password_hash,must_change_pw) VALUES ('Tob GM',$1,'GM',$2,FALSE) RETURNING id", [GM, hash])).rows[0].id;
  for (const h of HOTELS) await pool.query("INSERT INTO user_hotels VALUES ($1,$2)", [id, h]);
  const port = 4600 + Math.floor(Math.random() * 90);
  srv = spawn("node", ["src/server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), APP_SECRET: "x".repeat(40), NODE_ENV: "test" }, stdio: ["ignore", "pipe", "inherit"] });
  base = `http://127.0.0.1:${port}`;
  await new Promise((res, rej) => { srv.stdout.on("data", (b) => /listening/.test(String(b)) && res()); srv.on("exit", () => rej(new Error("server exited"))); });
  assert.strictEqual((await call(GM, "POST", "/api/login", { username: GM, password: PW })).status, 200);
  // a live SOP at the sister so the new hotel has something to copy and the tokens can be seen
  const r = await call(GM, "POST", `/api/sops?hotel=${LIVE}`, { title: "Tob cash and rollaways", cat: "Tob cat", steps: [{ t: "Cash: {Cash payment step}", img: null }, { t: "Rollaways: {Rollaway script}", img: null }, { t: "Pool {Pool hours}, {Sofa sleeper rooms}, {Total rooms}", img: null }], script: "", flag: "", kw: "", status: "live" });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
});
test.after(async () => {
  if (srv) srv.kill();
  if (pool) { if (test.clean) await test.clean(); await pool.end(); }
});

test("the room inventory saves normalised, derives the old tokens for staff, and clears a Don't know yet", { skip }, async () => {
  const u = await call(GM, "PUT", `/api/setup/unknown?hotel=${NEW}`, { key: "rooms-inventory" });
  assert.strictEqual(u.status, 200);
  assert.strictEqual((await row(NEW)).answers.unknown["rooms-inventory"], true);
  const r = await call(GM, "PUT", `/api/hotel/rooms?hotel=${NEW}`, { types: [
    { code: "KG", name: " Standard King ", count: 2, rooms: ["102", "101"], accessible: false, sofa: true, fridge: true },
    { code: "HQ", name: "Accessible Queen", count: 1, rooms: ["201"], accessible: true },
    { code: "KG", name: "dup" }, { code: "" }, "junk",
  ] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.total, 3);
  assert.deepStrictEqual(r.body.rooms.types.map((t) => [t.code, t.name, t.count, t.rooms.join()]), [["KG", "Standard King", 2, "101,102"], ["HQ", "Accessible Queen", 1, "201"]]);
  assert.strictEqual((await row(NEW)).answers.unknown["rooms-inventory"], undefined, "saving a room list clears the marker");
  const setup = (await call(GM, "GET", `/api/setup?hotel=${NEW}`)).body;
  assert.strictEqual(setup.rooms.types.length, 2);
  assert.strictEqual((await call("nobody", "PUT", `/api/hotel/rooms?hotel=${NEW}`, {})).status, 401);
});

test("Don't know yet is a marker, not text: stored in answers, listed as skipped, never in details; typing a value removes it", { skip }, async () => {
  assert.strictEqual((await call(GM, "PUT", `/api/setup/unknown?hotel=${NEW}`, { key: "AED location" })).status, 200);
  assert.strictEqual((await call(GM, "PUT", `/api/setup/unknown?hotel=${NEW}`, { key: "cash" })).status, 200);
  assert.strictEqual((await call(GM, "PUT", `/api/setup/unknown?hotel=${NEW}`, { key: "Not a real question" })).status, 400);
  let r = await row(NEW);
  assert.strictEqual(r.answers.unknown["AED location"], true);
  assert.ok(!("AED location" in r.details), "no 'unknown' text in the details");
  const rd = (await call(GM, "GET", `/api/setup/readiness?hotel=${NEW}`)).body;
  assert.deepStrictEqual(rd.skipped.map((s) => s.key).sort(), ["AED location", "cash"]);
  assert.strictEqual((await call(GM, "PUT", `/api/hotel/details?hotel=${NEW}`, { merge: true, details: { "AED location": "Lobby" } })).status, 200);
  r = await row(NEW);
  assert.strictEqual(r.answers.unknown["AED location"], undefined, "answering removes the marker");
  assert.strictEqual(r.answers.unknown.cash, true);
  // answering the yes/no removes its marker
  const a = await call(GM, "PUT", `/api/setup/answers?hotel=${NEW}`, { answers: { cash: false } });
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  assert.strictEqual((await row(NEW)).answers.unknown.cash, undefined);
  assert.ok(Array.isArray(a.body.used));
  // undo
  await call(GM, "PUT", `/api/setup/unknown?hotel=${NEW}`, { key: "Quiet hours" });
  await call(GM, "PUT", `/api/setup/unknown?hotel=${NEW}`, { key: "Quiet hours", on: false });
  assert.strictEqual((await row(NEW)).answers.unknown["Quiet hours"], undefined);
});

test("the Dashboard's Needs you row lists Don't know yet questions", { skip }, async () => {
  await call(GM, "PUT", `/api/setup/unknown?hotel=${NEW}`, { key: "Flashlight location" });
  const h = (await call(GM, "GET", `/api/home?hotel=${NEW}`)).body;
  assert.ok(h.missing.includes("Flashlight location"), JSON.stringify(h.missing));
  assert.ok(h.skipped >= 1);
});

test("answers: cashless generates the cash wording for staff without storing it, and a Yes switches to the yes wording", { skip }, async () => {
  await call(GM, "PUT", `/api/setup/answers?hotel=${NEW}`, { answers: { cash: false, rollaways: false, pack_and_plays: false, connecting_rooms: false } });
  let boot = (await call(GM, "GET", `/api/bootstrap?hotel=${NEW}`)).body;
  assert.strictEqual(boot.details["Cash payment step"], "Offer a credit card or debit card in the guest's name.");
  assert.strictEqual(boot.details["Rollaway policy"], "No rollaways are available.");
  assert.strictEqual(boot.details["Rollaway script"], "We don't have rollaways, but our Standard King rooms have a sofa sleeper.");
  assert.strictEqual(boot.details["Total rooms"], "3");
  assert.strictEqual(boot.details["Room type 1"], "KG: Standard King (2 rooms)");
  assert.strictEqual(boot.details["Fridge and microwave rooms"], "KG Standard King rooms");
  assert.strictEqual(boot.details["Accessible room list"], "201 (HQ)");
  assert.ok(!("Cash payment step" in (await row(NEW)).details), "generated wording is not stored");
  await call(GM, "PUT", `/api/hotel/details?hotel=${NEW}`, { merge: true, details: { "Rollaway fee": "$15 a night" } });
  await call(GM, "PUT", `/api/setup/answers?hotel=${NEW}`, { answers: { cash: true, rollaways: true } });
  boot = (await call(GM, "GET", `/api/bootstrap?hotel=${NEW}`)).body;
  assert.strictEqual(boot.details["Cash payment script"], "We can take cash for that.");
  assert.strictEqual(boot.details["Rollaway script"], "We can bring a rollaway up for you. The fee is $15 a night.");
  await call(GM, "PUT", `/api/setup/answers?hotel=${NEW}`, { answers: { cash: false, rollaways: false } });
  assert.strictEqual((await call(GM, "GET", `/api/bootstrap?hotel=${NEW}`)).body.details["Cash payment script"], D_CASH_NO_SCRIPT);
});
const D_CASH_NO_SCRIPT = "We're a cashless hotel, so we'll need a card. If someone else is paying, I can send them a quick form.";

test("setup payload: the wizard's questions, gating info, used details and what can be copied from", { skip }, async () => {
  const s = (await call(GM, "GET", `/api/setup?hotel=${NEW}`)).body;
  const by = Object.fromEntries(s.detailDefs.map((d) => [d.key, d]));
  assert.strictEqual(by["Early check-in occupancy limit"].type, "percent");
  assert.deepStrictEqual(by["Pool opening time"].gate, { q: "pool", v: true });
  assert.strictEqual(by["Pool hours"].hidden, true);
  assert.strictEqual(by["Room type 1"].hidden, true);
  assert.strictEqual(by["Hotel short name"].hidden, true);
  assert.strictEqual(by["Debit hold amount"].label, "Incidental deposit amount");
  assert.strictEqual(by["AED location"].screen, "basics");
  assert.deepStrictEqual(s.qkeys.cash.sort(), ["Cash deposit step", "Cash policy", "Starting cash note"]);
  assert.deepStrictEqual(s.copyHotels.map((h) => h.id).sort(), [LIVE, SIS].sort());
  assert.ok(s.copyScreens.includes("policies") && !s.copyScreens.includes("contacts"));
  assert.ok(Array.isArray(s.used));
});

test("copy per section: fills empty answers from a sister hotel, marks each 'check this', never copies identity, and confirming clears the mark", { skip }, async () => {
  const r = await call(GM, "POST", `/api/setup/copy-section?hotel=${NEW}`, { screen: "policies", from: SIS });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.details["Smoking fee"], "$300");
  assert.strictEqual(r.body.details["Quiet hours"], "10 PM–7 AM");
  assert.strictEqual(r.body.prefilled["Smoking fee"], SIS);
  assert.ok(!("Hotel name" in r.body.details) && !("Wi-Fi network" in r.body.details));
  const h = await call(GM, "POST", `/api/setup/copy-section?hotel=${NEW}`, { screen: "hotel", from: SIS });
  assert.ok(!("Hotel name" in h.body.details) && !("Wi-Fi network" in h.body.details), "identity is never copied");
  const rooms = await call(GM, "POST", `/api/setup/copy-section?hotel=${NEW}`, { screen: "rooms", from: SIS });
  assert.strictEqual(rooms.body.details["Crib storage"], "closet 2");
  assert.strictEqual((await row(NEW)).rooms.types.length, 2, "the room list is untouched");
  const basics = await call(GM, "POST", `/api/setup/copy-section?hotel=${NEW}`, { screen: "basics", from: SIS });
  assert.ok(!("AED location" in basics.body.details) || basics.body.details["AED location"] === "Lobby", "emergency locations are not copied");
  assert.strictEqual((await call(GM, "POST", `/api/setup/copy-section?hotel=${NEW}`, { screen: "contacts", from: SIS })).status, 400);
  assert.strictEqual((await call(GM, "POST", `/api/setup/copy-section?hotel=${NEW}`, { screen: "policies", from: NEW })).status, 400, "not from itself");
  assert.strictEqual((await call(GM, "POST", `/api/setup/copy-section?hotel=${NEW}`, { screen: "policies", from: "nope" })).status, 400);
  // editing a copied value clears its mark; Confirm clears another
  await call(GM, "PUT", `/api/hotel/details?hotel=${NEW}`, { merge: true, details: { "Smoking fee": "$400" } });
  let pre = (await row(NEW)).answers.prefilled;
  assert.ok(!("Smoking fee" in pre) && "Quiet hours" in pre);
  await call(GM, "PUT", `/api/setup/flags?hotel=${NEW}`, { confirm: ["Quiet hours"] });
  pre = (await row(NEW)).answers.prefilled;
  assert.ok(!("Quiet hours" in pre));
});

test("the onboarding migration is idempotent and never loses a key: a hotel with the old doubled fields keeps every rendered value", { skip }, async () => {
  const onboarding = require("../db/onboarding");
  const before = await row(LIVE);
  const p1 = await onboarding.apply(pool);
  const after = await row(LIVE);
  for (const k of Object.keys(before.details)) assert.strictEqual(after.details[k], before.details[k], k + " unchanged");
  assert.strictEqual(after.details["Hotel name"], "the Old Inn");
  assert.strictEqual(after.details["Wi-Fi network"], "OldGuest");
  assert.strictEqual(after.details["Pool opening time"], "8 AM");
  assert.strictEqual(after.answers.cash, false);
  assert.strictEqual(after.answers.rollaways, false);
  assert.deepStrictEqual(after.rooms.types.map((t) => [t.code, t.count]), [["KG", 3], ["QQ", 2]]);
  assert.ok(p1.find((x) => x.id === LIVE).write);
  const p2 = await onboarding.apply(pool);
  assert.ok(!p2.find((x) => x.id === LIVE).write, "second run writes nothing");
  // what staff see is unchanged for every value the hotel had, and the new tokens now work
  const boot = (await call(GM, "GET", `/api/bootstrap?hotel=${LIVE}`)).body;
  assert.strictEqual(boot.details["Hotel short name"], "the Old Inn");
  assert.strictEqual(boot.details["Pool hours"], "8 AM–8 PM");
  assert.strictEqual(boot.details["Total rooms"], "5");
  assert.strictEqual(boot.details["Early check-in occupancy limit"], "2 people per bed in a room.", "kept, shown as unanswered in the wizard");
  const rd = (await call(GM, "GET", `/api/setup/readiness?hotel=${LIVE}`)).body;
  assert.ok(rd.items.find((i) => i.id === "policies").left >= 1);
});
