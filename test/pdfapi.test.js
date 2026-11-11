// PDF guides over the API: screenshots are uploaded first (batch route), then /api/import/pdf and /api/author/pdf get JSON only.
// Starts the real server against DATABASE_URL (a throwaway local database) with a scripted AI; skipped when DATABASE_URL is not set.
const test = require("node:test");
const assert = require("node:assert");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB = process.env.DATABASE_URL;
const skip = !DB && "DATABASE_URL is not set";
const ROOT = path.join(__dirname, "..");
const HID = "tpdf", OTHER = "tpdf2", PW = "Test-password-1234", CAT = "Test category (pdf)";
const WHO = [["tpdf_fd", "Front Desk"], ["tpdf_mgr", "Manager"], ["tpdf_mgr2", "Manager"], ["tpdf_gm", "GM"], ["tpdf_owner", "Owner"]];
const MOCK = path.join(os.tmpdir(), `asklotus-pdfapi-${process.pid}.json`);
const mock = (x) => fs.writeFileSync(MOCK, JSON.stringify(x));
// 1x1 JPEG-ish bytes: the server stores what it is given, it never decodes it.
const IMG = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString("base64");

let srv, base, pool;
const jar = {};
async function call(user, method, url, body) {
  const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(jar[user] ? { cookie: jar[user] } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get("set-cookie");
  if (sc) jar[user] = sc.split(";")[0];
  const out = { status: r.status, body: await r.json().catch(() => null) };
  // The PDF routes answer 202 + a job id and work in the background: wait for the job and hand back what the route would have said.
  if (out.status === 202 && out.body && out.body.jobId) {
    for (let i = 0; i < 200; i++) {
      const j = await call(user, "GET", `/api/jobs/${out.body.jobId}`);
      if (j.body && j.body.status === "done") return { status: j.body.code, body: j.body.body, jobId: out.body.jobId };
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error("job never finished");
  }
  return out;
}
const rawCall = async (user, method, url, body) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", cookie: jar[user] }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const upload = async (user, n, hotel = HID) => (await call(user, "POST", `/api/images/batch?hotel=${hotel}`, { images: Array(n).fill(IMG) })).body.ids;
const exists = async (ids) => (await pool.query("SELECT id FROM images WHERE id = ANY($1)", [ids])).rows.map((r) => r.id).sort();
const step = (text, img, page = 1) => ({ text, page, img });
const guide = (items, extra) => ({ name: "check-out.pdf", pages: 2, warnings: [], procedures: [{ title: "Check a guest out", pages: [1, 2], items }], ...extra });

test.before(async () => {
  if (skip) return;
  execFileSync("node", ["db/migrate.js"], { cwd: ROOT, env: process.env, stdio: "ignore" });
  ({ pool } = require("../src/db"));
  await pool.query("DELETE FROM users WHERE username LIKE 'tpdf\\_%'");
  await pool.query("DELETE FROM hotels WHERE id = ANY($1)", [[HID, OTHER]]);
  await pool.query("INSERT INTO hotels (id, name, ready, setup) VALUES ($1,'PDF Test Hotel',TRUE,'live'),($2,'PDF Other Hotel',TRUE,'live')", [HID, OTHER]);
  await pool.query("INSERT INTO categories (hotel_id, name, prefix, sort) VALUES ($1,$2,'TP',0)", [HID, CAT]);
  await pool.query("INSERT INTO master_categories (name, prefix, sort) VALUES ($1,'TP',999) ON CONFLICT DO NOTHING", [CAT]);
  const hash = await bcrypt.hash(PW, 4);
  for (const [u, role] of WHO) {
    const id = (await pool.query("INSERT INTO users (name, username, role, password_hash, must_change_pw) VALUES ($1,$2,$3,$4,FALSE) RETURNING id", [`${u} Person`, u, role, hash])).rows[0].id;
    if (role !== "Owner") await pool.query("INSERT INTO user_hotels VALUES ($1,$2)", [id, HID]);
  }
  mock([]);
  const port = 4100 + Math.floor(Math.random() * 800);
  srv = spawn("node", ["src/server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), APP_SECRET: "x".repeat(40), NODE_ENV: "test", AI_MOCK_FILE: MOCK }, stdio: ["ignore", "pipe", "inherit"] });
  base = `http://127.0.0.1:${port}`;
  await new Promise((res, rej) => { srv.stdout.on("data", (b) => /listening/.test(String(b)) && res()); srv.on("exit", () => rej(new Error("server exited"))); });
  for (const [u] of WHO) assert.strictEqual((await call(u, "POST", "/api/login", { username: u, password: PW })).status, 200);
});
test.after(async () => {
  if (srv) srv.kill();
  fs.rmSync(MOCK, { force: true });
  if (pool) {
    await pool.query("DELETE FROM imports WHERE filenames && $1", [["check-out.pdf", "policy.pdf", "studio-notes.txt", "studio.csv"]]);
    await pool.query("DELETE FROM users WHERE username LIKE 'tpdf\\_%'");
    await pool.query("DELETE FROM hotels WHERE id = ANY($1)", [[HID, OTHER]]);
    await pool.query("DELETE FROM master_categories WHERE name=$1", [CAT]);
    await pool.end();
  }
});

test("pdf.js is served from the app under a versioned URL, as JavaScript, and /api/me names the version", { skip }, async () => {
  const v = (await call("tpdf_mgr", "GET", "/api/me")).body.pdfjs;
  assert.match(v, /^\d+\.\d+\.\d+/);
  for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs", "legacy/pdf.min.mjs", "standard_fonts/FoxitDingbats.pfb"]) {
    const r = await fetch(`${base}/vendor/pdfjs/${v}/${f}`);
    assert.strictEqual(r.status, 200, f);
    if (/mjs$/.test(f)) assert.match(r.headers.get("content-type"), /javascript/, f);
    assert.match(r.headers.get("cache-control"), /immutable/);
  }
  const miss = await fetch(`${base}/vendor/pdfjs/${v}/nope.mjs`);
  assert.strictEqual(miss.status, 404); assert.doesNotMatch(miss.headers.get("content-type") || "", /html/);
  assert.strictEqual((await fetch(`${base}/pdf/layout.js`)).status, 200);
  assert.strictEqual((await fetch(`${base}/pdf/read.js`)).status, 200);
});

test("images/batch: Manager and up, 1 to 12 images, image types only, stored in the open hotel by this user", { skip }, async () => {
  assert.strictEqual((await call("tpdf_fd", "POST", `/api/images/batch?hotel=${HID}`, { images: [IMG] })).status, 403);
  assert.strictEqual((await call("nobody", "POST", `/api/images/batch?hotel=${HID}`, { images: [IMG] })).status, 401);
  assert.strictEqual((await call("tpdf_mgr", "POST", `/api/images/batch?hotel=${OTHER}`, { images: [IMG] })).status, 403); // not their hotel
  for (const bad of [[], Array(13).fill(IMG), ["data:text/html;base64,AAAA"], [IMG, "nope"], "x"]) assert.strictEqual((await call("tpdf_mgr", "POST", `/api/images/batch?hotel=${HID}`, { images: bad })).status, 400);
  const big = "data:image/jpeg;base64," + Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64");
  assert.strictEqual((await call("tpdf_mgr", "POST", `/api/images/batch?hotel=${HID}`, { images: [big] })).status, 400);
  const ids = await upload("tpdf_mgr", 3);
  assert.strictEqual(ids.length, 3);
  const rows = (await pool.query("SELECT hotel_id, mime, created_by FROM images WHERE id = ANY($1)", [ids])).rows;
  const uid = (await pool.query("SELECT id FROM users WHERE username='tpdf_mgr'")).rows[0].id;
  assert.ok(rows.length === 3 && rows.every((r) => r.hotel_id === HID && r.mime === "image/jpeg" && r.created_by === uid));
  assert.strictEqual((await call("tpdf_fd", "GET", `/api/images/${ids[0]}`)).status, 200); // staff at the hotel read them through the normal route
  assert.strictEqual((await fetch(`${base}/api/images/${ids[0]}`)).status, 401);
});

test("import/pdf: foreign, unknown, malformed and duplicate picture ids are dropped; unused crops of this request are deleted", { skip }, async () => {
  const mine = await upload("tpdf_gm", 4);        // A B C D: this GM's own uploads
  const theirs = await upload("tpdf_mgr", 1);     // someone else's picture
  const unknown = "11111111-1111-4111-8111-111111111111";
  const [A, B, C, D] = mine;
  // The AI is told only about the valid pictures: A, B, D then (C is also valid, but the AI chooses not to use it).
  mock([{ matches: [], new: [{ title: "Check a guest out", category: CAT, steps: [{ t: "Open it", img: "@img:1" }, { t: "Select Check Out", img: "@img:2" }, { t: "Confirm", img: "@img:3" }, { t: "Print", img: "@img:4" }] }] }]);
  const body = { target: HID, ...guide([step("Open the reservation.", A), step("Foreign picture.", theirs[0]), step("Unknown picture.", unknown), step("Malformed.", "x'; DROP TABLE images; --"), step("Duplicate of A.", A), step("Second own picture.", D, 2), step("Unused picture.", C, 2)]) };
  const r = await call("tpdf_gm", "POST", "/api/import/pdf", body);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const item = r.body.new.find((x) => x.title === "Check a guest out");
  assert.ok(item, JSON.stringify(r.body.new));
  // the listing offered A, D, C (in step order); the AI used @img:1 and @img:2 = A and D; @img:3 = C is used too. @img:4 does not exist.
  assert.deepStrictEqual(item.imgs, [A, D, C, null]);
  assert.deepStrictEqual(await exists([...mine, theirs[0]]), [...mine, theirs[0]].sort()); // all used, none deleted yet
  // now a second PDF into the same batch whose crops the AI never uses
  const extra = await upload("tpdf_gm", 2);
  mock([{ matches: [], new: [{ title: "Another one", category: CAT, steps: [{ t: "Use the first only", img: "@img:1" }, "No picture"] }] }]);
  const r2 = await call("tpdf_gm", "POST", "/api/import/pdf", { target: HID, batchId: r.body.id, ...guide([step("Step one.", extra[0]), step("Step two.", extra[1])], { name: "check-out.pdf" }) });
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  assert.strictEqual(r2.body.id, r.body.id);
  assert.deepStrictEqual(await exists(extra), [extra[0]]); // the unused crop is gone, the used one stays
  assert.deepStrictEqual(await exists(mine), [...mine].sort()); // an earlier PDF's pictures are in the batch: never touched
});

test("import/pdf: unused crops are deleted when the AI uses none, and when the import fails; never another user's pictures or ones a SOP uses", { skip }, async () => {
  const ids = await upload("tpdf_gm", 3);
  mock([{ matches: [], new: [{ title: "No pictures used", category: CAT, steps: ["Only text"] }] }]);
  const ok = await call("tpdf_gm", "POST", "/api/import/pdf", { target: HID, ...guide([step("a", ids[0]), step("b", ids[1])]) });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await exists(ids), [ids[2]]); // 0 and 1 were this request's and unused; 2 was never mentioned
  // a failing AI step also gives the crops back
  const more = await upload("tpdf_gm", 2);
  mock([{ error: "boom" }]);
  const bad = await call("tpdf_gm", "POST", "/api/import/pdf", { target: HID, ...guide([step("a", more[0]), step("b", more[1])]) });
  assert.strictEqual(bad.status, 400);
  assert.deepStrictEqual(await exists(more), []);
  // a picture a live SOP already uses is never deleted, even if a request names it and the AI ignores it
  const used = (await upload("tpdf_gm", 1))[0];
  await pool.query("INSERT INTO sops (hotel_id, id, category, title, steps, status) VALUES ($1,'TP-90',$2,'Uses a picture',$3,'draft')", [HID, CAT, JSON.stringify([{ t: "x", img: used }])]);
  mock([{ matches: [], new: [{ title: "Ignores it", category: CAT, steps: ["text"] }] }]);
  await call("tpdf_gm", "POST", "/api/import/pdf", { target: HID, ...guide([step("a", used), step("b", used)]) });
  assert.deepStrictEqual(await exists([used]), [used]);
  // someone else's picture named in a request is not this user's to delete
  const theirs = (await upload("tpdf_mgr", 1))[0];
  mock([{ matches: [], new: [{ title: "Ignores it", category: CAT, steps: ["text"] }] }]);
  await call("tpdf_gm", "POST", "/api/import/pdf", { target: HID, ...guide([step("a", theirs)]) });
  assert.deepStrictEqual(await exists([theirs]), [theirs]);
});

test("import/pdf: a picture uploaded to another hotel is not accepted for this one ", { skip }, async () => {
  const wrongHotel = (await upload("tpdf_owner", 1, OTHER))[0];
  const [right, right2] = await upload("tpdf_owner", 2, HID);
  mock([{ matches: [], new: [{ title: "Owner import", category: CAT, steps: [{ t: "One", img: "@img:1" }, { t: "Two", img: "@img:2" }] }] }]);
  const r = await call("tpdf_owner", "POST", "/api/import/pdf", { target: HID, ...guide([step("one", wrongHotel), step("two", right), step("three", right2)]) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.new.find((x) => x.title === "Owner import").imgs, [right, right2]);
  assert.deepStrictEqual(await exists([wrongHotel, right, right2]), [wrongHotel, right, right2].sort()); // the wrong-hotel picture was never this request's to delete
  // a GM cannot import into a hotel that is not theirs, Front Desk cannot import at all, signed out gets 401
  assert.strictEqual((await call("tpdf_gm", "POST", "/api/import/pdf", { target: OTHER, ...guide([step("a", null)]) })).status, 403);
  assert.strictEqual((await call("tpdf_mgr", "POST", "/api/import/pdf", { target: HID, ...guide([step("a", null)]) })).status, 403);
  assert.strictEqual((await call("nobody", "POST", "/api/import/pdf", { target: HID, ...guide([step("a", null)]) })).status, 401);
  await pool.query("DELETE FROM images WHERE id = ANY($1)", [[wrongHotel, right, right2]]);
});

test("import/pdf: a PDF that is not a guide is read as text; the old PDF body and empty bodies are refused", { skip }, async () => {
  mock([{ matches: [], new: [{ title: "From policy text", category: CAT, steps: ["Do the thing"] }] }]);
  const r = await call("tpdf_gm", "POST", "/api/import/pdf", { target: HID, name: "policy.pdf", pages: 3, text: "Policy\nAll guests must do the thing before 11 am.\n".repeat(20) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.new.some((x) => x.title === "From policy text"));
  assert.ok((r.body.meta.warnings || []).some((w) => /read as plain text/.test(w)));
  // one picture is not a guide: the steps are read as text and the picture is given back
  const one = (await upload("tpdf_gm", 1))[0];
  mock([{ matches: [], new: [{ title: "From one picture", category: CAT, steps: ["x"] }] }]);
  const r1 = await call("tpdf_gm", "POST", "/api/import/pdf", { target: HID, ...guide([step("Only step.", one)], { pages: 9 }) });
  assert.strictEqual(r1.status, 200); assert.deepStrictEqual(await exists([one]), []);
  const old = await call("tpdf_gm", "POST", "/api/import/pdf", { target: HID, file: { name: "a.pdf", data: "data:application/pdf;base64,AAAA" } });
  assert.strictEqual(old.status, 400); assert.match(old.body.error, /out of date|Reload/i);
  assert.strictEqual((await call("tpdf_gm", "POST", "/api/import/pdf", { target: HID, name: "x.pdf" })).status, 400);
  assert.strictEqual((await call("tpdf_gm", "POST", "/api/import/pdf", { target: HID, name: "x.pdf", procedures: "nope", text: "   " })).status, 400);
  // the body is capped
  assert.strictEqual((await call("tpdf_gm", "POST", "/api/import/pdf", { target: HID, name: "x.pdf", text: "a".repeat(2.2 * 1024 * 1024) })).status, 413);
});

test("author/pdf: validated the same way, then the chat; discarding gives back the crops the draft does not keep", { skip }, async () => {
  const ids = await upload("tpdf_mgr", 4);
  const theirs = (await upload("tpdf_mgr2", 1))[0];
  const turn = (extra) => ({ target: "hotel", message: "", ...extra });
  assert.strictEqual((await call("tpdf_fd", "POST", `/api/author/pdf?hotel=${HID}`, turn(guide([step("a", null)])))).status, 403);
  assert.strictEqual((await call("tpdf_mgr", "POST", `/api/author/pdf?hotel=${HID}`, turn({ file: { name: "a.pdf", data: "x" } }))).status, 400);
  assert.strictEqual((await call("tpdf_mgr", "POST", `/api/author/pdf?hotel=${HID}`, turn({ name: "a.pdf" }))).status, 400);
  assert.strictEqual((await call("tpdf_mgr", "POST", `/api/author/pdf?hotel=${HID}`, turn({ ...guide([step("a", null)]), procedures: [] }))).status, 400);
  // the AI writes a draft that uses one crop and one foreign picture
  mock([{ action: "draft", sop: { title: "Check a guest out", category: CAT, steps: [{ t: "Open it", img: ids[0] }, { t: "Foreign", img: theirs }], script: "", flag: "", kw: "" }, notes: "Done", missing: [] }]);
  const r = await call("tpdf_mgr", "POST", `/api/author/pdf?hotel=${HID}`, turn(guide([step("Open", ids[0]), step("Two", ids[1]), step("Three", ids[2]), step("Four", theirs)])));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.pdf.shots, 3); // the foreign picture is not counted
  assert.deepStrictEqual(r.body.draft.steps.map((x) => x.img), [ids[0], null]);
  assert.deepStrictEqual(await exists(ids.concat(theirs)), [...ids, theirs].sort());
  // going to the editor keeps the draft's pictures and gives back the rest
  assert.strictEqual((await call("tpdf_mgr", "POST", `/api/author/${r.body.draftId}/discard`, { keepDraft: true })).status, 200);
  assert.deepStrictEqual(await exists(ids.concat(theirs)), [ids[0], ids[3], theirs].sort()); // [3] was never part of the PDF
  // a cancelled chat gives back everything it cut
  const more = await upload("tpdf_mgr", 2);
  mock([{ action: "ask", question: "Which one?", options: ["A", "B"] }]);
  const r2 = await call("tpdf_mgr", "POST", `/api/author/pdf?hotel=${HID}`, turn(guide([step("Open", more[0]), step("Two", more[1])])));
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  await call("tpdf_mgr", "POST", `/api/author/${r2.body.draftId}/discard`, {});
  assert.deepStrictEqual(await exists(more), []);
  // someone else's chat can't be discarded to delete pictures
  const keep = await upload("tpdf_mgr", 2);
  mock([{ action: "ask", question: "Which one now?", options: ["A", "B"] }]);
  const r3 = await call("tpdf_mgr", "POST", `/api/author/pdf?hotel=${HID}`, turn(guide([step("Open", keep[0]), step("Two", keep[1])])));
  await call("tpdf_mgr2", "POST", `/api/author/${r3.body.draftId}/discard`, {});
  assert.deepStrictEqual(await exists(keep), [...keep].sort());
  // a failing AI call gives the crops back
  const fail = await upload("tpdf_mgr", 2);
  mock([{ error: "boom" }]);
  assert.strictEqual((await call("tpdf_mgr", "POST", `/api/author/pdf?hotel=${HID}`, turn(guide([step("Open", fail[0]), step("Two", fail[1])])))).status, 502);
  assert.deepStrictEqual(await exists(fail), []);
});

test("images/discard: gives back only this user's recent, unreferenced uploads", { skip }, async () => {
  const mine = await upload("tpdf_mgr", 2), theirs = await upload("tpdf_mgr2", 1);
  await pool.query("INSERT INTO sops (hotel_id, id, category, title, steps, status) VALUES ($1,'TP-91',$2,'Uses a picture',$3,'draft')", [HID, CAT, JSON.stringify([{ t: "x", img: mine[1] }])]);
  const r = await call("tpdf_mgr", "POST", "/api/images/discard", { ids: [...mine, theirs[0], "bad", 5] });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.removed, 1);
  assert.deepStrictEqual(await exists([...mine, ...theirs]), [mine[1], theirs[0]].sort());
  await pool.query("UPDATE images SET created_at = now() - interval '5 hours' WHERE id = $1", [theirs[0]]);
  assert.strictEqual((await call("tpdf_mgr2", "POST", "/api/images/discard", { ids: theirs })).body.removed, 0); // too old to count as a fresh crop
  assert.strictEqual((await call("tpdf_fd", "POST", "/api/images/discard", { ids: theirs })).status, 403);
});

test("import/pdf is a background job: the request returns at once, a slow model no longer matters, only the owner can ask about the job", { skip }, async () => {
  const ids = await upload("tpdf_gm", 3);
  mock([{ delayMs: 2500, reply: { matches: [], new: [{ title: "Slow model", category: CAT, steps: [{ t: "One", img: "@img:1" }, { t: "Two", img: "@img:2" }] }] } }]);
  const t0 = Date.now();
  const start = await rawCall("tpdf_gm", "POST", "/api/import/pdf", { target: HID, ...guide([step("a", ids[0]), step("b", ids[1]), step("c", ids[2])]) });
  assert.strictEqual(start.status, 202); assert.ok(Date.now() - t0 < 1500, "answered before the model did");
  const jobId = start.body.jobId;
  assert.deepStrictEqual((await rawCall("tpdf_gm", "GET", `/api/jobs/${jobId}`)).body, { status: "working" });
  assert.deepStrictEqual(await exists(ids), [...ids].sort()); // while the model works nothing is deleted
  assert.strictEqual((await rawCall("tpdf_mgr", "GET", `/api/jobs/${jobId}`)).status, 404); // someone else's job
  assert.strictEqual((await rawCall("tpdf_gm", "GET", `/api/jobs/11111111-1111-4111-8111-111111111111`)).status, 404); // unknown (e.g. after a restart)
  let done;
  for (let i = 0; i < 100 && !done; i++) { await new Promise((r) => setTimeout(r, 100)); const j = (await rawCall("tpdf_gm", "GET", `/api/jobs/${jobId}`)).body; if (j.status === "done") done = j; }
  assert.ok(done && done.code === 200, JSON.stringify(done));
  assert.deepStrictEqual(done.body.new.find((x) => x.title === "Slow model").imgs, [ids[0], ids[1]]);
  assert.deepStrictEqual(await exists(ids), [ids[0], ids[1]].sort()); // the unused crop went when the job finished
  // a failure inside the job: the user reads the message, the job gave back its crops
  const more = await upload("tpdf_gm", 2);
  mock([{ delayMs: 300, error: "provider down" }]);
  const bad = await call("tpdf_gm", "POST", "/api/import/pdf", { target: HID, ...guide([step("a", more[0]), step("b", more[1])]) });
  assert.strictEqual(bad.status, 400); assert.ok(bad.body.error);
  assert.deepStrictEqual(await exists(more), []);
  // validation problems and "no AI" are answered straight away and give the crops back too
  const v = await upload("tpdf_gm", 2);
  assert.strictEqual((await rawCall("tpdf_gm", "POST", "/api/import/pdf", { target: HID, name: "x.pdf", procedures: [{ title: "T", items: [{ text: "ok", img: v[0] }] }], file: {} })).status, 400);
});

test("save-time filter: a picture deleted before the batch is saved, or before 'Add as draft' / 'Use theirs', becomes no picture", { skip }, async () => {
  const ids = await upload("tpdf_gm", 3);
  mock([{ delayMs: 1500, reply: { matches: [], new: [{ title: "Vanishing picture", category: CAT, steps: [{ t: "One", img: "@img:1" }, { t: "Two", img: "@img:2" }, { t: "Three", img: "@img:3" }] }] } }]);
  const start = await rawCall("tpdf_gm", "POST", "/api/import/pdf", { target: HID, ...guide([step("a", ids[0]), step("b", ids[1]), step("c", ids[2])]) });
  await pool.query("DELETE FROM images WHERE id = $1", [ids[1]]); // gone while the model works
  let done;
  for (let i = 0; i < 100 && !done; i++) { await new Promise((r) => setTimeout(r, 100)); const j = (await rawCall("tpdf_gm", "GET", `/api/jobs/${start.body.jobId}`)).body; if (j.status === "done") done = j; }
  assert.strictEqual(done.code, 200);
  const item = done.body.new.find((x) => x.title === "Vanishing picture");
  assert.deepStrictEqual(item.imgs, [ids[0], null, ids[2]]);
  // and later, between the import and "Add as draft"
  await pool.query("DELETE FROM images WHERE id = $1", [ids[2]]);
  const add = await call("tpdf_gm", "POST", `/api/import/${done.body.id}/act`, { group: "new", action: "add", index: done.body.new.findIndex((x) => x.title === "Vanishing picture"), hotel: HID });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  const sopId = add.body.new.find((x) => x.title === "Vanishing picture").sop_id;
  const sop = (await pool.query("SELECT steps FROM sops WHERE hotel_id=$1 AND id=$2", [HID, sopId])).rows[0];
  assert.deepStrictEqual(sop.steps.map((x) => x.img), [ids[0], null, null]);
  // "Use theirs" on an existing SOP
  await pool.query("INSERT INTO sops (hotel_id, id, category, title, steps, status) VALUES ($1,'TP-95',$2,'Existing',$3,'draft')", [HID, CAT, JSON.stringify([{ t: "old", img: null }])]);
  const [a, b] = await upload("tpdf_gm", 2);
  mock([{ matches: [{ sop_id: "TP-95", title: "Existing", steps: [{ t: "New one", img: "@img:1" }, { t: "New two", img: "@img:2" }], difference: "pictures" }], new: [] }]);
  const m = await call("tpdf_gm", "POST", "/api/import/pdf", { target: HID, ...guide([step("a", a), step("b", b)]) });
  assert.strictEqual(m.status, 200, JSON.stringify(m.body));
  await pool.query("DELETE FROM images WHERE id = $1", [b]);
  const use = await call("tpdf_gm", "POST", `/api/import/${m.body.id}/act`, { group: "matches", action: "use", index: m.body.matches.findIndex((x) => x.sop_id === "TP-95") });
  assert.strictEqual(use.status, 200, JSON.stringify(use.body));
  assert.deepStrictEqual((await pool.query("SELECT steps FROM sops WHERE hotel_id=$1 AND id='TP-95'", [HID])).rows[0].steps.map((x) => x.img), [a, null]);
});

test("images/discard keeps pictures that an old version of a SOP still shows", { skip }, async () => {
  const [p] = await upload("tpdf_mgr", 1);
  await pool.query("INSERT INTO sop_history (hotel_id, sop_id, version, snapshot) VALUES ($1,'TP-93',1,$2)", [HID, JSON.stringify({ id: "TP-93", steps: [{ t: "x", img: p }] })]);
  const r = await call("tpdf_mgr", "POST", "/api/images/discard", { ids: [p] });
  assert.strictEqual(r.body.removed, 0); assert.deepStrictEqual(await exists([p]), [p]);
  await pool.query("DELETE FROM sop_history WHERE sop_id='TP-93' AND hotel_id=$1", [HID]);
});

// The studio sends one drop as one batch and lets the manager refine a card in the chat.
const b64 = (t) => "data:text/plain;base64," + Buffer.from(t).toString("base64");
test("studio: sheets and documents join one batch (batchId); items say which file they came from", { skip }, async () => {
  mock([{ matches: [], new: [{ title: "Studio from text", category: CAT, steps: ["One", "Two"] }] }]);
  const a = await call("tpdf_gm", "POST", "/api/import/upload", { target: HID, files: [{ name: "studio-notes.txt", data: b64("Studio notes\nDo one then two.\n".repeat(5)) }] });
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  assert.strictEqual(a.body.new[0].src, "studio-notes.txt");
  const csv = `Title,Category,Step 1,Step 2\nStudio from sheet,${CAT},First,Second\n`;
  const b = await call("tpdf_gm", "POST", "/api/import/sheet", { target: HID, batchId: a.body.id, file: { name: "studio.csv", data: b64(csv) } });
  assert.strictEqual(b.status, 200, JSON.stringify(b.body));
  assert.strictEqual(b.body.id, a.body.id);
  assert.deepStrictEqual(b.body.files, ["studio-notes.txt", "studio.csv"]);
  assert.deepStrictEqual(b.body.new.map((x) => x.title).sort(), ["Studio from sheet", "Studio from text"]);
  assert.strictEqual(b.body.new.find((x) => x.title === "Studio from sheet").src, "studio.csv");
  // another hotel's batch is never joined: a new batch starts instead
  const c = await call("tpdf_owner", "POST", "/api/import/sheet", { target: OTHER, batchId: a.body.id, file: { name: "studio.csv", data: b64(csv) } });
  assert.strictEqual(c.status, 200); assert.notStrictEqual(c.body.id, a.body.id);
  await call("tpdf_owner", "POST", `/api/import/${c.body.id}/discard`, {});
  // refine one item: new wording replaces it, Add as draft saves that wording
  const i = b.body.new.findIndex((x) => x.title === "Studio from text");
  const put = await call("tpdf_gm", "PUT", `/api/import/${a.body.id}/item`, { group: "new", index: i, draft: { title: "Studio from text", category: CAT, steps: [{ t: "One, shorter", img: null }, { t: "Two", img: "not-mine" }], script: "Say it", flag: "" } });
  assert.strictEqual(put.status, 200, JSON.stringify(put.body));
  assert.deepStrictEqual(put.body.new[i].steps, ["One, shorter", "Two"]);
  assert.ok(!put.body.new[i].imgs, "an unknown picture id is dropped");
  assert.strictEqual((await call("tpdf_gm", "PUT", `/api/import/${a.body.id}/item`, { group: "new", index: 9, draft: { title: "x", steps: [{ t: "y" }] } })).status, 404);
  assert.strictEqual((await call("tpdf_gm", "PUT", `/api/import/${a.body.id}/item`, { group: "new", index: i, draft: { title: "x", steps: [] } })).status, 400);
  assert.strictEqual((await call("tpdf_mgr", "PUT", `/api/import/${a.body.id}/item`, { group: "new", index: i, draft: { title: "x", steps: [{ t: "y" }] } })).status, 403);
  const add = await call("tpdf_gm", "POST", `/api/import/${a.body.id}/act`, { group: "new", index: i, action: "add" });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  const row = (await pool.query("SELECT steps, script FROM sops WHERE hotel_id=$1 AND title='Studio from text'", [HID])).rows[0];
  assert.strictEqual(row.steps[0].t, "One, shorter"); assert.strictEqual(row.script, "Say it");
  assert.strictEqual((await call("tpdf_gm", "PUT", `/api/import/${a.body.id}/item`, { group: "new", index: i, draft: { title: "x", steps: [{ t: "y" }] } })).status, 400, "a handled item cannot be refined");
});
