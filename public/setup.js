"use strict";
/* Guided setup for a new hotel (GM onboarding), the Welcome kit and the Owner's progress cards.
   Loaded BEFORE app.js, so this file only declares functions and constants; it uses app.js globals
   (SU, STATE, api, esc, Spring, toast, ...) when it is called, never while it loads. */

const WZ_STEPS = [
  ["hotel", "Your hotel"], ["amenities", "Amenities"], ["policies", "Policies"], ["rooms", "Rooms"],
  ["systems", "Systems"], ["contacts", "Contacts & chats"], ["team", "Team"], ["review", "Review & go live"],
];
const WZ_SUB = {
  hotel: "The basics your team gets asked about.",
  amenities: "Tell us what your hotel offers. We switch on the right SOPs.",
  policies: "How your hotel handles cash, fees and house rules.",
  rooms: "Rollaways, cribs, accessible rooms and where things are kept.",
  systems: "The tools your front desk uses every day.",
  contacts: "Who staff call, and the two WhatsApp chats.",
  team: "Add the people who will sign in.",
  review: "Check everything, then open the hotel to your team.",
};
const WZ_LABEL = {
  "Hotel name": "Hotel name, as you say it on the phone", "Hotel short name": "Shorter name for scripts",
  "Wi-Fi network": "Wi-Fi network name", "Wi-Fi network name": "Wi-Fi name, as the help SOP shows it",
  "Hotel welcome name": "How you welcome guests", "Hotel location check": "Name and street, to tell it from look-alikes",
};
const WZ_DEFAULT_ROLES = ["GM", "AGM", "Engineer", "Head Housekeeper"];
const WZ_ROLE_HELP = { GM: "General Manager", AGM: "Assistant General Manager", Engineer: "Maintenance and emergencies", "Head Housekeeper": "Rooms and supplies" };
const WZ_AMEN_ICON = { breakfast: "M4 11h13v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-4Zm13 1h1.5a2.5 2.5 0 0 1 0 5H17M8 3v4m4-4v4", pool: "M3 17c1.5 0 1.5 1 3 1s1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1M8 14V6a2 2 0 0 1 4 0M14 14V6a2 2 0 0 1 4 0M8 9h6", pets: "M6 11.5a1.8 2.4 0 1 0 0-.01M18 11.5a1.8 2.4 0 1 0 0-.01M9.5 6.5a1.8 2.4 0 1 0 0-.01M14.5 6.5a1.8 2.4 0 1 0 0-.01M12 12c-3 0-5.5 3-4.5 5.2.8 1.8 2.6 1.3 4.5 1.3s3.7.5 4.5-1.3C17.5 15 15 12 12 12Z", laundry: "M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm6 15a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z", market: "M4 9l1.5-5h13L20 9M4 9v10h16V9M4 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3" };

const WZ = {
  screen: "welcome", dir: 1, pend: {}, timer: 0, saving: 0, savedAt: 0, rdyTimer: 0, prevPct: 0,
  rowQ: new Set(), more: new Set(), sopsOpen: false, tpl: { on: true, from: null }, copyOpen: false, copyFrom: null, busy: "",
  pw: {}, celebrate: false, kitUsers: null, newUser: { name: "", username: "", role: "Front Desk", touched: false },
  crows: null, fix: null, orig: {},
};

/* ---------- small helpers ---------- */
const wzSteps = () => WZ_STEPS.map(([id]) => id);
const wzIdx = (id) => wzSteps().indexOf(id);
const wzShort = () => (SU.data && SU.data.prefilledNames && Object.values(SU.data.prefilledNames)[0]) || "Hampton";
const wzFillPrompt = (v) => { const m = String(v ?? "").match(/\[FILL:?\s*([^\]]*)\]/); return m ? m[1].trim() || "Needs your answer" : null; };
const wzVal = (k) => { const v = SU.det[k]; return v === undefined || /\[FILL/.test(v) || v === NOT_OFFERED ? "" : v; };
const wzDigits = (s) => String(s ?? "").replace(/\D/g, "");
function wzPhoneLive(s) {
  let d = wzDigits(s); if (d.length > 10 && d[0] === "1") d = d.slice(1); d = d.slice(0, 10);
  if (d.length < 4) return d;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
const wzSvg = (path, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const wzFirst = (name) => String(name || "").trim().split(/\s+/)[0] || "";
const wzAgo = (iso) => {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "just now"; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24); return d === 1 ? "yesterday" : `${d} days ago`;
};
const wzLower = (s) => String(s || "").replace(/^[A-Z]/, (c) => c.toLowerCase());

/* ---------- saving (debounced autosave with a quiet "Saved" mark) ---------- */
function wzMark() {
  const el = $("wzSave"); if (!el) return;
  if (WZ.saving > 0 || Object.keys(WZ.pend).length || WZ.rowQ.size) { el.textContent = "Saving…"; el.dataset.s = "saving"; }
  else if (WZ.savedAt) { el.textContent = "Saved"; el.dataset.s = "saved"; }
  else { el.textContent = ""; el.dataset.s = ""; }
}
function wzTrack(p) {
  WZ.saving++; wzMark();
  return Promise.resolve(p).then((r) => { WZ.saving--; WZ.savedAt = Date.now(); wzMark(); wzRdySoon(); return r; }, (e) => { WZ.saving--; wzMark(); throw e; });
}
function wzQueue(k, v) {
  SU.det[k] = v; WZ.pend[k] = v;
  wzMark(); // "Saving…" shows from the first keystroke
  clearTimeout(WZ.timer); WZ.timer = setTimeout(wzFlush, 650);
}
function wzFlush() {
  clearTimeout(WZ.timer);
  const keys = Object.keys(WZ.pend);
  if (!keys.length) { wzMark(); return Promise.resolve(); }
  const details = WZ.pend; WZ.pend = {};
  return wzTrack(suRun(() => api("/api/hotel/details", { method: "PUT", body: { merge: true, details } })))
    .then((r) => { if (r && r.prefilled) { SU.data.prefilled = r.prefilled; wzSyncBadges(); } })
    .catch(fail);
}
addEventListener("pagehide", () => {
  const keys = Object.keys(WZ.pend); if (!keys.length || !STATE.hotel) return;
  try { fetch(`/api/hotel/details?hotel=${encodeURIComponent(STATE.hotel)}`, { method: "PUT", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ merge: true, details: WZ.pend }), credentials: "same-origin" }); } catch { /* best effort */ }
});
function wzRdySoon() {
  clearTimeout(WZ.rdyTimer);
  WZ.rdyTimer = setTimeout(async () => {
    if (mode !== "setup" || !SU.data || SU.view !== "wizard") return;
    try { const r = await api("/api/setup/readiness"); SU.data.readiness = r; wzPaintReady(); } catch { /* the next save tries again */ }
  }, 500);
}
function wzPaintReady() {
  const r = SU.data.readiness; if (!r) return;
  const chip = $("wzReady"); if (chip) { chip.textContent = `${r.score}% ready`; chip.dataset.ok = r.essentialsDone ? "1" : ""; }
  if (WZ.screen === "review") wzPaintReview();
}
function wzSyncBadges() {
  document.querySelectorAll("[data-same]").forEach((el) => { if (!SU.data.prefilled[el.dataset.same]) el.remove(); });
}

/* ---------- loading and moving between screens ---------- */
function wzStartScreen() {
  const d = SU.data;
  if (d.hotel.setup === "new") return "welcome";
  return d.uiStep && d.uiStep !== "welcome" && wzIdx(d.uiStep) >= 0 ? d.uiStep : "hotel";
}
async function wzGo(screen, opts = {}) {
  if (screen === WZ.screen && !opts.force) return;
  await wzFlush();
  const from = WZ.screen;
  WZ.dir = wzIdx(screen) >= wzIdx(from) ? 1 : -1; WZ.screen = screen; WZ.fix = opts.fix || null;
  if (screen === "review" || screen === "team") { try { SU.data.readiness = await api("/api/setup/readiness"); } catch { /* keep the last numbers */ } }
  if (screen !== "welcome") suRun(() => api("/api/setup/ui-step", { method: "PUT", body: { step: screen } })).catch(() => {});
  paintWizard(true);
  if (!opts.fix) scrollTo(0, 0);
}
// "Fix" links: go to the screen, open "More details" if the field is in there, scroll to it and pulse it.
async function wzFix(screen, field) {
  if (!field) return wzGo(screen);
  const defs = SU.data.detailDefs.find((d) => d.key === field);
  if (defs && defs.more && defs.screen === screen) WZ.more.add(screen);
  if (screen === WZ.screen) paintWizard(false); else await wzGo(screen, { fix: field });
  setTimeout(() => {
    const el = [...document.querySelectorAll("[data-fk]")].find((e) => e.dataset.fk === field);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: RM.matches ? "auto" : "smooth" });
    el.classList.add("pulse"); setTimeout(() => el.classList.remove("pulse"), 1600);
    const inp = el.querySelector("input,textarea"); if (inp) inp.focus({ preventScroll: true });
  }, 120);
}

/* ---------- the shell: sticky step header, screen, sticky bottom bar ---------- */
function wzHead() {
  const i = wzIdx(WZ.screen), r = SU.data.readiness || { score: 0, essentialsDone: false };
  const dots = WZ_STEPS.map(([id, name], n) => `<li><button type="button" class="wzdot ${n < i ? "done" : ""}" data-go="${id}" ${n === i ? 'aria-current="step"' : ""} aria-label="${esc(name)}"><b>${n < i ? "" : n + 1}</b><span>${esc(name)}</span></button></li>`).join("");
  return `<div class="wzhead" id="wzHead">
    <div class="wzrow"><span class="wzstep">Step ${i + 1} of ${WZ_STEPS.length}</span><b class="wzname">${esc(WZ_STEPS[i][1])}</b>
      <span class="wzsaved" id="wzSave" aria-live="polite"></span>
      <button type="button" class="wzready press" id="wzReady" data-ok="${r.essentialsDone ? 1 : ""}" aria-label="Setup readiness. Go to review">${r.score}% ready</button></div>
    <div class="wzbar" role="progressbar" aria-valuemin="0" aria-valuemax="${WZ_STEPS.length}" aria-valuenow="${i + 1}" aria-label="Setup progress"><i id="wzFill"></i></div>
    <ol class="wzdots" aria-label="Setup steps">${dots}</ol></div>`;
}
function wzNav() {
  const i = wzIdx(WZ.screen), prev = WZ_STEPS[i - 1], next = WZ_STEPS[i + 1];
  const r = SU.data.readiness || {};
  const last = WZ.screen === "review";
  return `<div class="wznav"><div class="wznavin">
    <button type="button" class="wzback press" id="wzBack" ${i === 0 ? "disabled" : ""}>Back</button>
    ${last
      ? `<button type="button" class="bigbtn press" id="wzLive" ${r.essentialsDone ? "" : "disabled"}>${SU.busy ? "Going live…" : "Go live"}</button>`
      : `<button type="button" class="bigbtn press" id="wzNext"><span>Next</span><small>${esc(next[1])}</small></button>`}
  </div></div>`;
}
function paintWizard(animate) {
  const d = SU.data, s = WZ.screen;
  if (!d) return;
  document.documentElement.style.setProperty("--hdrh", ($("hdr").offsetHeight || 50) + "px");
  document.body.classList.toggle("wzon", s !== "welcome");
  if (s === "welcome") { $("suBody").innerHTML = `<div class="wz"><div id="wzScreen" class="wzscreen">${wzWelcome()}</div></div>`; wzBindWelcome(); if (animate) wzIn($("wzScreen")); return; }
  const body = { hotel: wzHotel, amenities: wzAmenities, policies: wzPolicies, rooms: wzRooms, systems: wzSystems, contacts: wzContacts, team: wzTeam, review: wzReview }[s]();
  const aiOn = d.aiOn;
  $("suBody").innerHTML = `<div class="wz">${wzHead()}<div id="wzScreen" class="wzscreen" data-screen="${s}">
    <div class="wzhd"><h2>${esc(WZ_STEPS[wzIdx(s)][1])}</h2><p>${esc(WZ_SUB[s])}</p>${aiOn && s !== "review" && s !== "team" ? `<button type="button" class="lnk" data-doc>Fill from a document</button>` : ""}</div>
    ${wzSugBanner(s)}${body}</div></div>${wzNav()}`;
  wzBind();
  // animated pieces: the screen slides in on a spring, the progress bar fills on a spring
  const pct = ((wzIdx(s) + 1) / WZ_STEPS.length) * 100, fill = $("wzFill");
  if (fill) { const sp = Spring(WZ.prevPct, (v) => (fill.style.width = v + "%")); sp.set(WZ.prevPct); sp.to(pct, { damping: 1, response: 0.5 }); }
  WZ.prevPct = pct;
  if (animate) wzIn($("wzScreen"));
  if (SU.focus) { const el = [...$("suBody").querySelectorAll("[data-f]")].find((e) => e.dataset.f === SU.focus); if (el) el.focus({ preventScroll: true }); SU.focus = null; }
  wzMark();
}
function wzIn(el) {
  if (!el || RM.matches) return;
  el.style.opacity = 0;
  Spring(0, (p) => { el.style.opacity = p; el.style.transform = `translateX(${(1 - p) * 26 * WZ.dir}px)`; }).to(1, { damping: 1, response: 0.4 }, () => { el.style.transform = ""; el.style.opacity = ""; });
}

function wzBind() {
  const root = $("suBody");
  root.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => wzGo(b.dataset.go)));
  const rd = $("wzReady"); if (rd) rd.onclick = () => wzGo("review");
  const nx = $("wzNext"); if (nx) nx.onclick = () => wzGo(WZ_STEPS[wzIdx(WZ.screen) + 1][0]);
  const bk = $("wzBack"); if (bk) bk.onclick = () => wzGo(WZ_STEPS[wzIdx(WZ.screen) - 1][0]);
  const lv = $("wzLive"); if (lv) lv.onclick = wzGoLive;
  root.querySelectorAll("[data-doc]").forEach((b) => (b.onclick = () => $("suFile").click()));
  wzBindFields(root);
  const s = WZ.screen;
  if (s === "contacts") wzBindContacts(root);
  if (s === "team") wzBindTeam(root);
  if (s === "review") wzBindReview(root);
  root.querySelectorAll("[data-more]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.more, open = !WZ.more.has(k); open ? WZ.more.add(k) : WZ.more.delete(k);
    b.setAttribute("aria-expanded", open); b.nextElementSibling.hidden = !open; b.querySelector(".chev").classList.toggle("dn", open);
  }));
  root.querySelectorAll("[data-yn]").forEach((b) => (b.onclick = () => wzSetAnswer(b.closest("[data-q]").dataset.q, b.dataset.yn === "yes")));
}

/* ---------- fields, badges and suggestions ---------- */
const wzSugs = (kind, key) => (SU.data.suggestions || []).filter((s) => s.kind === kind && (kind === "contact" ? s.role === key : s.key === key));
function wzSugHtml(s, label) {
  const val = s.kind === "answer" ? (s.value ? "Yes" : "No") : s.kind === "contact" ? `${esc(s.name)}${s.phone ? " · " + esc(s.phone) : ""}` : esc(s.value);
  return `<div class="wzsug" data-sug="${esc(s.id)}"><div class="sugtop"><span class="wzchip src">From ${esc(s.file)}</span><b class="sv">${val}</b></div>
    <div class="sugacts"><button type="button" class="pillbtn tint press" data-sug-act="accept">Accept</button><button type="button" class="pillbtn press" data-sug-act="edit">Edit</button><button type="button" class="pillbtn press" data-sug-act="dismiss">Dismiss</button></div></div>`;
}
function wzBadge(key) {
  const src = SU.data.prefilled[key]; if (!src) return "";
  const nm = SU.data.prefilledNames[src] || "another hotel";
  return `<div class="wzsame" data-same="${esc(key)}"><span class="wzchip same">Same as ${esc(nm)}</span><button type="button" class="lnk" data-confirm="${esc(key)}">Confirm</button></div>`;
}
function wzField(df) {
  const k = df.key, raw = SU.det[k], fill = wzFillPrompt(raw);
  const v = raw === undefined || fill !== null || raw === NOT_OFFERED ? "" : raw;
  const long = (df.hint || "").length > 30, ph = fill !== null ? fill : long ? "" : df.hint || "";
  const input = df.ml
    ? `<textarea data-k="${esc(k)}" rows="2" placeholder="${esc(ph)}" autocomplete="off">${esc(v)}</textarea>`
    : `<input data-k="${esc(k)}" value="${esc(v)}" placeholder="${esc(ph)}" autocomplete="off" autocapitalize="sentences" enterkeyhint="next">`;
  const sug = wzSugs("detail", k).map((s) => wzSugHtml(s)).join("");
  return `<div class="wzf" data-fk="${esc(k)}"><label class="fld"><span>${esc(WZ_LABEL[k] || k)}</span>${input}${long && fill === null ? `<em class="fh">${esc(df.hint)}</em>` : fill !== null ? `<em class="fh need">Needs your answer: ${esc(fill)}</em>` : ""}</label>${wzBadge(k)}${sug}</div>`;
}
function wzBindFields(root) {
  root.querySelectorAll("[data-k]").forEach((i) => {
    if (i.tagName === "TEXTAREA") { const g = () => { i.style.height = "auto"; i.style.height = i.scrollHeight + "px"; }; g(); i.addEventListener("input", g); }
    i.addEventListener("input", () => {
      wzQueue(i.dataset.k, i.value);
      const b = i.closest(".wzf").querySelector("[data-same]");
      if (b) { b.remove(); delete SU.data.prefilled[i.dataset.k]; } // typing makes it the GM's own
    });
    i.addEventListener("blur", () => wzFlush());
  });
  root.querySelectorAll("[data-confirm]").forEach((b) => (b.onclick = () => wzConfirm(b.dataset.confirm)));
  root.querySelectorAll("[data-sug] [data-sug-act]").forEach((b) => (b.onclick = () => wzSugAct(b.closest("[data-sug]").dataset.sug, b.dataset.sugAct)));
  root.querySelectorAll("[data-acceptall]").forEach((b) => (b.onclick = () => wzAcceptAll(b.dataset.acceptall)));
}
async function wzConfirm(key) {
  delete SU.data.prefilled[key]; wzSyncBadges();
  try { await wzTrack(suRun(() => api("/api/setup/flags", { method: "PUT", body: { confirm: [key] } }))); } catch (e) { fail(e); }
}
const wzSugScreen = (s) => (s.kind === "contact" ? "contacts" : s.kind === "answer" ? ANSWER_SCREEN_C[s.key] : (SU.data.detailDefs.find((d) => d.key === s.key) || {}).screen || "hotel");
const ANSWER_SCREEN_C = { breakfast: "amenities", pool: "amenities", pets: "amenities", laundry: "amenities", market: "amenities", cash: "policies", rollaways: "rooms", pack_and_plays: "rooms", connecting_rooms: "rooms" };
function wzSugBanner(screen) {
  const list = (SU.data.suggestions || []).filter((s) => wzSugScreen(s) === screen);
  if (!list.length) return "";
  const files = [...new Set(list.map((s) => s.file))].join(", ");
  return `<div class="wzbanner" role="status"><span class="wzbi">${wzSvg("M8 2.5c.4 3.4 2.6 5.6 6 6-3.4.4-5.6 2.6-6 6-.4-3.4-2.6-5.6-6-6 3.4-.4 5.6-2.6 6-6Z", "ai")}</span>
    <span class="body"><b>${plural(list.length, "suggestion")} from ${esc(files)}</b><small>Nothing is saved until you accept it.</small></span>
    <button type="button" class="pillbtn tint press" data-acceptall="${screen}">Accept all</button></div>`;
}
async function wzResolve(ids) {
  SU.data.suggestions = SU.data.suggestions.filter((s) => !ids.includes(s.id));
  try { await suRun(() => api("/api/setup/suggestions/resolve", { body: { ids } })); } catch { /* it stays in the list until the next load */ }
}
// Applies one suggestion to the form (and saves it). Contacts only fill the row; the row saves itself when it is complete.
async function wzApply(s) {
  if (s.kind === "detail") { SU.det[s.key] = s.value; WZ.pend[s.key] = s.value; }
  else if (s.kind === "answer") await wzSetAnswer(s.key, s.value, true);
  else if (s.kind === "contact") {
    wzRows(); let row = WZ.crows.find((r) => norm(r.role) === norm(s.role));
    if (!row) { row = { role: s.role, name: "", phone: "", custom: true }; WZ.crows.push(row); }
    row.name = s.name; if (s.phone) row.phone = s.phone; wzSaveRow(row);
  }
}
async function wzSugAct(id, act) {
  const s = SU.data.suggestions.find((x) => x.id === id); if (!s) return;
  if (act === "dismiss") { await wzResolve([id]); paintWizard(false); return; }
  if (act === "accept") { await wzApply(s); await wzFlush(); await wzResolve([id]); paintWizard(false); toast("Accepted"); return; }
  // Edit: put the suggestion in the field so it can be changed, then it saves like anything typed
  await wzResolve([id]);
  if (s.kind === "detail") { SU.det[s.key] = s.value; WZ.pend[s.key] = s.value; wzFlush(); paintWizard(false); setTimeout(() => { const i = [...document.querySelectorAll("[data-k]")].find((e) => e.dataset.k === s.key); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 30); }
  else if (s.kind === "contact") { wzRows(); let row = WZ.crows.find((r) => norm(r.role) === norm(s.role)); if (!row) { row = { role: s.role, name: "", phone: "", custom: true }; WZ.crows.push(row); } row.name = s.name; row.phone = s.phone || row.phone; paintWizard(false); const i = document.querySelector(`[data-crow="${CSS.escape(row.role)}"] input`); if (i) i.focus(); }
  else { paintWizard(false); const b = document.querySelector(`[data-q="${s.key}"] [data-yn]`); if (b) b.focus(); }
}
async function wzAcceptAll(screen) {
  const list = (SU.data.suggestions || []).filter((s) => wzSugScreen(s) === screen);
  if (!list.length) return;
  for (const s of list.filter((x) => x.kind === "answer")) await wzSetAnswer(s.key, s.value, true);
  for (const s of list.filter((x) => x.kind === "detail")) { SU.det[s.key] = s.value; WZ.pend[s.key] = s.value; }
  for (const s of list.filter((x) => x.kind === "contact")) await wzApply(s);
  await wzFlush(); await wzResolve(list.map((s) => s.id)); paintWizard(false);
  toast(`Accepted ${plural(list.length, "suggestion")}`);
}

/* ---------- yes/no questions ---------- */
function wzYn(k, q, extraAttrs = "") {
  const a = SU.ans[k];
  return `<span class="yn lg" role="radiogroup" aria-label="${esc(q)}" ${extraAttrs}><button type="button" role="radio" data-f="yn-${k}-yes" data-yn="yes" aria-checked="${a === true}">Yes</button><button type="button" role="radio" data-f="yn-${k}-no" data-yn="no" aria-checked="${a === false}">No</button></span>`;
}
async function wzSetAnswer(k, yes, quiet) {
  const prev = SU.ans[k];
  if (prev === yes) { if (SU.data.prefilled[k]) wzConfirm(k); return; }
  SU.ans[k] = yes; SU.focus = `yn-${k}-${yes ? "yes" : "no"}`;
  delete SU.data.prefilled[k];
  if (yes) SU.data.detailDefs.filter((x) => x.group === k).forEach((x) => { if (SU.det[x.key] === NOT_OFFERED) delete SU.det[x.key]; });
  if (!quiet) paintWizard(false);
  try {
    await wzFlush();
    const r = await wzTrack(suRun(() => api("/api/setup/answers", { method: "PUT", body: { answers: { [k]: yes } } })));
    SU.det = { ...r.details }; SU.ov = { on: new Set(r.selection.on), off: new Set(r.selection.off) }; SU.data.prefilled = r.prefilled || SU.data.prefilled;
    SU.data.answers = r.answers; SU.dirty = true;
    if (!quiet) { SU.focus = `yn-${k}-${yes ? "yes" : "no"}`; paintWizard(false); }
  } catch (e) { SU.ans[k] = prev; if (!quiet) paintWizard(false); fail(e); }
}
function wzQuestion(k, title, q, fields, opts = {}) {
  const sug = wzSugs("answer", k).map((s) => wzSugHtml(s)).join("");
  const answered = SU.ans[k] !== undefined;
  return `<div class="wzcard" data-q="${k}" data-fk="${opts.fk || "yn-" + k}">
    <div class="wzq">${opts.icon ? `<span class="wzico">${wzSvg(opts.icon)}</span>` : ""}<span class="body"><b>${esc(title)}</b><small>${esc(q)}</small></span>${wzYn(k, q)}</div>
    ${wzBadge(k)}${sug}
    ${opts.note ? `<p class="amennote">${opts.note}</p>` : ""}
    ${answered && fields.length ? `<div class="wzfields">${opts.intro ? `<p class="amennote">${opts.intro}</p>` : ""}${fields.map(wzField).join("")}</div>` : ""}</div>`;
}
const wzMoreBlock = (screen, defs) => {
  if (!defs.length) return "";
  const open = WZ.more.has(screen);
  let last = "";
  const rows = defs.map((d) => { const cap = d.sec !== last ? `<div class="wzsubsec">${esc(d.sec)}</div>` : ""; last = d.sec; return cap + wzField(d); }).join("");
  return `<button type="button" class="morebtn press" data-more="${screen}" aria-expanded="${open}"><span class="body"><span class="t">More details</span><span class="m">${plural(defs.length, "rarely needed detail")}. Skip them for now if you like.</span></span>${chev.replace('class="chev"', `class="chev ${open ? "dn" : ""}"`)}</button>
    <div class="wzmore" ${open ? "" : "hidden"}><div class="group wzgrp">${rows}</div></div>`;
};
// Sections of plain fields for one screen. Fields owned by a yes/no question or an amenity card are drawn there instead.
function wzSections(screen, skip = () => false) {
  const defs = SU.data.detailDefs.filter((d) => d.screen === screen && d.kind !== "amenity" && !(d.q && ["cash", "rollaways", "pack_and_plays", "connecting_rooms"].includes(d.q)) && !d.more && !skip(d));
  const order = [...new Set([...(SU.data.layout || []).filter((l) => l.screen === screen).map((l) => l.sec), ...defs.map((d) => d.sec)])];
  return order.map((sec) => [sec, defs.filter((d) => d.sec === sec)]).filter(([, l]) => l.length)
    .map(([sec, l]) => `<div class="sec"><span>${esc(sec)}</span></div><div class="group wzgrp">${l.map(wzField).join("")}</div>`).join("");
}
const wzMoreDefs = (screen) => SU.data.detailDefs.filter((d) => d.screen === screen && d.more && (d.kind !== "amenity" || SU.ans[d.group] === true));

/* ---------- screens ---------- */
function wzWelcome() {
  const d = SU.data, h = d.hotel, tp = d.templates || [];
  if (!WZ.tpl.from || !tp.find((t) => t.id === WZ.tpl.from)) WZ.tpl.from = (tp[0] || {}).id || null;
  const tname = (tp.find((t) => t.id === WZ.tpl.from) || {}).short || "Hampton";
  const need = [
    ["M6.5 3.5h3l1.2 3.2-1.8 1.2a9.5 9.5 0 0 0 4.2 4.2l1.2-1.8 3.2 1.2v3a2 2 0 0 1-2.2 2A13.5 13.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z", "Phone numbers", "for your GM, AGM, engineer and head housekeeper"],
    ["M3 9a14 14 0 0 1 18 0M6 12.5a9 9 0 0 1 12 0M9 16a4.5 4.5 0 0 1 6 0M12 19.5h.01", "Your Wi-Fi network name", "so staff can help guests connect"],
    ["M7 3h8l4 4v14H7zM14 3v5h5M10 12h6M10 16h6", "Your policies", "cash, quiet hours, visitors and fees"],
  ].map(([p, t, s]) => `<li>${wzSvg(p, "wzni")}<span><b>${t}</b> ${s}</span></li>`).join("");
  return `<div class="wzhero"><span class="wzchip brand">${esc(brandName(h))} · ${esc(sysName(h))}</span><h2>Let's get ${esc(h.name)} ready</h2>
    <p class="wzlede">About 10 minutes · saves as you go · come back anytime</p></div>
    <div class="sec"><span>What you'll need</span></div><ul class="group wzneed">${need}</ul>
    ${tp.length ? `<div class="group wzstd"><div class="rowline"><span>Start from Lotus standards<small>Fills in common policies from ${esc(tname)} (cash, quiet hours, fees). You confirm each one.</small></span>${sw(WZ.tpl.on, "Start from Lotus standards", 'id="wzTpl"')}</div>
      ${d.isOwner && tp.length > 1 && WZ.tpl.on ? `<label class="fld"><span>Use standards from</span><select id="wzTplFrom">${tp.map((t) => `<option value="${esc(t.id)}" ${t.id === WZ.tpl.from ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>` : ""}</div>` : ""}
    <button type="button" class="bigbtn press" id="wzStart">${WZ.busy === "start" ? "One moment…" : "Start"}</button>
    ${d.aiOn ? `<button type="button" class="bigbtn ghost press" id="wzDocs">${WZ.busy === "docs" ? "Reading your document…" : "Fill it from documents first"}</button>
      <p class="foot center">PDF, Word, Excel or text. We suggest answers; nothing is saved until you accept it.</p>`
      : `<p class="foot center">Reading documents needs an AI key. The Owner can add one in Settings, then you can fill this from your handbook.</p>`}
    <div class="wzalt"><button type="button" class="lnk" id="wzCopyToggle" aria-expanded="${WZ.copyOpen}">Copy another hotel instead</button>
    ${WZ.copyOpen ? `<div class="wzcopy">${d.sources.length ? `<div class="group" role="radiogroup" aria-label="Hotel to copy">${d.sources.map((s) => `<button type="button" class="radio" role="radio" data-src="${esc(s.id)}" aria-checked="${s.id === (WZ.copyFrom || d.sources[0].id)}"><span class="body" style="flex:1"><span class="rt">${esc(s.name)}</span><span class="rs">${s.system === "pep" ? "PEP" : "HotelKey"} · ${plural(s.live, "SOP")} on</span></span>${checkSvg}</button>`).join("")}</div>
      <button type="button" class="bigbtn ghost press" id="wzCopyGo">Copy and continue</button>` : `<div class="group"><div class="empty">No other hotel you manage is live yet, so there is nothing to copy.</div></div>`}</div>` : ""}
    <p class="foot center">Have your own binder? <button type="button" class="inlinebtn" id="wzImport">Turn it into SOPs</button></p></div>`;
}
function wzBindWelcome() {
  const root = $("suBody");
  const t = $("wzTpl"); if (t) t.onclick = () => { WZ.tpl.on = !WZ.tpl.on; paintWizard(false); };
  const f = $("wzTplFrom"); if (f) f.onchange = () => { WZ.tpl.from = f.value; paintWizard(false); };
  $("wzStart").onclick = () => wzBegin({ mode: "questions" });
  const dc = $("wzDocs"); if (dc) dc.onclick = () => $("suFile").click();
  $("wzCopyToggle").onclick = () => { WZ.copyOpen = !WZ.copyOpen; paintWizard(false); };
  root.querySelectorAll("[data-src]").forEach((b) => (b.onclick = () => { WZ.copyFrom = b.dataset.src; paintWizard(false); }));
  const cg = $("wzCopyGo"); if (cg) cg.onclick = () => wzBegin({ mode: "copy", from: WZ.copyFrom || SU.data.sources[0].id });
  $("wzImport").onclick = () => studioOpen({ target: STATE.hotel });
}
async function wzBegin(body) {
  if (WZ.busy) return;
  WZ.busy = "start"; paintWizard(false);
  try {
    const tpl = WZ.tpl.on ? (body.mode === "copy" ? body.from : WZ.tpl.from) : null;
    await api("/api/setup/start", { body: { ...body, template: tpl } });
    await refreshMe(); await suLoad();
    WZ.busy = ""; WZ.screen = "hotel"; WZ.dir = 1; setupHeader(); paintWizard(true); scrollTo(0, 0);
    if (body.mode === "copy") toast("Copied the SOP choices. Check each screen.");
    else if (SU.data.prefilled && Object.keys(SU.data.prefilled).length) toast(`Filled ${plural(Object.keys(SU.data.prefilled).filter((k) => !ANSWER_SCREEN_C[k]).length, "policy detail")} from Lotus standards`);
  } catch (e) { WZ.busy = ""; paintWizard(false); fail(e); }
}

function wzHotel() {
  const d = SU.data, h = d.hotel, owner = d.isOwner;
  const opts = (o, cur) => o.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${l}</option>`).join("");
  const rec = owner ? `<div class="sec"><span>Hotel record (Owner)</span></div><div class="group wzgrp"><div class="wzf"><label class="fld"><span>Hotel name in Ask Lotus</span><input id="su-name" value="${esc(h.name)}" autocomplete="off"></label></div>
      <div class="wzf"><label class="fld"><span>Brand</span><select id="su-brand">${opts([["hilton", "Hilton"], ["independent", "Independent"]], h.brand)}</select></label></div>
      <div class="wzf"><label class="fld"><span>Property system</span><select id="su-system">${opts([["pep", "PEP"], ["hotelkey", "HotelKey"]], h.system)}</select></label></div></div><p class="hint">As the Owner you can change these until the hotel goes live.</p>` : "";
  const more = wzMoreBlock("hotel", wzMoreDefs("hotel"));
  return `${wzSections("hotel")}${more}${rec}`;
}
function wzAmenities() {
  const d = SU.data, sops = d.sops;
  const cards = AMEN_LIST.map((k) => {
    const [name, q] = AMEN_Q[k], ms = sops.filter((m) => m.requires === k && suFits(m));
    const fields = d.detailDefs.filter((x) => x.group === k && !x.more);
    const note = SU.ans[k] !== undefined && ms.length ? `${SU.ans[k] ? "Turns on" : "Leaves off"}: ${esc(titleList(ms))}` : "";
    return wzQuestion(k, name, q, SU.ans[k] ? fields : [], { icon: WZ_AMEN_ICON[k], fk: "amen-" + k, note });
  }).join("");
  return `<div class="wzcards">${cards}</div>${wzMoreBlock("amenities", wzMoreDefs("amenities"))}`;
}
function wzPolicies() {
  const d = SU.data;
  const cashDefs = (d.qkeys.cash || []).map((key) => d.detailDefs.find((x) => x.key === key)).filter((x) => x && !x.more);
  const cash = wzQuestion("cash", "Cash", DQ_Q.cash[1], cashDefs, { fk: "yn-cash", intro: "Filled in for you. Change anything that isn't right." });
  return `<div class="wzcards">${cash}</div>${wzSections("policies")}${wzMoreBlock("policies", wzMoreDefs("policies"))}`;
}
function wzRooms() {
  const d = SU.data;
  const blocks = ["rollaways", "pack_and_plays", "connecting_rooms"].map((k) => {
    const defs = (d.qkeys[k] || []).map((key) => d.detailDefs.find((x) => x.key === key)).filter((x) => x && !x.more);
    return wzQuestion(k, DQ_Q[k][0], DQ_Q[k][1], defs, { fk: "yn-" + k, intro: "Filled in for you. Add the fee and where they are kept." });
  }).join("");
  const sections = wzSections("rooms", (x) => x.sec === "Rollaways, cribs and connecting rooms");
  return `<div class="wzcards">${blocks}</div>${sections}${wzMoreBlock("rooms", wzMoreDefs("rooms"))}`;
}
function wzSystems() {
  const h = SU.data.hotel;
  const pms = `<div class="sec"><span>Property management system</span></div><div class="group"><div class="cell"><span class="body"><span class="t">${h.system === "pep" ? "PEP (HotelKey NextGen)" : "HotelKey"}</span><span class="m">Set when the hotel was added. SOP wording follows this. Ask an Owner if it is wrong.</span></span><span class="status ok">Read only</span></div></div>`;
  return `${pms}${wzSections("systems")}${wzMoreBlock("systems", wzMoreDefs("systems"))}`;
}

/* contacts, routes and chats */
function wzRows() {
  if (WZ.crows) return WZ.crows;
  const have = SU.data.setupContacts || [];
  const rows = WZ_DEFAULT_ROLES.map((role) => { const c = have.find((x) => norm(x.role) === norm(role)); return { id: c && c.id, role, name: c ? c.name : "", phone: c ? c.phone : "" }; });
  for (const c of have) if (!rows.some((r) => norm(r.role) === norm(c.role))) rows.push({ id: c.id, role: c.role, name: c.name, phone: c.phone, custom: true });
  WZ.crows = rows; return rows;
}
function wzContacts() {
  const d = SU.data, ch = d.chats || {}, chd = d.chatDefaults || {}, rows = wzRows();
  const rowHtml = rows.map((r) => {
    const sug = wzSugs("contact", r.role).map((s) => wzSugHtml(s)).join("");
    return `<div class="wzcrow" data-crow="${esc(r.role)}" data-fk="contact-${esc(r.role)}"><div class="crl"><b>${esc(r.role)}</b>${WZ_ROLE_HELP[r.role] ? `<small>${esc(WZ_ROLE_HELP[r.role])}</small>` : ""}${r.custom ? `<button type="button" class="lnk red" data-cdel="${esc(r.role)}">Remove</button>` : ""}</div>
      <div class="crf"><label class="fld"><span>Name</span><input data-cn value="${esc(r.name)}" autocomplete="off" autocapitalize="words" placeholder="Full name"></label>
      <label class="fld"><span>Phone</span><input data-cp value="${esc(r.phone)}" inputmode="tel" autocomplete="off" placeholder="(913) 555-0123"></label></div>${sug}</div>`;
  }).join("");
  const routes = (d.routes || []).map((r) => `<div class="cell route"><span class="body"><span class="t">${esc(r.label)}</span><span class="m">${esc(r.sub)}</span></span>
    <span class="routesel"><label class="pick"><small>First call</small><select data-r="${esc(r.id)}" data-rk="first" aria-label="${esc(r.label)} first call">${wzRoleOpts(r.first)}</select></label><label class="pick"><small>${r.join === "and" ? "And" : "Then"}</small><select data-r="${esc(r.id)}" data-rk="then" aria-label="${esc(r.label)} second call">${wzRoleOpts(r.then, true)}</select></label></span></div>`).join("");
  return `<div class="sec"><span>Who staff call</span></div><div class="group wzcontacts" id="wzCList">${rowHtml}</div>
    <div class="wzadd" id="wzAddRole"><button type="button" class="pillbtn press" id="wzAddRoleBtn">Add a role</button></div>
    <p class="hint">Staff see these names and numbers when a question needs a manager. In an SOP, {AGM} or {Engineer} shows the person here. Only people with a name and a 10-digit phone are saved.</p>
    <div class="sec"><span>When staff need help</span></div><div class="group" id="wzRoutes">${routes}</div>
    <p class="hint">Pick who is called first and who is next. Anyone you add above shows up in these lists.</p>
    <div class="sec"><span>WhatsApp chats</span></div>
    <div class="group wzgrp" data-fk="chat-fd"><div class="wzf"><label class="fld"><span>Front desk chat name</span><input id="su-chatFd" value="${esc(ch.front_desk || "")}" placeholder="${esc(chd.front_desk || "")}" maxlength="40" autocomplete="off"></label></div>
      <div class="wzf"><label class="fld"><span>Housekeeping chat name</span><input id="su-chatHk" value="${esc(ch.housekeeping || "")}" placeholder="${esc(chd.housekeeping || "")}" maxlength="40" autocomplete="off"></label></div>
      <div class="wzf"><label class="fld"><span>Manager reply time in the chat (minutes)</span><input id="su-chatMins" type="number" inputmode="numeric" min="1" max="60" step="1" value="${esc(String(ch.responseMinutes || 5))}"></label></div></div>
    <div class="wzsame inline" id="wzChatOk" ${d.chatsConfirmed ? "hidden" : ""}><span class="wzchip same">Suggested names</span><button type="button" class="lnk" id="wzChatConfirm">These match WhatsApp</button></div>
    <p class="hint">When a manager's answer isn't urgent, Ask Lotus tells staff which chat to use and gives them a message to copy. Use the names your team sees in WhatsApp.</p>`;
}
function wzRoleOpts(sel, none) {
  const roles = (SU.data.setupContacts || []).map((c) => c.role);
  const has = roles.some((r) => norm(r) === norm(sel));
  return (none ? `<option value="">None</option>` : "") + (sel && !has ? `<option value="${esc(sel)}" selected>${esc(sel)} (not added yet)</option>` : "") + roles.map((r) => `<option ${norm(r) === norm(sel) ? "selected" : ""}>${esc(r)}</option>`).join("");
}
let wzRowTimers = {};
function wzSaveRow(row, now) {
  clearTimeout(wzRowTimers[row.role]);
  const go = () => {
    const name = row.name.trim(), phone = wzDigits(row.phone);
    if (!name || phone.length < 10) return Promise.resolve();
    const body = { role: row.role, name, phone: wzPhoneLive(row.phone) };
    row.chain = (row.chain || Promise.resolve()).then(async () => {
      try {
        if (row.id) await api(`/api/contacts/${row.id}`, { method: "PUT", body });
        else { const r = await api("/api/contacts", { body }); row.id = r.id; }
        const list = SU.data.setupContacts.filter((c) => c.id !== row.id); list.push({ id: row.id, role: row.role, name, phone: body.phone }); SU.data.setupContacts = list;
        wzRefreshRoutes();
      } catch (e) { fail(e); }
    });
    return wzTrack(row.chain);
  };
  if (now) return go();
  WZ.rowQ.add(row.role); wzMark();
  wzRowTimers[row.role] = setTimeout(() => { WZ.rowQ.delete(row.role); go(); wzMark(); }, 800);
}
function wzRefreshRoutes() {
  const box = $("wzRoutes"); if (!box) return;
  box.querySelectorAll("select[data-r]").forEach((s) => { const r = SU.data.routes.find((x) => x.id === s.dataset.r); s.innerHTML = wzRoleOpts(r[s.dataset.rk], s.dataset.rk === "then"); });
}
function wzBindContacts(root) {
  root.querySelectorAll("[data-crow]").forEach((el) => {
    const row = wzRows().find((r) => r.role === el.dataset.crow);
    const n = el.querySelector("[data-cn]"), p = el.querySelector("[data-cp]");
    n.oninput = () => { row.name = n.value; wzSaveRow(row); };
    p.oninput = () => { const f = wzPhoneLive(p.value); if (f !== p.value) p.value = f; row.phone = p.value; wzSaveRow(row); };
    p.onblur = n.onblur = async () => {
      if (row.id && !row.name.trim() && !wzDigits(row.phone)) { // both cleared: take the contact out
        try { await api(`/api/contacts/${row.id}`, { method: "DELETE" }); SU.data.setupContacts = SU.data.setupContacts.filter((c) => c.id !== row.id); row.id = undefined; wzRefreshRoutes(); }
        catch (e) { fail(e); row.name = SU.data.setupContacts.find((c) => c.id === row.id).name; paintWizard(false); }
      }
    };
  });
  root.querySelectorAll("[data-cdel]").forEach((b) => (b.onclick = async () => {
    const row = wzRows().find((r) => r.role === b.dataset.cdel);
    try { if (row.id) await api(`/api/contacts/${row.id}`, { method: "DELETE" }); SU.data.setupContacts = SU.data.setupContacts.filter((c) => c.id !== row.id); WZ.crows = WZ.crows.filter((r) => r !== row); paintWizard(false); wzRdySoon(); } catch (e) { fail(e); }
  }));
  $("wzAddRoleBtn").onclick = () => {
    $("wzAddRole").innerHTML = `<form class="wzaddform" id="wzRoleForm"><label class="fld"><span>Role</span><input id="wzRoleName" placeholder="Night Manager" autocomplete="off"></label><button type="submit" class="pillbtn tint press">Add</button></form>`;
    $("wzRoleName").focus();
    $("wzRoleForm").onsubmit = (e) => { e.preventDefault(); const r = $("wzRoleName").value.trim(); if (!r) return; if (wzRows().some((x) => norm(x.role) === norm(r))) return toast("That role is already here"); WZ.crows.push({ role: r, name: "", phone: "", custom: true }); paintWizard(false); };
  };
  root.querySelectorAll("select[data-r]").forEach((s) => (s.onchange = async () => {
    const r = SU.data.routes.find((x) => x.id === s.dataset.r), k = s.dataset.rk;
    try { await wzTrack(api(`/api/routes/${encodeURIComponent(r.id)}`, { method: "PUT", body: { field: k, value: s.value } })); r[k] = s.value; toast(`${r.label}: ${r.first}${r.then ? (r.join === "and" ? " and " : " then ") + r.then : ""}`); }
    catch (e) { fail(e); wzRefreshRoutes(); }
  }));
  for (const [id, k] of [["su-chatFd", "front_desk"], ["su-chatHk", "housekeeping"]]) {
    const inp = $(id);
    inp.onchange = () => wzTrack(suRun(() => api("/api/hotel/chats", { method: "PUT", body: { [k]: inp.value } }))).then((r) => { SU.data.chats = r.chats; SU.data.chatDefaults = r.chatDefaults; inp.value = r.chats[k]; SU.data.chatsConfirmed = true; $("wzChatOk").hidden = true; }).catch(fail);
  }
  const mins = $("su-chatMins");
  mins.onchange = () => wzTrack(suRun(() => api("/api/hotel/chats", { method: "PUT", body: { response_minutes: mins.value } }))).then((r) => { SU.data.chats = r.chats; mins.value = r.chats.responseMinutes; }).catch(fail);
  $("wzChatConfirm").onclick = async () => { try { await wzTrack(suRun(() => api("/api/setup/flags", { method: "PUT", body: { chats_confirmed: true } }))); SU.data.chatsConfirmed = true; $("wzChatOk").hidden = true; } catch (e) { fail(e); } };
}

/* team */
function wzUsername(name) {
  const parts = String(name || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return parts.length === 1 ? parts[0] : parts[0][0] + parts[parts.length - 1];
}
function wzKeepPw() { try { sessionStorage.setItem("asklotus.kit." + STATE.hotel, JSON.stringify(WZ.pw)); } catch { /* private mode: passwords stay in memory only */ } }
function wzLoadPw() { try { const j = JSON.parse(sessionStorage.getItem("asklotus.kit." + STATE.hotel) || "null"); if (j && typeof j === "object") WZ.pw = { ...j, ...WZ.pw }; } catch { /* none */ } }
function wzTeam() {
  const d = SU.data, nu = WZ.newUser, users = d.users || [];
  wzLoadPw();
  const list = users.map((u) => {
    const pw = WZ.pw[u.id];
    return `<div class="cell wzuser" data-uid="${u.id}">${avatar(u)}<span class="body"><span class="t">${esc(u.name)}${u.id === STATE.me.id ? " (you)" : ""}</span><span class="m">@${esc(u.username)} · ${esc(u.role)} · ${u.status === "off" ? "Off" : u.must_change_pw ? "Not signed in yet" : "Signed in"}</span>
      ${pw ? `<span class="pwline"><span>Temporary password</span><code>${esc(pw.pw)}</code><button type="button" class="pillbtn press" data-copypw="${u.id}">Copy</button></span>` : ""}</span></div>`;
  }).join("") || `<div class="empty">Nobody has been added to ${esc(d.hotel.name)} yet.</div>`;
  const later = d.staffLater;
  return `<div class="sec"><span>Add someone</span></div>
    <form class="group wzteamform" id="wzUserForm" data-fk="team-add" autocomplete="off">
      <label class="fld"><span>Name</span><input id="wzUName" value="${esc(nu.name)}" autocapitalize="words" placeholder="Maria Lopez" autocomplete="off"></label>
      <label class="fld"><span>Username</span><input id="wzUUser" value="${esc(nu.username)}" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="mlopez" autocomplete="off"><em class="fh">They sign in with this. We suggest one from the name.</em></label>
      <div class="wzrolepick"><span>Role</span><span class="yn lg" role="radiogroup" aria-label="Role"><button type="button" role="radio" data-urole="Front Desk" aria-checked="${nu.role === "Front Desk"}">Front Desk</button><button type="button" role="radio" data-urole="Manager" aria-checked="${nu.role === "Manager"}">Manager</button></span></div>
      <button type="submit" class="bigbtn press" id="wzUAdd">Add and get a temporary password</button></form>
    <p class="hint">Front Desk can chat. Managers can also edit SOPs and see activity. Each person sets their own password the first time they sign in.</p>
    <div class="sec"><span>${users.length} ${users.length === 1 ? "person" : "people"} at ${esc(d.hotel.name)}</span></div><div class="group" id="wzUsers">${list}</div>
    ${Object.keys(WZ.pw).length ? `<p class="hint">Temporary passwords are only kept in this browser tab and go on your Welcome kit at the end. They aren't saved anywhere else.</p>` : ""}
    <div class="group wzlater"><div class="rowline"><span>I'll add staff later<small>You can go live without a front desk login and add people from Team.</small></span>${sw(later, "I'll add staff later", 'id="wzLater"')}</div></div>`;
}
function wzBindTeam(root) {
  const nu = WZ.newUser, name = $("wzUName"), user = $("wzUUser");
  name.oninput = () => { nu.name = name.value; if (!nu.touched) { nu.username = wzUsername(nu.name); user.value = nu.username; } };
  user.oninput = () => { nu.username = user.value.toLowerCase(); nu.touched = !!user.value; };
  root.querySelectorAll("[data-urole]").forEach((b) => (b.onclick = () => { nu.role = b.dataset.urole; root.querySelectorAll("[data-urole]").forEach((x) => x.setAttribute("aria-checked", x === b)); }));
  $("wzLater").onclick = async () => {
    const on = $("wzLater").getAttribute("aria-checked") !== "true";
    $("wzLater").setAttribute("aria-checked", on); SU.data.staffLater = on;
    try { await wzTrack(suRun(() => api("/api/setup/flags", { method: "PUT", body: { staff_later: on } }))); } catch (e) { fail(e); }
  };
  root.querySelectorAll("[data-copypw]").forEach((b) => (b.onclick = async () => { const pw = WZ.pw[b.dataset.copypw]; try { await navigator.clipboard.writeText(pw.pw); toast("Copied"); } catch { toast("Select and copy it from the screen"); } }));
  $("wzUserForm").onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: nu.name.trim(), username: nu.username.trim().toLowerCase(), role: nu.role, hotels: [STATE.hotel] };
    if (!body.name) return toast("Add their name");
    if (!body.username) return toast("Add a username");
    const btn = $("wzUAdd"); btn.disabled = true;
    try {
      const r = await wzTrack(api("/api/users", { hotel: false, body }));
      WZ.pw[r.id] = { pw: r.tempPassword, name: body.name, username: body.username, role: body.role }; wzKeepPw();
      SU.data.users = [...(SU.data.users || []), { id: r.id, name: body.name, username: body.username, role: body.role, status: "active", must_change_pw: true }];
      Object.assign(WZ.newUser, { name: "", username: "", touched: false });
      paintWizard(false); toast(`${body.name} added`);
      const row = document.querySelector(`[data-uid="${r.id}"]`); if (row) row.scrollIntoView({ block: "center", behavior: RM.matches ? "auto" : "smooth" });
    } catch (x) {
      btn.disabled = false; fail(x);
      if (/taken/i.test(x.message)) { const m = body.username.match(/^(.*?)(\d*)$/); nu.username = m[1] + ((+m[2] || 1) + 1); user.value = nu.username; }
    }
  };
}

/* review and go live */
function wzItemRow(i) {
  return `<li class="wzitem ${i.done ? "ok" : ""}"><span class="wzchk">${i.done ? checkSvg : ""}</span><span class="body"><b>${esc(i.label)}</b>${!i.done && i.frac > 0 && i.frac < 1 ? `<small>${Math.round(i.frac * 100)}% done</small>` : ""}</span>${i.done ? "" : `<button type="button" class="pillbtn tint press" data-fix="${esc(i.screen)}" data-field="${esc(i.field || "")}">Fix</button>`}</li>`;
}
function wzReview() {
  const d = SU.data, r = d.readiness, on = d.sops.filter(suOn).length;
  return `<div id="wzRev">${wzReviewInner(r, on)}</div>
    <button type="button" class="morebtn press" id="wzSopsBtn" aria-expanded="${WZ.sopsOpen}"><span class="body"><span class="t">SOPs that will be on: ${on}</span><span class="m">of ${d.sops.length}. Tap to switch categories or single SOPs.</span></span>${chev.replace('class="chev"', `class="chev ${WZ.sopsOpen ? "dn" : ""}"`)}</button>
    <div class="wzmore" id="wzSops" ${WZ.sopsOpen ? "" : "hidden"}><div class="group" id="catList">${catRowsHtml()}</div><p class="foot">${d.hotel.brand === "hilton" ? "" : "Hilton-only SOPs stay off for independent hotels."}</p></div>
    <p class="hint">${esc(d.hotel.name)} opens to staff right away. You can switch SOPs, details and contacts any time from the Dashboard.</p>`;
}
function wzReviewInner(r, on) {
  const ess = r.items.filter((i) => i.essential), rec = r.items.filter((i) => !i.essential);
  const left = ess.filter((i) => !i.done).length;
  return `<div class="wzscore"><div class="ring" style="--p:${r.score}"><b>${r.score}%</b><small>ready</small></div>
    <div class="body"><b>${r.essentialsDone ? "You can go live" : left === 1 ? "One thing before you go live" : `${left} things before you go live`}</b><small>${r.essentialsDone ? "The essentials are done. The rest can wait, but each one makes answers better." : "Fix these and the Go live button turns on."}</small></div></div>
    <div class="sec"><span>Needed to go live</span><span>${ess.filter((i) => i.done).length} of ${ess.length}</span></div><ul class="group wzlist">${ess.map(wzItemRow).join("")}</ul>
    <div class="sec"><span>Recommended</span><span>${rec.filter((i) => i.done).length} of ${rec.length}</span></div><ul class="group wzlist">${rec.map(wzItemRow).join("")}</ul>`;
}
function wzPaintReview() { const el = $("wzRev"); if (!el) return; el.innerHTML = wzReviewInner(SU.data.readiness, SU.data.sops.filter(suOn).length); bindFix(el); const lv = $("wzLive"); if (lv) lv.disabled = !SU.data.readiness.essentialsDone; }
function bindFix(root) { root.querySelectorAll("[data-fix]").forEach((b) => (b.onclick = () => wzFix(b.dataset.fix, b.dataset.field))); }
function wzBindReview(root) {
  bindFix(root); bindCatRows(root);
  $("wzSopsBtn").onclick = () => { WZ.sopsOpen = !WZ.sopsOpen; $("wzSopsBtn").setAttribute("aria-expanded", WZ.sopsOpen); $("wzSops").hidden = !WZ.sopsOpen; $("wzSopsBtn").querySelector(".chev").classList.toggle("dn", WZ.sopsOpen); };
}
async function wzGoLive() {
  if (SU.busy) return;
  SU.busy = true; paintWizard(false);
  try {
    await wzFlush(); await SU.saveP;
    const r = await api("/api/setup/go-live", { body: {} });
    await refreshMe(); await loadHotel();
    WZ.celebrate = true; WZ.kitUsers = null; wzLoadPw();
    SU.data = null; SU.step = 0; SU.busy = false; tab = "dashboard"; SU.backTab = "dashboard";
    WZ.liveCount = r.on;
    go("kit");
  } catch (e) { SU.busy = false; paintWizard(false); fail(e); try { SU.data.readiness = await api("/api/setup/readiness"); paintWizard(false); } catch { /* keep */ } }
}

/* ---------- reading a document ---------- */
async function wzExtract(fileList) {
  const files = [...fileList].slice(0, 3); if (!files.length) return;
  const fromWelcome = WZ.screen === "welcome";
  WZ.busy = "docs"; if (fromWelcome) paintWizard(false); else toast("Reading your document…");
  try {
    const payload = [];
    for (const f of files) payload.push({ name: f.name, data: await readDataUrl(f) });
    const r = await api("/api/setup/extract", { body: { files: payload } });
    SU.data.suggestions = r.suggestions;
    if (!r.found) { WZ.busy = ""; paintWizard(false); return toast("We didn't find anything to suggest in that file."); }
    if (fromWelcome) { WZ.busy = ""; await wzBegin({ mode: "questions" }); SU.data.suggestions = r.suggestions; paintWizard(false); }
    WZ.busy = ""; if (!fromWelcome) paintWizard(false);
    toast(`${plural(r.found, "suggestion")} to review`);
  } catch (e) { WZ.busy = ""; paintWizard(false); fail(e); }
}

/* ---------- Welcome kit ---------- */
function wzQr(text) {
  try {
    const q = qrcode(0, "M"); q.addData(text); q.make();
    const n = q.getModuleCount(); let p = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) p += `M${c} ${r}h1v1h-1z`;
    return `<svg class="qr" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges" role="img" aria-label="QR code for ${esc(text)}"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${p}" fill="#000"/></svg>`;
  } catch { return `<div class="qrfail">QR code unavailable. Use the web address.</div>`; }
}
async function renderKit() {
  const box = $("suBody"), h = hotelObj(), url = location.origin;
  $("setupTitle").textContent = "Welcome kit"; $("setupSub").textContent = `${h.name || ""} · print it, tape it by the desk`;
  box.innerHTML = `<div class="wz"><div class="group"><div class="empty">Loading…</div></div></div>`;
  wzLoadPw();
  let users = [];
  try { users = (await api("/api/users", { hotel: false })).filter((u) => u.hotels.includes(STATE.hotel) && u.role !== "Owner"); } catch (e) { fail(e); }
  WZ.kitUsers = users;
  const live = WZ.celebrate;
  const hero = live ? `<div class="wzhero live"><span class="wzbadge" id="wzBadge">${checkSvg}</span><h2>${esc(h.name)} is live</h2><p class="wzlede">${WZ.liveCount ? plural(WZ.liveCount, "SOP") + " are on. " : ""}Your team can sign in now. Here's your Welcome kit.</p></div>` : "";
  const rows = users.map((u) => {
    const pw = WZ.pw[u.id];
    return `<tr data-uid="${u.id}"><td><b>${esc(u.name)}</b><small>${esc(u.role)}</small></td><td><code>${esc(u.username)}</code></td><td class="pwc">${pw ? `<code>${esc(pw.pw)}</code>` : `<span class="noprint dim">Already set</span>${u.id === STATE.me.id ? "" : `<button type="button" class="pillbtn noprint press" data-reset="${u.id}">Reset password</button>`}`}</td></tr>`;
  }).join("") || `<tr><td colspan="3" class="dim">No staff added yet. Add people from Team.</td></tr>`;
  const anyPw = users.some((u) => WZ.pw[u.id]);
  box.innerHTML = `<div class="wz kit">${hero}
    <div class="kitactions noprint"><button type="button" class="bigbtn press" id="kitPrintDesk">Print desk card</button><button type="button" class="bigbtn ghost press" id="kitPrintTeam">Print team sheet</button></div>
    <section class="kit-desk" aria-label="Desk card"><div class="kd-brand">Ask Lotus</div><h3>${esc(h.name)}</h3><p class="kd-lede">Questions about a procedure? Ask here, any time.</p>
      <div class="kd-qr">${wzQr(url)}</div><p class="kd-scan">Scan with your phone's camera</p><p class="kd-url">${esc(url)}</p></section>
    <section class="kit-a2hs" aria-label="Add to Home Screen"><h3>Put it on your phone's Home Screen</h3>
      <div class="kd-cols"><div><h4>iPhone</h4><ol><li>Open <b>${esc(url)}</b> in Safari.</li><li>Tap the <b>Share</b> button (the square with an arrow).</li><li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>. Ask Lotus is now an icon on your phone.</li></ol></div>
      <div><h4>Android</h4><ol><li>Open <b>${esc(url)}</b> in Chrome.</li><li>Tap the <b>three dots</b> at the top right.</li><li>Tap <b>Add to Home screen</b> (or <b>Install app</b>).</li><li>Tap <b>Add</b>. Ask Lotus is now an icon on your phone.</li></ol></div></div></section>
    <section class="kit-team" aria-label="Staff"><h3>Your team</h3>
      ${anyPw ? `<div class="banner noprint"><b>Heads up</b><span>The temporary passwords below are shown only now, in this browser tab. Print them or copy them before you leave this page. Each person sets their own password when they first sign in.</span></div><p class="printonly warn">Keep this sheet private. Temporary passwords work once; each person sets their own at first sign-in.</p>` : ""}
      <table class="kt"><thead><tr><th>Name</th><th>Username</th><th>Temporary password</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="foot noprint">Sign in at <b>${esc(url)}</b>. "Reset password" makes a new temporary password for that person.</p></section>
    <button type="button" class="bigbtn press noprint" id="kitDone">${live ? "Go to the Dashboard" : "Back to the Dashboard"}</button></div>`;
  if (live && !RM.matches) { const b = $("wzBadge"); b.style.transform = "scale(.4)"; b.style.opacity = 0; Spring(0, (p) => { b.style.opacity = Math.min(1, p * 1.6); b.style.transform = `scale(${0.4 + 0.6 * p})`; }).to(1, { damping: 0.55, response: 0.7 }); }
  $("kitPrintDesk").onclick = () => wzPrint("desk");
  $("kitPrintTeam").onclick = () => wzPrint("team");
  $("kitDone").onclick = () => { WZ.celebrate = false; WZ.pw = {}; try { sessionStorage.removeItem("asklotus.kit." + STATE.hotel); } catch { /* ok */ } tab = "dashboard"; go("admin"); };
  box.querySelectorAll("[data-reset]").forEach((b) => (b.onclick = async () => {
    try { const r = await api(`/api/users/${b.dataset.reset}/reset`, { hotel: false, body: {} }); const u = users.find((x) => String(x.id) === b.dataset.reset); WZ.pw[u.id] = { pw: r.tempPassword, name: u.name, username: u.username, role: u.role }; wzKeepPw(); toast(`New password for ${u.name}`); renderKit(); } catch (e) { fail(e); }
  }));
}
function wzPrint(what) {
  document.body.dataset.print = what;
  const clear = () => { delete document.body.dataset.print; removeEventListener("afterprint", clear); };
  addEventListener("afterprint", clear);
  setTimeout(() => print(), 60);
}

/* ---------- Owner: progress on hotels that are not live ---------- */
function ownerProgressHtml(h) {
  const p = (STATE.owner.prog || {})[h.id];
  if (h.setup === "live") return "";
  if (!p) return `<div class="oprog"><div class="orow"><b>Setup</b><span class="ostep">Checking…</span></div><div class="obar"><i style="width:0"></i></div></div>`;
  const left = p.missing.map((m) => wzLower(m.label));
  const todo = left.length ? `Still to do: ${esc(left.slice(0, 3).join("; "))}${left.length > 3 ? ` and ${left.length - 3} more` : ""}` : "Everything needed is in. Ready to go live.";
  const act = h.setup === "new" ? "Not started" : p.lastActivity ? `Last activity ${wzAgo(p.lastActivity)}` : "No activity yet";
  return `<div class="oprog"><div class="orow"><b>Setup</b><b>${p.score}%</b></div>
    <div class="obar" role="progressbar" aria-valuenow="${p.score}" aria-valuemin="0" aria-valuemax="100" aria-label="Setup ${p.score}% ready"><i style="width:${p.score}%"></i></div>
    <p class="omiss${left.length ? "" : " ok"}">${todo}</p><small class="dim">${act}${p.stepName && h.setup !== "new" ? " · step: " + esc(p.stepName) : ""}</small></div>`;
}
async function loadOwnerProgress() {
  STATE.owner.prog = STATE.owner.prog || {};
  const todo = (STATE.owner.hotels || []).filter((h) => h.setup !== "live");
  await Promise.all(todo.map(async (h) => {
    try { STATE.owner.prog[h.id] = await api(`/api/setup/readiness?hotel=${encodeURIComponent(h.id)}`, { hotel: false }); } catch { /* the card shows "Checking" */ }
  }));
  todo.forEach((h) => { const slot = document.querySelector(`[data-prog="${CSS.escape(h.id)}"]`); if (slot) { slot.innerHTML = ownerProgressHtml(h); wzBindCopy(slot.closest(".pcard")); } });
}
function reminderText(h) {
  const p = (STATE.owner.prog || {})[h.id] || { score: 0, missing: [] };
  const gm = h.gms.filter((g) => g.status === "active")[0];
  const next = p.missing.slice(0, 2).map((m) => wzLower(m.label)).join(" and ") || "review and go live";
  return `Hi ${wzFirst(gm && gm.name) || "there"}, Ask Lotus setup for ${h.name} is ${p.score}% done. Next: ${next}. Log in at ${location.origin}`;
}
function wzBindCopy(card) {
  if (!card) return;
  const b = card.querySelector("[data-remind]"); if (!b) return;
  b.onclick = async () => {
    const h = STATE.owner.hotels.find((x) => x.id === b.dataset.remind), text = reminderText(h);
    try { await navigator.clipboard.writeText(text); toast("Reminder copied. Paste it into WhatsApp."); }
    catch { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); toast("Reminder copied. Paste it into WhatsApp."); } catch { toast(text); } t.remove(); }
  };
}

function suInit() {
  const f = $("suFile");
  f.onchange = () => { const files = f.files; if (files && files.length) wzExtract(files); f.value = ""; };
}
