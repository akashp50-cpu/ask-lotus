"use strict";
/* The SOP studio: one full page where a manager writes SOPs with AI, from a conversation, photos, or one or many documents.
   Left: the conversation (and, after documents, one card per procedure found). Right: the SOP that is selected or being written.
   Talks to /api/author (conversation) and /api/import/* (documents). Uses the globals of app.js; nothing here runs until studioInit(). */

const ST_FRESH = () => ({
  thread: [], batches: {}, notes: {}, sel: null,
  draft: null, draftId: null, last: null, updateId: null, sopId: null, seed: null, savedId: null, savedStatus: "", queue: [], picks: new Set(),
  cardAu: {}, catPick: {}, hotelPick: {}, pending: [], docs: [], busy: "", acting: false, pane: "chat", editFor: null,
  list: null, popOpen: false, loadBatch: null, tok: ++ST_TOK,
});
let ST_TOK = 0;
const ST = { active: false, tgt: "", back: "#admin", info: null, ...ST_FRESH() };
const ST_MAX_PHOTOS = 6, ST_MAX_FILES = 20, ST_EXTS = [".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md"];
const ST_DONE = { kept: "Kept yours", used: "Updated your SOP", added: "Added as a draft", applied: "Saved", skipped: "Skipped" };
const stWide = () => matchMedia("(min-width:900px)").matches;
const stIsPdf = (f) => /\.pdf$/i.test(f.name);
const stIsSheet = (f) => /\.(xlsx|csv)$/i.test(f.name);
const stFmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const stCanDocs = () => isGM();
const stAiOn = () => !!(STATE.settings && STATE.settings.aiOn);
const stAuthorTarget = () => (ST.tgt === "master" ? "master" : "hotel");
const stWhere = () => (ST.tgt === "master" ? "the master library" : hotelName(ST.tgt));
const stKey = (bid, g, i) => `${bid}:${g}:${i}`;
// Text for a step: tokens as chips, [FILL] gaps marked, [CHECK] notes never shown.
const stTxt = (t) => chipify(String(t || "").replace(/\[CHECK:[^\]]*\]|\[CHECK\]/gi, "")).replace(/\[FILL:?([^\]]*)\]/g, (m, x) => `<span class="stFill">[FILL${x ? ":" + x : ""}]</span>`);
const stHasFill = (d) => !!d && /\[FILL/i.test(JSON.stringify([d.title, d.steps, d.script, d.flag]));
const stIcon = {
  photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.4 11.6 12.2 20.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  file: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  back: '<svg viewBox="0 0 8 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 1.5 1.5 6.5l5 5"/></svg>',
  x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
};

/* ---------- opening, leaving ---------- */
function stIntro() {
  if (ST.sopId || (ST.seed && ST.seed.title)) return `I've loaded ${ST.sopId ? ST.sopId + ": " : ""}${ST.seed.title || "this SOP"}. Tell me what to change, for example "add a step after 3 about Quore", and attach a screenshot if it helps.`;
  if (!stAiOn()) return stCanDocs() ? "AI isn't switched on yet, so I can't write from a conversation. Drop in the spreadsheet template, or use Write it myself. The Owner can add an AI key in Settings." : "AI isn't switched on yet. Use Write it myself, or ask the Owner to add an AI key in Settings.";
  return stCanDocs()
    ? `What should we write? Tell me the procedure, send photos of the screens, or drop in documents. I'll turn them into SOPs for ${stWhere()}.`
    : `What should we write? Tell me the procedure or send photos of the screens. I'll turn them into an SOP for ${stWhere()}.`;
}
// target: "master" (Owner) or a hotel id. sopId/seed: edit that SOP with AI. batchId: open that waiting upload.
function studioOpen(o = {}) {
  studioDiscard();
  const h = location.hash, back = !h || /^#(studio|import)$/.test(h) ? "#admin" : h;
  Object.assign(ST, ST_FRESH(), { active: true, back: mode === "studio" ? ST.back : back });
  ST.tgt = o.target === "master" && isOwner() ? "master" : o.target && o.target !== "master" ? o.target : STATE.hotel;
  ST.sopId = o.sopId || null;
  if (o.seed && o.seed.title) { ST.seed = o.seed; ST.draft = o.seed; ST.sel = { k: "draft" }; }
  ST.thread = [{ role: "bot", text: stIntro() }];
  ST.loadBatch = o.batchId || null;
  if (mode === "studio") studioEnter(); else go("studio");
}
const studioOpenBatch = (id) => studioOpen({ target: STATE.hotel, batchId: id });

async function studioEnter() {
  if (!ST.active) { // arrived by address (a reload on #studio): a fresh studio for the open hotel
    Object.assign(ST, ST_FRESH(), { active: true, back: "#admin", tgt: STATE.hotel });
    ST.thread = [{ role: "bot", text: stIntro() }];
  }
  if (ST.tgt !== "master" && ST.tgt !== STATE.hotel) ST.tgt = STATE.hotel;
  stRenderAll();
  if (stCanDocs() && !ST.info) {
    try { ST.info = await api("/api/import/info", { hotel: false }); stRenderHead(); stRenderComposer(); } catch (e) { /* the page still works without the limits */ }
  }
  if (ST.loadBatch) { const id = ST.loadBatch; ST.loadBatch = null; await stOpenBatch(id); }
  if (stWide()) $("stText").focus({ preventScroll: true }); else { /* phone: leave the keyboard down */ }
}
function studioLeave() { studioDiscard(); ST.active = false; ST.tok = ++ST_TOK; stClosePop(); document.body.classList.remove("stDragging"); }
// The chats on the server (author drafts) end with the page. Pictures already on a saved SOP stay.
function studioDiscard() {
  const ids = [ST.draftId, ...Object.values(ST.cardAu)].filter(Boolean);
  ST.draftId = null; ST.cardAu = {};
  for (const id of ids) api(`/api/author/${encodeURIComponent(id)}/discard`, { body: { keepDraft: true } }).catch(() => {});
}

/* ---------- header, target ---------- */
function stRenderHead() {
  const editing = ST.sopId || (ST.seed && ST.seed.title);
  $("stTitle").textContent = ST.sopId ? `Edit ${ST.sopId} with AI` : editing ? "Edit with AI" : ST.tgt === "master" ? "New master SOP with AI" : "New SOP with AI";
  $("stSub").textContent = editing ? "Tell me what to change. Attach a screenshot if it helps." : "Describe a procedure, attach photos, or drop documents and PDF guides, one or many.";
  const opts = isOwner() && ST.info ? [["master", "Master library"], ...ST.info.hotels.map((h) => [h.id, h.name])] : [];
  const wrap = $("stTargetWrap"); wrap.hidden = opts.length < 2 || !!editing;
  if (!wrap.hidden) { $("stTarget").innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(""); $("stTarget").value = ST.tgt; }
  $("stEarlier").hidden = !stCanDocs();
}
async function stSetTarget(v) {
  if (v === ST.tgt) return;
  const has = ST.thread.length > 1 || ST.draft || Object.keys(ST.batches).length;
  if (has && !confirm("Switching clears this conversation. Uploads you haven't finished stay under Earlier uploads.")) { $("stTarget").value = ST.tgt; return; }
  studioDiscard();
  if (v !== "master" && v !== STATE.hotel) {
    try {
      STATE.hotel = v; try { localStorage.setItem("asklotus.hotel", v); } catch {}
      newChat(true); renderPropMenu(); await loadHotel();
    } catch (e) { fail(e); }
  }
  Object.assign(ST, ST_FRESH(), { tgt: v });
  ST.thread = [{ role: "bot", text: stIntro() }];
  stRenderAll();
}

/* ---------- rendering ---------- */
function stRenderAll() { stRenderHead(); stRenderThread("bottom"); stRenderPane(); stRenderComposer(); stRenderPanes(); }
function stSay(t) { const el = $("stLive"); el.textContent = ""; requestAnimationFrame(() => (el.textContent = t)); }

function stFocusKey() { const a = document.activeElement; return a && a.dataset && a.dataset.fk && $("studio").contains(a) ? a.dataset.fk : null; }
function stRestoreFocus(fk) {
  if (!fk) return;
  let el = document.querySelector(`#studio [data-fk="${CSS.escape(fk)}"]`);
  if (!el) { const m = fk.match(/^act:([^:]+:[^:]+:[^:]+):/); if (m) el = document.querySelector(`#studio [data-fk="sel:${CSS.escape(m[1])}"]`); }
  if (el) el.focus({ preventScroll: true });
}

const stSteps = (steps, imgs) => `<ol class="stSteps">${steps.map((t, i) => `<li><span class="stN">${i + 1}</span><div class="stSt"><div>${stTxt(t)}</div>${imgs && imgs[i] ? `<button type="button" class="stThumb" data-img="${esc(imgs[i])}" aria-label="Enlarge screenshot for step ${i + 1}"><img alt="Screenshot for step ${i + 1}" loading="lazy" src="${imgUrl(imgs[i])}"></button>` : ""}</div></li>`).join("")}</ol>`;

function stItem(bid, g, i) { const b = ST.batches[bid]; return b && b[g] ? b[g][i] : null; }
function stSelItem() {
  const s = ST.sel; if (!s || s.k !== "item") return null;
  const it = stItem(s.bid, s.g, s.i); return it ? { ...s, it, b: ST.batches[s.bid], key: stKey(s.bid, s.g, s.i) } : null;
}
const stDoneText = (it, key) => (it.state ? ST.notes[key] || ST_DONE[it.state] + (it.state === "added" && it.sop_id ? " · " + it.sop_id : "") : "");
const stSrc = (b, it) => it.src || (b.files.length === 1 ? b.files[0] : "");
const stShots = (it) => (it.imgs ? it.imgs.filter(Boolean).length : 0);

function stFound(b) {
  const n = b.matches.length + b.new.length, m = b.matches.length, d = b.details.length;
  const shots = [...b.matches, ...b.new].reduce((a, x) => a + stShots(x), 0);
  if (!n && d) return `I didn't find a procedure in ${plural(b.files.length, "file")}, but I found ${plural(d, "hotel detail")}.`;
  return `I found ${plural(n, "procedure")} in ${plural(b.files.length, "file")}${shots ? `, with ${plural(shots, "screenshot")}` : ""}. ${m ? `${m} ${m === 1 ? "matches an SOP" : "match SOPs"} you already have.` : "None match SOPs you already have."}${d ? ` I also found ${plural(d, "hotel detail")}.` : ""} ${stWide() ? "Tap one to see it on the right." : "Tap one to open it."}`;
}
function stBatchNotes(b, m) {
  const M = b.meta || {}, out = [];
  if (M.truncated) out.push("The documents were longer than we can read at once, so only the first part was used. Split them and add the rest separately.");
  if (M.failedParts) out.push(`${M.failedParts} of ${M.parts} parts couldn't be read, so some procedures may be missing.`);
  if (M.emptyFiles && M.emptyFiles.length) out.push(`No text found in: ${M.emptyFiles.join(", ")}.`);
  for (const w of M.warnings || []) out.push(w);
  for (const w of (m && m.problems) || []) out.push(`Not read: ${w}`);
  if (M.examples) out.push(`${plural(M.examples, "example row")} ignored.`);
  if (M.skippedCount) out.push(`${plural(M.skippedCount, "row")} skipped: ${(M.skipped || []).slice(0, 5).map((s) => `row ${s.row}${s.title ? " (" + s.title + ")" : ""} ${String(s.reason).toLowerCase()}`).join("; ")}${M.skippedCount > 5 ? "…" : ""}.`);
  return out;
}

function stCardHtml(b, g, it, i) {
  const key = stKey(b.id, g, i), on = ST.sel && ST.sel.k === "item" && ST.sel.bid === b.id && ST.sel.g === g && ST.sel.i === i, done = stDoneText(it, key), master = b.target === "master";
  let title, meta, tag, tagCls, acts = "";
  if (g === "new") {
    title = it.title; tag = "New"; tagCls = "new";
    meta = [stSrc(b, it), plural(it.steps.length, "step"), it.imgs ? plural(stShots(it), "screenshot") : ""].filter(Boolean).join(" · ");
    if (!done) acts = `${it.category ? "" : `<select class="stSel" data-cat="${esc(key)}" aria-label="Category for ${esc(it.title)}"><option value="">Pick a category</option>${b.cats.map((c) => `<option${ST.catPick[key] === c ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>`}
      <button type="button" class="stBtn" data-act="skip" data-b="${b.id}" data-g="new" data-i="${i}" data-fk="act:${key}:skip">Skip</button>
      <button type="button" class="stBtn dark" data-act="add" data-b="${b.id}" data-g="new" data-i="${i}" data-fk="act:${key}:add">${master ? "Add to master as draft" : "Add as draft"}</button>`;
  } else if (g === "matches") {
    title = it.ours ? it.ours.title : it.title; tag = "Matches your SOP"; tagCls = "match";
    meta = [stSrc(b, it), plural(it.steps.length, "step"), it.imgs ? plural(stShots(it), "screenshot") : ""].filter(Boolean).join(" · ");
    if (!done) acts = `<button type="button" class="stBtn" data-act="keep" data-b="${b.id}" data-g="matches" data-i="${i}" data-fk="act:${key}:keep">Keep mine</button>
      <button type="button" class="stBtn dark" data-act="use" data-b="${b.id}" data-g="matches" data-i="${i}" data-fk="act:${key}:use" ${it.ours && !it.ours.library ? "" : "disabled"}>${it.imgs ? "Use the guide's steps" : "Use these steps"}</button>`;
  } else {
    title = it.key; tag = "Hotel detail"; tagCls = "det"; meta = it.value + (it.known ? "" : " · new detail name");
    if (!done) acts = `${master ? `<select class="stSel" data-dh="${esc(key)}" aria-label="Hotel for ${esc(it.key)}"><option value="">Pick a hotel</option>${(ST.info ? ST.info.hotels : []).map((h) => `<option value="${esc(h.id)}"${ST.hotelPick[key] === h.id ? " selected" : ""}>${esc(h.name)}</option>`).join("")}</select>` : ""}
      <button type="button" class="stBtn" data-act="skip" data-b="${b.id}" data-g="details" data-i="${i}" data-fk="act:${key}:skip">Skip</button>
      <button type="button" class="stBtn dark" data-act="apply" data-b="${b.id}" data-g="details" data-i="${i}" data-fk="act:${key}:apply">${master ? "Save" : "Save for " + esc(hotelName(b.target))}</button>`;
  }
  return `<div class="stCard${on ? " on" : ""}${done ? " done" : ""}" data-card="${esc(key)}">
    <div class="stCardTop"><button type="button" class="stCardMain" data-sel="${esc(key)}" data-fk="sel:${esc(key)}" aria-pressed="${on}"><span class="stCardT">${esc(title)}</span><span class="stCardM">${esc(meta)}</span></button><span class="stTag ${tagCls}">${tag}</span></div>
    ${done ? `<div class="stCardDone" role="text">${esc(done)}</div>` : `<div class="stCardActs">${acts}</div>`}
  </div>`;
}
function stResHtml(m) {
  const b = ST.batches[m.bid]; if (!b) return "";
  const notes = stBatchNotes(b, m), openNew = b.new.filter((x) => !x.state).length;
  const cards = [...b.new.map((x, i) => stCardHtml(b, "new", x, i)), ...b.matches.map((x, i) => stCardHtml(b, "matches", x, i)), ...b.details.map((x, i) => stCardHtml(b, "details", x, i))].join("");
  return `<div class="stRes"><div class="stMsg bot">${esc(stFound(b))}</div>
    ${notes.map((n) => `<p class="stNote">${esc(n)}</p>`).join("")}
    <div class="stCards">${cards}</div>
    ${openNew > 1 ? `<button type="button" class="stBtn dark stAll" data-all="${b.id}" data-fk="all:${b.id}">${b.target === "master" ? "Add all new to master as drafts" : "Add all new as drafts"}</button>` : ""}
    <button type="button" class="stLink" data-discard="${b.id}" data-fk="discard:${b.id}">Discard these results</button></div>`;
}
function stMsgHtml(m, i, liveIdx) {
  if (m.role === "err") return `<div class="stMsg err" role="alert">${esc(m.text)}</div>`;
  if (m.role === "me") {
    const files = (m.files || []).map((f) => `<span class="stFile">${stIcon.file}${esc(f.name)}<small>${stFmtSize(f.size)}</small></span>`).join("");
    const imgs = (m.imgs || []).length ? `<div class="stThumbs">${m.imgs.map((id) => `<button type="button" data-img="${esc(imgUrl(id))}" aria-label="Enlarge photo"><img alt="Attached photo" src="${imgUrl(id)}"></button>`).join("")}</div>` : "";
    return `<div class="stMe">${files ? `<div class="stFiles">${files}</div>` : ""}${m.text || imgs ? `<div class="stMsg me">${esc(m.text || "")}${imgs}</div>` : ""}</div>`;
  }
  if (m.role === "prog") return `<div class="stProg" data-prog="${i}"><div class="stProgHd">${esc(m.head)}</div>${m.files.map((f, k) => stProgRow(f, k)).join("")}</div>`;
  if (m.role === "res") return stResHtml(m);
  const live = m.options && m.options.length && !(m.answered || ST.busy || i !== liveIdx);
  const chips = m.options && m.options.length
    ? `<div class="stChips">${m.options.map((o) => m.multi
      ? `<button type="button" class="stChip" data-pick="${esc(o)}" aria-pressed="${ST.picks.has(o)}" ${live ? "" : "disabled"}>${esc(o)}</button>`
      : `<button type="button" class="stChip" data-opt="${esc(o)}" ${live ? "" : "disabled"}>${esc(o)}</button>`).join("")}${m.multi ? `<button type="button" class="stChip go" data-go="1" ${live && ST.picks.size ? "" : "disabled"}>${ST.picks.size ? `Continue with ${ST.picks.size}` : "Tap the ones you want"}</button>` : ""}</div>` : "";
  const card = m.draftCard && ST.draft ? `<button type="button" class="stDraftCard${ST.sel && ST.sel.k === "draft" ? " on" : ""}" data-draft="1" data-fk="draft"><span class="stCardT">${esc(ST.draft.title || "Untitled")}</span><span class="stCardM">${esc([ST.draft.category, plural(ST.draft.steps.length, "step")].filter(Boolean).join(" · "))}</span></button>` : "";
  return `<div class="stMsg bot">${esc(m.text)}</div>${card}${chips}`;
}
const stProgRow = (f, k) => `<div class="stPr ${f.cls}" data-pf="${k}"><span class="stPrN">${esc(f.name)} <small>${stFmtSize(f.size)}</small></span><span class="stPrS">${f.cls === "" && f.text !== "Waiting" ? '<span class="spin"></span>' : ""}<span class="stPrT">${esc(f.text)}</span></span></div>`;
function stPatchProg(prog, k) {
  const row = document.querySelector(`#stThread [data-prog="${ST.thread.indexOf(prog)}"] [data-pf="${k}"]`);
  if (!row) return;
  const t = document.createElement("template"); t.innerHTML = stProgRow(prog.files[k], k); row.replaceWith(t.content.firstElementChild);
}

function stHasPane() { return !!(ST.draft || stSelItem()); }
function stRenderThread(scroll = "keep") {
  const box = $("stThread"), fk = stFocusKey(), top = box.scrollTop;
  const lastDraft = ST.thread.map((m) => (m.draftCard ? 1 : 0)).lastIndexOf(1);
  ST.thread.forEach((m, i) => { if (m.role === "bot" && m.draftCard) m.draftCard = i === lastDraft; });
  const lastBot = ST.thread.map((m) => m.role).lastIndexOf("bot");
  box.innerHTML = ST.thread.map((m, i) => stMsgHtml(m, i, lastBot)).join("")
    + (ST.busy === "chat" ? `<div class="stTyping"><span class="spin"></span> <span>${esc(ST.progress || "Writing…")}</span></div>` : "")
    + (!stWide() && stHasPane() && ST.pane === "chat" ? `<button type="button" class="stPill press" data-view="1" data-fk="pill">View SOP</button>` : "");
  if (scroll === "bottom") box.scrollTop = box.scrollHeight;
  else if (typeof scroll === "number") { const el = box.children[scroll]; if (el) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8; }
  else box.scrollTop = top;
  stRestoreFocus(fk);
}

/* ----- the SOP on the right ----- */
function stPaneModel() {
  const si = stSelItem();
  if (si) {
    const { it, b, g, key } = si, done = stDoneText(it, key), master = b.target === "master";
    if (g === "new") return { kicker: "DRAFT PREVIEW", tag: ["new", "New"], title: it.title, sub: `${it.category || "Needs a category"} · from ${stSrc(b, it) || "your documents"}`, steps: it.steps, imgs: it.imgs, script: it.script, flag: it.flag, done, key, item: si,
      acts: done ? [] : [["edit", "Edit", ""], ["add", master ? "Add to master as draft" : "Add as draft", "dark"]] };
    if (g === "matches") return { kicker: "COMPARE WITH YOUR SOP", tag: ["match", "Matches your SOP"], title: it.ours ? it.ours.title : it.title, sub: `${it.sop_id}${it.difference ? " · " + it.difference : ""} · from ${stSrc(b, it) || "your documents"}`, steps: it.steps, imgs: it.imgs, script: it.script, flag: it.flag, done, key, item: si,
      cmp: it.ours ? { label: it.ours.library ? "In the library" : "Your SOP today", steps: it.ours.steps } : null, mineLabel: it.imgs ? "From the guide" : "Proposed steps",
      acts: done ? [] : [["edit", "Edit", "", !it.ours || it.ours.library], ["keep", "Keep mine", ""], ["use", it.imgs ? "Use the guide's steps" : "Use these steps", "dark", !it.ours || it.ours.library]] };
    return { kicker: "HOTEL DETAIL", tag: ["det", "Hotel detail"], title: it.key, sub: it.known ? "Fills {" + it.key + "} in SOPs" : "A new detail name", detail: it.value, done, key, item: si,
      acts: done ? [] : [["skip", "Skip", ""], ["apply", master ? "Save" : "Save for " + hotelName(b.target), "dark"]] };
  }
  if (ST.draft) {
    const d = ST.draft, master = ST.tgt === "master", exist = !master && ST.updateId ? sop(ST.updateId) : null, fill = stHasFill(d);
    const acts = [["edit", "Edit", ""]];
    if (master) {
      if (!ST.updateId) acts.push(["save", "Save as draft", ""], ["publish", "Publish", "dark", fill]);
      else if (ST.savedId === ST.updateId && ST.savedStatus === "draft") acts.push(["publish", "Publish", "dark", fill]);
    } else if (!exist) acts.push(["save", "Save as draft", ""], ["publish", "Publish", "dark", fill]);
    else { acts.push(["save", "Save changes", exist.status === "live" ? "dark" : ""]); if (exist.status !== "live") acts.push(["publish", "Publish", "dark", fill]); }
    const tag = ST.updateId ? ["match", exist || master ? `Updating ${ST.updateId}` : "Saved"] : ["new", "New"];
    return { kicker: "DRAFT PREVIEW", tag, title: d.title || "Untitled", sub: `${d.category || "No category yet"} · from this conversation`, steps: (d.steps || []).map((x) => x.t), imgs: (d.steps || []).map((x) => x.img), script: d.script, flag: d.flag, kw: d.kw,
      missing: (ST.last && ST.last.missing) || [], fillBlock: fill, acts, draft: true,
      note: master && ST.updateId ? "Open it in the editor to save changes to this master SOP." : "",
      queue: ST.queue.length ? `${plural(ST.queue.length, "more SOP")} to write after this one: ${ST.queue.join("; ")}. Save this one and the next follows.` : "",
      done: ST.savedId && ST.savedId === ST.updateId ? `Saved as ${ST.savedId}${ST.savedStatus === "draft" ? " · draft, not visible to staff yet" : ST.savedStatus === "live" ? " · live" : ""}` : "" };
  }
  return null;
}
function stRenderPane() {
  const box = $("stSop"), m = stPaneModel(), fk = stFocusKey(), top = (box.querySelector(".stSopBody") || {}).scrollTop || 0;
  if (!m) {
    box.innerHTML = `<div class="stBackRow"><button type="button" class="stBack" data-pa="back" data-fk="pa:back">${stIcon.back}Chat</button></div>
      <div class="stEmpty"><h2 id="stSopHead" tabindex="-1">Your SOP shows up here</h2><p>Describe a procedure on the left, or drop in documents. The draft appears here as soon as it is written, and you can change it by talking to me.</p></div>`;
    return;
  }
  const lines = (label, v) => (v ? `<div class="stLine"><b>${label}</b><div>${stTxt(v)}</div></div>` : "");
  const body = m.cmp
    ? `<div class="stCmp"><div><h3>${m.mineLabel}</h3>${stSteps(m.steps, m.imgs)}${lines("Say it like this", m.script)}${lines("Call the manager if", m.flag)}</div><div><h3>${esc(m.cmp.label)}</h3>${stSteps(m.cmp.steps)}</div></div>`
    : m.detail != null ? `<div class="stDetail"><div class="stDetailV">${esc(m.detail)}</div><p>Details fill the {Detail name} placeholders in SOPs.</p></div>`
    : `${stSteps(m.steps, m.imgs)}${lines("Say it like this", m.script)}${lines("Call the manager if", m.flag)}${lines("Ways staff might ask", m.kw)}`;
  const si = m.item;
  const catSel = si && si.g === "new" && !si.it.category && !m.done ? `<select class="stSel" data-cat="${esc(m.key)}" aria-label="Category">${`<option value="">Pick a category</option>` + si.b.cats.map((c) => `<option${ST.catPick[m.key] === c ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>` : "";
  const hotelSel = si && si.g === "details" && si.b.target === "master" && !m.done ? `<select class="stSel" data-dh="${esc(m.key)}" aria-label="Hotel"><option value="">Pick a hotel</option>${(ST.info ? ST.info.hotels : []).map((h) => `<option value="${esc(h.id)}"${ST.hotelPick[m.key] === h.id ? " selected" : ""}>${esc(h.name)}</option>`).join("")}</select>` : "";
  box.innerHTML = `<div class="stBackRow"><button type="button" class="stBack" data-pa="back" data-fk="pa:back">${stIcon.back}Chat</button></div>
    <div class="stSopHead"><div class="stKickRow"><span class="stKick">${m.kicker}</span><span class="stTag ${m.tag[0]}">${esc(m.tag[1])}</span></div>
      <h2 id="stSopHead" tabindex="-1">${esc(m.title)}</h2><div class="stSub">${esc(m.sub)}</div></div>
    <div class="stSopBody">${m.done ? `<div class="stSaved" role="status">${esc(m.done)}</div>` : ""}${body}
      ${m.missing && m.missing.length ? `<div class="stWarn">Still needed: ${m.missing.map(esc).join("; ")}</div>` : ""}
      ${m.fillBlock ? `<div class="stWarn">Fill in the highlighted [FILL] parts before you publish. Use Edit, or tell me the answer in the chat.</div>` : ""}
      ${m.note ? `<div class="stNote">${esc(m.note)}</div>` : ""}${m.queue ? `<div class="stNote">${esc(m.queue)}</div>` : ""}</div>
    <div class="stSopActs">${catSel}${hotelSel}${m.acts.map(([id, label, cls, dis]) => `<button type="button" class="stBtn ${cls}" data-pa="${id}" data-fk="pa:${id}" ${dis ? "disabled" : ""}>${esc(label)}</button>`).join("")}${m.draft && m.done ? `<button type="button" class="stBtn" data-pa="again" data-fk="pa:again">Start another</button>` : ""}</div>`;
  const nb = box.querySelector(".stSopBody"); if (nb) nb.scrollTop = top;
  stRestoreFocus(fk);
}
function stRenderPanes() {
  $("stGrid").dataset.pane = ST.pane;
}

/* ----- composer ----- */
function stRenderTray() {
  const ph = ST.pending.map((p, i) => `<span class="stTh ${p.up ? "up" : ""}"><img alt="Photo to send" src="${esc(p.url)}"><button type="button" data-rmp="${i}" aria-label="Remove photo">${stIcon.x}</button></span>`).join("");
  const dc = ST.docs.map((f, i) => `<span class="stFile">${stIcon.file}${esc(f.name)}<small>${stFmtSize(f.size)}</small><button type="button" data-rmd="${i}" aria-label="Remove ${esc(f.name)}">${stIcon.x}</button></span>`).join("");
  $("stTray").innerHTML = ph + dc;
}
function stRenderComposer() {
  const si = stSelItem(), ref = si && !si.it.state && si.g !== "details";
  const t = $("stText"), docs = stCanDocs();
  t.disabled = !stAiOn() || ST.busy === "docs";
  t.placeholder = !stAiOn() ? "AI isn't switched on" : ref ? "Tell me what to change" : ST.draft ? "Tell me what to change" : docs ? "Describe a procedure, or drop files here" : "Describe a procedure";
  $("stDoc").hidden = !docs;
  $("stRefine").hidden = !ref;
  if (ref) $("stRefine").innerHTML = `<span>Changing <b>${esc(si.g === "matches" && si.it.ours ? si.it.ours.title : si.it.title)}</b></span><button type="button" data-unref="1" aria-label="Stop changing this one and write something new">${stIcon.x}</button>`;
  $("stSend").disabled = !!ST.busy || ST.pending.some((p) => p.up) || (!$("stText").value.trim() && !ST.pending.length && !ST.docs.length);
  $("stHint").innerHTML = `${docs ? "PDF, Word, Excel, text or photos · up to 20 files" : "Photos · up to 6"}${docs ? ` · or use the <a href="/api/import/template.xlsx" download>spreadsheet template</a>` : ""} · <button type="button" class="inlinebtn" id="stSelf">Write it myself</button>`;
  $("stSelf").onclick = stWriteMyself;
  stRenderTray();
}
function stGrow() { const t = $("stText"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 150) + "px"; }
function stWriteMyself() {
  if (ST.tgt === "master") { (STATE.owner.master ? Promise.resolve() : loadMaster()).then(() => openMaster(null)).catch(fail); } else openSop(null);
}

/* ---------- phone panes ---------- */
function stShowPane(p) {
  ST.pane = p; stRenderPanes(); stRenderThread("keep");
  if (p === "sop") { stRenderPane(); const h = $("stSopHead"); if (h) h.focus({ preventScroll: true }); $("stSop").scrollIntoView?.({ block: "nearest" }); scrollTo(0, 0); }
  else { const pill = document.querySelector('#stThread [data-view]'); (pill || $("stText")).focus({ preventScroll: true }); }
}
function stSelect(sel, toPane) {
  ST.sel = sel; stRenderThread("keep"); stRenderPane(); stRenderComposer();
  if (toPane && !stWide()) stShowPane("sop");
}

/* ---------- conversation (the author) ---------- */
function stCtx() {
  const si = stSelItem();
  if (si && !si.it.state && si.g !== "details") return { k: "item", key: si.key, bid: si.bid, g: si.g, i: si.i };
  return { k: "draft" };
}
const stSeedOf = (it, ours) => ({ title: ours ? ours.title : it.title, category: (ours && ours.cat) || it.category || "", steps: it.steps.map((t, i) => ({ t, img: (it.imgs && it.imgs[i]) || null })), script: it.script || "", flag: it.flag || "", kw: "" });
async function stChatSend(text, imageIds, ctx, extra) {
  text = String(text || "").trim(); ctx = ctx || stCtx();
  if (ST.busy || (!text && !imageIds.length)) return;
  const tok = ST.tok, mine = { role: "me", text, imgs: imageIds };
  ST.thread.push(mine); ST.busy = "chat"; ST.progress = ""; stRenderThread("bottom"); stRenderComposer();
  try {
    let body;
    if (ctx.k === "draft") body = { draftId: ST.draftId || undefined, message: text, imageIds, target: stAuthorTarget(), sopId: ST.sopId || undefined, seed: ST.draftId ? undefined : ST.seed || undefined, ...(extra || {}) };
    else {
      const it = stItem(ctx.bid, ctx.g, ctx.i); if (!it || it.state) throw new Error("That one is already handled. Pick another.");
      body = { draftId: ST.cardAu[ctx.key] || undefined, message: text, imageIds, target: stAuthorTarget(), sopId: ctx.g === "matches" ? it.sop_id : undefined, seed: ST.cardAu[ctx.key] ? undefined : stSeedOf(it, it.ours) };
    }
    const r = await api("/api/author", { body });
    if (tok !== ST.tok) return;
    if (ctx.k === "draft") ST.draftId = r.draftId; else ST.cardAu[ctx.key] = r.draftId;
    if (r.kind === "ask") { ST.thread.push({ role: "bot", text: r.question, options: r.options, multi: !!r.multi, ctx }); ST.picks = new Set(); stSay(r.question); }
    else if (ctx.k === "draft") {
      ST.last = r; ST.draft = r.draft; ST.updateId = r.updateId || ST.savedId || null; ST.sel = { k: "draft" };
      if (!extra || !extra.nextSop) { /* a new draft is a new thing to save */ }
      ST.thread.push({ role: "bot", text: r.notes || "Here's the draft. Check it on the right.", draftCard: true }); stSay("The draft is ready.");
    } else {
      const nb = await api(`/api/import/${ctx.bid}/item`, { hotel: false, method: "PUT", body: { group: ctx.g, index: ctx.i, draft: r.draft } });
      if (tok !== ST.tok) return;
      ST.batches[ctx.bid] = nb; ST.thread.push({ role: "bot", text: r.notes || "Updated. Check it on the right." }); stSay("Updated.");
    }
    ST.busy = ""; stRenderThread("bottom"); stRenderPane(); stRenderComposer();
    if (!stWide() && ctx.k === "draft" && r.kind !== "ask") stRenderThread("keep");
  } catch (e) {
    if (tok !== ST.tok) return;
    ST.busy = ""; ST.thread.pop(); // take the unsent message back so it can be edited and retried
    if (/expired/i.test(e.message)) { if (ctx.k === "draft") ST.draftId = null; else delete ST.cardAu[ctx.key]; }
    ST.thread.push({ role: "err", text: e.message });
    $("stText").value = text; stGrow(); ST.pending = imageIds.map((id) => ({ id, url: imgUrl(id), up: false }));
    stRenderThread("bottom"); stRenderComposer();
  }
}
function stNext() { // the next SOP of a "make these 3" list
  if (!ST.queue.length) return;
  const next = ST.queue[0]; ST.queue = ST.queue.slice(1); ST.draft = null; ST.updateId = null; ST.savedId = null; ST.savedStatus = ""; ST.sel = null;
  stRenderPane(); stChatSend(`Next one: ${next}`, [], { k: "draft" }, { nextSop: true });
}

/* ---------- save, publish, edit (the conversation's draft) ---------- */
function stDraftBody(d, status) {
  return { title: d.title, cat: d.category, steps: (d.steps || []).map((x) => ({ t: x.t, img: x.img || null })), script: d.script || "", flag: d.flag || "", kw: d.kw || "", ...(status ? { status } : {}) };
}
async function stSave(publish) {
  const d = ST.draft; if (!d || ST.acting) return;
  if (publish && stHasFill(d)) return toast("Fill in the [FILL] parts first");
  ST.acting = true; const tok = ST.tok;
  try {
    let msg;
    if (ST.tgt === "master") {
      let out;
      if (ST.updateId) out = STATE.owner.master ? STATE.owner.master.sops.find((x) => x.id === ST.updateId) : { id: ST.updateId };
      else {
        out = await api("/api/master", { hotel: false, body: { ...stDraftBody(d), steps: (d.steps || []).map((x) => ({ t: x.t, hk: null, img: x.img || null })), applies: "all", requires: null } });
        ST.updateId = ST.savedId = out.id; ST.savedStatus = "draft";
      }
      if (publish) { out = await api(`/api/master/${encodeURIComponent(ST.updateId)}/publish`, { hotel: false, body: {} }); ST.savedStatus = "live"; }
      STATE.owner.master = null; portfolioStale();
      msg = publish ? `Published ${ST.updateId} to hotels.` : `Saved ${ST.updateId} to the master library as a draft. Hotels don't see it until you publish it.`;
    } else {
      const exist = ST.updateId ? sop(ST.updateId) : null;
      let out;
      if (exist) {
        out = await api(`/api/sops/${encodeURIComponent(exist.id)}`, { method: "PUT", body: stDraftBody(d, publish ? "live" : exist.status) });
        Object.assign(exist, out);
      } else {
        out = await api("/api/sops", { body: stDraftBody(d, publish ? "live" : "draft") });
        STATE.sops.push(out); STATE.sops.sort((a, b) => a.id.localeCompare(b.id));
      }
      ST.updateId = ST.savedId = out.id; ST.savedStatus = out.status;
      msg = exist ? (publish ? `Published ${out.id}.` : `Saved your changes to ${out.id}.`) : publish ? `Published ${out.id}. Staff can ask about it now.` : `Saved ${out.id} as a draft. Staff can't see it until you switch it on.`;
      SU.dirty = true; loadHotel().catch(() => {});
    }
    if (tok !== ST.tok) return;
    ST.thread.push({ role: "bot", text: msg }); toast(msg); stSay(msg);
    ST.acting = false; stRenderThread("bottom"); stRenderPane();
    if (ST.queue.length) stNext();
  } catch (e) { ST.acting = false; fail(e); }
  ST.acting = false;
}
async function stOpenEditor() { // Edit: the existing SOP editor, with this draft in it
  const si = stSelItem();
  try {
    if (ST.tgt === "master" || (si && si.b.target === "master")) { if (!STATE.owner.master) await loadMaster(); }
    if (si) {
      const { it, g, b } = si, d = { title: g === "matches" && it.ours ? it.ours.title : it.title, category: (it.ours && it.ours.cat) || it.category || "", steps: it.steps.map((t, i) => ({ t, img: (it.imgs && it.imgs[i]) || null })), script: it.script || "", flag: it.flag || "", kw: "" };
      ST.editFor = { k: "item", bid: si.bid, g, i: si.i };
      if (b.target === "master") openMaster(g === "matches" ? it.sop_id : null, d); else openSop(g === "matches" ? it.sop_id : null, null, null, d);
    } else if (ST.draft) {
      const upd = ST.updateId; ST.editFor = { k: "draft" };
      if (ST.tgt === "master") openMaster(upd && STATE.owner.master.sops.some((m) => m.id === upd) ? upd : null, ST.draft);
      else openSop(upd && sop(upd) ? upd : null, null, null, ST.draft);
      if (upd) toast(`Updating ${upd}. Review it, then save.`);
    }
  } catch (e) { ST.editFor = null; fail(e); }
}
// The editor saved something that came from the studio.
function studioSaved(out, master) {
  const e = ST.editFor; ST.editFor = null; if (!e || !ST.active) return;
  if (e.k === "draft") {
    ST.updateId = ST.savedId = out.id; ST.savedStatus = out.status || "draft";
    ST.thread.push({ role: "bot", text: `Saved ${out.id}${master ? "" : out.status === "live" ? ". It is live." : " as a draft."}` });
    stRenderThread("bottom"); stRenderPane();
    if (ST.queue.length) stNext();
  } else {
    const key = stKey(e.bid, e.g, e.i);
    api(`/api/import/${e.bid}/act`, { hotel: false, body: { group: e.g, index: e.i, action: "skip" } }).then((nb) => {
      delete nb.note; ST.batches[e.bid] = nb; ST.notes[key] = `Saved as ${out.id} from the editor`; stRenderThread("keep"); stRenderPane(); stRenderComposer();
    }).catch(() => {});
  }
}
// The editor sheet closed. A "make these 3" list carries on even if the manager closed the editor without saving.
function studioSheetClosed() {
  if (!ST.active) return;
  const e = ST.editFor; ST.editFor = null;
  if (e && e.k === "draft" && ST.queue.length && mode === "studio") stNext();
}

/* ---------- photos and documents in ---------- */
async function stAttachPhotos(files) {
  const list = [...files].filter((f) => f.type.startsWith("image/"));
  if (!list.length) { if (files.length) toast("Choose a photo or screenshot"); return; }
  if (!stAiOn()) return toast("Photos need AI, and AI isn't switched on yet");
  for (const f of list) {
    if (ST.pending.length >= ST_MAX_PHOTOS) { toast(`Up to ${ST_MAX_PHOTOS} photos at a time`); break; }
    const p = { id: null, url: URL.createObjectURL(f), up: true }; ST.pending.push(p); stRenderComposer();
    try {
      const dataUrl = await shrink(f, 1280);
      p.id = (await api("/api/images", { body: { dataUrl } })).id; p.up = false;
    } catch (e) { ST.pending.splice(ST.pending.indexOf(p), 1); fail(e.message ? e : new Error("That image couldn't be read. Try a JPG or PNG.")); }
    stRenderComposer();
  }
}
function stAddFiles(all) {
  const files = [...all];
  const photos = files.filter((f) => f.type.startsWith("image/")), docs = files.filter((f) => !f.type.startsWith("image/"));
  if (photos.length) stAttachPhotos(photos);
  if (!docs.length) return;
  if (!stCanDocs()) return toast("Reading documents is for a GM or the Owner. Photos work for everyone.");
  const I = ST.info || { maxMb: 10, aiOn: stAiOn() }, aiOn = I.aiOn !== false && (I.aiOn || stAiOn());
  const next = [...ST.docs];
  for (const f of docs) {
    const ext = "." + f.name.split(".").pop().toLowerCase();
    if (!ST_EXTS.includes(ext)) { toast(`${f.name}: use PDF, Word, Excel, CSV or text`); continue; }
    if (f.size > I.maxMb * 1048576) { toast(`${f.name} is over ${I.maxMb} MB`); continue; }
    if (!aiOn && !stIsSheet(f)) { toast("Reading documents needs an AI key, and none is set up yet. The spreadsheet template works without one."); continue; }
    if (next.some((x) => x.name === f.name && x.size === f.size)) continue;
    if (next.length >= ST_MAX_FILES) { toast(`Up to ${ST_MAX_FILES} files at a time`); break; }
    next.push(f);
  }
  ST.docs = next; stRenderComposer();
}

async function stReadDocs(text) {
  const files = ST.docs.splice(0), tok = ST.tok, tgt = ST.tgt, alive = () => tok === ST.tok, problems = [];
  ST.busy = "docs";
  const prog = { role: "prog", head: `Reading ${plural(files.length, "file")}…`, files: files.map((f) => ({ name: f.name, size: f.size, text: "Waiting", cls: "" })) };
  ST.thread.push({ role: "me", text, files: files.map((f) => ({ name: f.name, size: f.size })) }, prog);
  stRenderThread("bottom"); stRenderComposer();
  let lastSay = 0;
  const st = (f, t, cls = "") => {
    const k = files.indexOf(f); if (k < 0) return; prog.files[k].text = t; prog.files[k].cls = cls;
    if (alive()) stPatchProg(prog, k);
    if (cls || Date.now() - lastSay > 4000) { lastSay = Date.now(); stSay(`${f.name}: ${t}`); }
  };
  let batch = null, lastErr = null;
  const I = ST.info || { maxMb: 10 }, aiOn = ST.info ? ST.info.aiOn : stAiOn();
  const fail1 = (f, e) => { lastErr = e; problems.push(`${f.name}: ${e.message}`); st(f, e.message || "Couldn't read this file.", "no"); };
  const bid = () => (batch ? batch.id : undefined);
  const others = files.filter((f) => !stIsPdf(f) && !stIsSheet(f));
  // 1. spreadsheets: the template is read without AI; any other sheet is read like a document
  for (const f of files.filter(stIsSheet)) {
    st(f, "Reading…");
    try { batch = await api("/api/import/sheet", { hotel: false, body: { target: tgt, batchId: bid(), file: { name: f.name, data: await readDataUrl(f) } } }); st(f, "Done", "ok"); }
    catch (e) { if (aiOn && /Title column/i.test(e.message)) others.push(f); else fail1(f, e); }
  }
  // 2. Word and text: a few at a time into the same batch
  for (let k = 0; k < others.length; k += 3) {
    const chunk = others.slice(k, k + 3); chunk.forEach((f) => st(f, "Reading…"));
    try {
      const data = await Promise.all(chunk.map(async (f) => ({ name: f.name, data: await readDataUrl(f) })));
      batch = await api("/api/import/upload", { hotel: false, body: { target: tgt, batchId: bid(), files: data } });
      chunk.forEach((f) => st(f, "Done", "ok"));
    } catch (e) { chunk.forEach((f) => fail1(f, e)); }
  }
  // 3. PDFs, one after another: read here on this device, screenshots uploaded, then only the structure goes to the server
  for (const f of files.filter(stIsPdf)) {
    try {
      if (f.size > I.maxMb * 1048576) throw new Error(`That PDF is over ${I.maxMb} MB.`);
      const prep = await prepPdf(f, { hotelId: tgt === "master" ? undefined : tgt, onStatus: (t) => st(f, t) });
      st(f, prep.isGuide ? `Sorting ${prep.shots} screenshots into steps…` : "Reading the text…");
      // the screenshots are the server's from here on: it keeps the ones the drafts use and deletes the rest, also when this fails
      batch = await runJob("/api/import/pdf", { hotel: false, body: { target: tgt, batchId: bid(), ...prep.body } });
      st(f, prep.isGuide ? `Done · ${prep.shots} screenshot${prep.shots === 1 ? "" : "s"}` : "Done · read as text", "ok");
    } catch (e) { fail1(f, e); }
  }
  if (!alive()) return;
  ST.busy = "";
  if (!batch) {
    prog.head = "Couldn't read these files";
    ST.thread.push({ role: "err", text: (lastErr && lastErr.message) || "Something went wrong. Try again." });
    stRenderThread("bottom"); stRenderComposer(); return;
  }
  prog.head = `Read ${plural(files.length - problems.length, "file")}${problems.length ? `, ${problems.length} failed` : ""}`;
  ST.batches[batch.id] = batch;
  if (batch.target === "master") { STATE.owner.master = null; portfolioStale(); }
  ST.thread.push({ role: "res", bid: batch.id, problems });
  const first = stFirstOpen(batch);
  if (first) ST.sel = { k: "item", bid: batch.id, ...first };
  stRenderThread(ST.thread.length - 1); stRenderPane(); stRenderComposer();
  stSay(stFound(batch));
}
const stFirstOpen = (b) => {
  for (const g of ["new", "matches", "details"]) { const i = b[g].findIndex((x) => !x.state); if (i >= 0) return { g, i }; }
  for (const g of ["new", "matches", "details"]) if (b[g].length) return { g, i: 0 };
  return null;
};

/* ---------- one card: Add, Skip, Keep, Use ---------- */
async function stAct(bid, g, i, action, extra = {}) {
  if (ST.acting) return; ST.acting = true;
  try {
    const nb = await api(`/api/import/${bid}/act`, { hotel: false, body: { group: g, index: i, action, ...extra } });
    const note = nb.note; delete nb.note; ST.batches[bid] = nb;
    if (nb.target === "master") { STATE.owner.master = null; portfolioStale(); }
    else { SU.dirty = true; if (nb.target === STATE.hotel) loadHotel().catch(() => {}); }
    stRenderThread("keep"); stRenderPane(); stRenderComposer(); toast(note || "Done"); stSay(note || "Done");
  } catch (e) { fail(e); }
  ST.acting = false;
}
function stActFromEl(btn) {
  const bid = +btn.dataset.b, g = btn.dataset.g, i = +btn.dataset.i, action = btn.dataset.act, key = stKey(bid, g, i), extra = {};
  if (g === "new" && action === "add") { const s = document.querySelector(`#studio [data-cat="${CSS.escape(key)}"]`); const v = s ? s.value : ST.catPick[key]; if (v) extra.category = v; }
  if (g === "details" && action === "apply" && stItem(bid, g, i) && ST.batches[bid].target === "master") {
    const s = document.querySelector(`#studio [data-dh="${CSS.escape(key)}"]`); extra.hotel = (s ? s.value : ST.hotelPick[key]) || "";
    if (!extra.hotel) return toast("Pick a hotel first");
  }
  stAct(bid, g, i, action, extra);
}

/* ---------- earlier uploads ---------- */
async function stOpenBatch(id) {
  const existing = ST.thread.findIndex((m) => m.role === "res" && m.bid === id);
  try {
    const b = await api(`/api/import/${id}`, { hotel: false });
    if (b.target !== ST.tgt && !(b.target === "master" && ST.tgt === "master")) {
      // a batch for another hotel or the master library: switch to it first (the Owner's Save to)
      if (isOwner()) { await stSetTargetQuiet(b.target); } else if (b.target !== ST.tgt) { ST.tgt = b.target; }
    }
    ST.batches[id] = b;
    if (existing < 0) {
      ST.thread.push({ role: "bot", text: `Here are your earlier results: ${b.files.join(", ")}.${b.open ? ` ${plural(b.open, "item")} left to decide.` : " Everything was handled."}` });
      ST.thread.push({ role: "res", bid: id, problems: [] });
    }
    const first = stFirstOpen(b); if (first) ST.sel = { k: "item", bid: id, ...first };
    stRenderHead(); stRenderThread(existing >= 0 ? existing : ST.thread.length - 1); stRenderPane(); stRenderComposer();
    if (!stWide() && first) stShowPane("sop");
  } catch (e) { fail(e); }
}
async function stSetTargetQuiet(v) {
  if (v !== "master" && v !== STATE.hotel) { STATE.hotel = v; try { localStorage.setItem("asklotus.hotel", v); } catch {} newChat(true); renderPropMenu(); await loadHotel(); }
  ST.tgt = v;
}
async function stTogglePop() {
  if (ST.popOpen) return stClosePop(true);
  ST.popOpen = true; const pop = $("stPop"); pop.hidden = false; $("stEarlier").setAttribute("aria-expanded", "true");
  pop.innerHTML = `<div class="stPopHd">Earlier uploads</div><div class="stPopEmpty">Loading…</div>`;
  try { ST.list = await api(`/api/imports?target=${encodeURIComponent(ST.tgt)}`, { hotel: false }); } catch (e) { stClosePop(); return fail(e); }
  if (!ST.popOpen) return;
  pop.innerHTML = `<div class="stPopHd">Earlier uploads</div>${ST.list.length
    ? ST.list.map((b) => `<button type="button" class="stPopRow" data-bid="${b.id}"><span class="stPopT">${esc(b.files.join(", "))}</span><span class="stPopM">${b.status === "done" ? "All handled" : `${b.open} of ${b.total} left to decide`} · ${fmtDT(b.created)}${b.by ? " · " + esc(b.by) : ""}</span></button>`).join("")
    : `<div class="stPopEmpty">Nothing uploaded yet.</div>`}`;
  const first = pop.querySelector(".stPopRow"); if (first) first.focus();
}
function stClosePop(refocus) {
  if (!ST.popOpen) return; ST.popOpen = false; $("stPop").hidden = true; $("stEarlier").setAttribute("aria-expanded", "false");
  if (refocus) $("stEarlier").focus();
}

/* ---------- wiring (once) ---------- */
function stSubmit() {
  if (ST.busy || ST.pending.some((p) => p.up)) return;
  const text = $("stText").value.trim(), ids = ST.pending.map((p) => p.id).filter(Boolean);
  if (ST.docs.length) {
    if (ids.length) toast("Photos go in their own message. Send them next.");
    $("stText").value = ""; stGrow(); stReadDocs(text); return;
  }
  if (!text && !ids.length) return;
  $("stText").value = ""; stGrow(); ST.pending = [];
  stChatSend(text, ids);
}
function studioInit() {
  const root = $("studio");
  $("stClose").onclick = () => go((ST.back || "#admin").slice(1) || "admin");
  $("stEarlier").onclick = (e) => { e.stopPropagation(); stTogglePop(); };
  $("stTarget").onchange = (e) => stSetTarget(e.target.value);
  $("stSend").onclick = stSubmit;
  $("stText").addEventListener("input", () => { stGrow(); $("stSend").disabled = !!ST.busy || ST.pending.some((p) => p.up) || (!$("stText").value.trim() && !ST.pending.length && !ST.docs.length); });
  $("stText").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(pointer:coarse)").matches) { e.preventDefault(); stSubmit(); } });
  $("stText").addEventListener("paste", (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); stAttachPhotos(files); }
  });
  $("stPhoto").onclick = () => { $("stPickPhoto").value = ""; $("stPickPhoto").click(); };
  $("stDoc").onclick = () => { $("stPickDoc").value = ""; $("stPickDoc").click(); };
  $("stPickPhoto").onchange = () => stAttachPhotos($("stPickPhoto").files);
  $("stPickDoc").onchange = () => stAddFiles($("stPickDoc").files);
  $("stComposer").addEventListener("click", (e) => {
    const rp = e.target.closest("[data-rmp]"), rd = e.target.closest("[data-rmd]"), un = e.target.closest("[data-unref]");
    if (rp) { ST.pending.splice(+rp.dataset.rmp, 1); stRenderComposer(); }
    else if (rd) { ST.docs.splice(+rd.dataset.rmd, 1); stRenderComposer(); }
    else if (un) { ST.sel = ST.draft ? { k: "draft" } : null; stRenderThread("keep"); stRenderPane(); stRenderComposer(); $("stText").focus(); }
  });
  // the thread: cards, chips, buttons
  $("stThread").addEventListener("click", (e) => {
    const t = e.target;
    const img = t.closest("[data-img]"); if (img) { openLB(img.dataset.img.startsWith("/") ? img.dataset.img : imgUrl(img.dataset.img)); return; }
    const act = t.closest("[data-act]"); if (act) return stActFromEl(act);
    const all = t.closest("[data-all]"); if (all) return stAct(+all.dataset.all, "new", -1, "addAll");
    const dis = t.closest("[data-discard]");
    if (dis) {
      if (!confirm("Discard these results? Items you haven't handled will be lost.")) return;
      const id = +dis.dataset.discard;
      api(`/api/import/${id}/discard`, { hotel: false, body: {} }).then(() => {
        ST.thread = ST.thread.filter((m) => !(m.role === "res" && m.bid === id)); delete ST.batches[id];
        if (ST.sel && ST.sel.k === "item" && ST.sel.bid === id) ST.sel = ST.draft ? { k: "draft" } : null;
        stRenderThread("keep"); stRenderPane(); stRenderComposer(); toast("Results discarded");
      }).catch(fail); return;
    }
    const sel = t.closest("[data-sel]");
    if (sel) { const [b, g, i] = sel.dataset.sel.split(":"); return stSelect({ k: "item", bid: +b, g, i: +i }, true); }
    const dr = t.closest("[data-draft]"); if (dr) return stSelect({ k: "draft" }, true);
    if (t.closest("[data-view]")) return stShowPane("sop");
    const opt = t.closest("[data-opt]");
    if (opt) { const m = ST.thread.filter((x) => x.options).pop(); if (m) m.answered = true; return stChatSend(opt.dataset.opt, [], m && m.ctx); }
    const pk = t.closest("[data-pick]"); if (pk) { const o = pk.dataset.pick; ST.picks.has(o) ? ST.picks.delete(o) : ST.picks.add(o); return stRenderThread("keep"); }
    if (t.closest("[data-go]")) {
      const m = ST.thread.filter((x) => x.options).pop(), chosen = m.options.filter((o) => ST.picks.has(o));
      if (!chosen.length) return;
      m.answered = true; ST.picks = new Set(); ST.queue = chosen.slice(1);
      return stChatSend(chosen.length === 1 ? `Make this one: ${chosen[0]}` : `Make these ${chosen.length} SOPs, one at a time. Start with: ${chosen[0]}. Then: ${chosen.slice(1).join("; ")}`, [], m.ctx);
    }
    // a click on the card itself (not a button) selects it
    const card = t.closest("[data-card]");
    if (card && !t.closest("button,select,a")) { const [b, g, i] = card.dataset.card.split(":"); stSelect({ k: "item", bid: +b, g, i: +i }, true); }
  });
  $("stThread").addEventListener("change", (e) => {
    const c = e.target.closest("[data-cat]"), h = e.target.closest("[data-dh]");
    if (c) ST.catPick[c.dataset.cat] = c.value; if (h) ST.hotelPick[h.dataset.dh] = h.value;
  });
  // the SOP pane
  $("stSop").addEventListener("change", (e) => {
    const c = e.target.closest("[data-cat]"), h = e.target.closest("[data-dh]");
    if (c) ST.catPick[c.dataset.cat] = c.value; if (h) ST.hotelPick[h.dataset.dh] = h.value;
  });
  $("stSop").addEventListener("click", (e) => {
    const img = e.target.closest("[data-img]"); if (img) return openLB(imgUrl(img.dataset.img));
    const b = e.target.closest("[data-pa]"); if (!b || b.disabled) return;
    const a = b.dataset.pa, si = stSelItem();
    if (a === "back") return stShowPane("chat");
    if (a === "edit") return stOpenEditor();
    if (a === "again") { studioDiscard(); ST.draft = null; ST.draftId = null; ST.updateId = ST.savedId = null; ST.savedStatus = ""; ST.seed = null; ST.sopId = null; ST.sel = null; ST.last = null; ST.thread.push({ role: "bot", text: "What should we write next?" }); stRenderAll(); $("stText").focus(); return; }
    if (si) {
      const el = { dataset: { b: si.bid, g: si.g, i: si.i, act: a } };
      if (a === "add" || a === "skip" || a === "keep" || a === "use" || a === "apply") return stActFromEl(el);
    }
    if (a === "save") return stSave(false);
    if (a === "publish") return stSave(true);
  });
  // earlier uploads
  $("stPop").addEventListener("click", (e) => { const r = e.target.closest("[data-bid]"); if (r) { stClosePop(); stOpenBatch(+r.dataset.bid); } });
  document.addEventListener("click", (e) => { if (ST.popOpen && !e.target.closest("#stPop") && !e.target.closest("#stEarlier")) stClosePop(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ST.popOpen) { e.stopPropagation(); stClosePop(true); } });
  // drag and drop anywhere on the page
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  const over = (on) => { $("stDrop").hidden = !on; };
  root.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; over(true); });
  root.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  root.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) over(false); });
  root.addEventListener("drop", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; over(false); stAddFiles(e.dataTransfer.files); });
  matchMedia("(min-width:900px)").addEventListener("change", () => { if (mode === "studio") { ST.pane = "chat"; stRenderAll(); } });
}
