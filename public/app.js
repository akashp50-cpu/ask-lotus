"use strict";
/* Ask Lotus client. Talks to the API in src/server.js. */

/* ---------- spring engine (damping ratio + response) ---------- */
const RM = matchMedia("(prefers-reduced-motion: reduce)");
function Spring(value, onUpdate) {
  const s = { value, velocity: 0, target: value, raf: 0, damping: 1, response: 0.4, onDone: null };
  s.to = (target, { damping = 1, response = 0.4, velocity } = {}, onDone) => {
    s.target = target; s.damping = damping; s.response = response; s.onDone = onDone || null;
    if (velocity !== undefined) s.velocity = velocity;
    if (RM.matches) { cancelAnimationFrame(s.raf); s.raf = 0; s.value = target; s.velocity = 0; onUpdate(target); onDone && onDone(); return; }
    if (!s.raf) {
      let last = performance.now();
      const step = (t) => {
        const dt = Math.min((t - last) / 1000, 1 / 30); last = t;
        const k = Math.pow((2 * Math.PI) / s.response, 2), c = (4 * Math.PI * s.damping) / s.response, h = dt / 4;
        for (let i = 0; i < 4; i++) { const a = -k * (s.value - s.target) - c * s.velocity; s.velocity += a * h; s.value += s.velocity * h; }
        onUpdate(s.value);
        if (Math.abs(s.velocity) < 0.5 && Math.abs(s.value - s.target) < 0.3) {
          s.value = s.target; s.velocity = 0; onUpdate(s.value); s.raf = 0; const d = s.onDone; s.onDone = null; d && d(); return;
        }
        s.raf = requestAnimationFrame(step);
      };
      s.raf = requestAnimationFrame(step);
    }
  };
  s.set = (v) => { cancelAnimationFrame(s.raf); s.raf = 0; s.value = v; s.velocity = 0; onUpdate(v); };
  return s;
}
const project = (v, d = 0.998) => ((v / 1000) * d) / (1 - d);
const rubber = (o, dim, c = 0.55) => (o * dim * c) / (dim + c * Math.abs(o));
document.addEventListener("pointerdown", (e) => { const b = e.target.closest(".press,.chip,.cell,.pillbtn,.radio"); if (b && !b.disabled) b.classList.add("down"); });
["pointerup", "pointercancel"].forEach((ev) => document.addEventListener(ev, () => document.querySelectorAll(".down").forEach((b) => b.classList.remove("down")), true));

/* ---------- utils ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const fmtD = (d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fmtDT = (d) => {
  const x = new Date(d), now = new Date(), t = x.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const day = (a) => new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const diff = (day(now) - day(x)) / 864e5;
  return diff === 0 ? "Today " + t : diff === 1 ? "Yesterday " + t : fmtD(d) + ", " + t;
};
const COLORS = ["var(--accent)", "#5856D6", "#C2410C", "#0A6CBF", "#B4237A", "#6D7A12", "#7C3AED"];
const initials = (n) => String(n || "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
const color = (id) => COLORS[(parseInt(String(id).replace(/\D/g, ""), 10) || 0) % COLORS.length];
const avatar = (u, size = 32) => `<span class="av" style="background:${color(u.id)};width:${size}px;height:${size}px">${esc(initials(u.name))}</span>`;
const chev = `<svg class="chev" viewBox="0 0 8 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 1.5 6.5 6.5 1.5 11.5"/></svg>`;
const checkSvg = `<svg class="check" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 9.5 7 13l7.5-8"/></svg>`;

async function api(path, opts = {}) {
  const url = path + (opts.hotel !== false && STATE.hotel ? (path.includes("?") ? "&" : "?") + "hotel=" + encodeURIComponent(STATE.hotel) : "");
  const r = await fetch(url, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: opts.body ? { "content-type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (r.status === 401 && !opts.quiet401) { STATE.me = null; showScreen(); }
  if (!r.ok) throw new Error((data && data.error) || "Something went wrong. Try again.");
  return data;
}

/* ---------- state ---------- */
const STATE = { me: null, hotels: [], hotel: null, convos: [], cats: [], sops: [], contacts: [], routes: [], details: {}, chats: {}, chatDefaults: {}, info: {}, settings: {}, log: [], users: [], owner: { hotels: null, master: null }, home: null };
const sop = (id) => STATE.sops.find((s) => s.id === id);
const RANKS = { "Front Desk": 0, Manager: 1, GM: 2, Owner: 3 };
const canManage = () => STATE.me && RANKS[STATE.me.role] >= 1;
const isGM = () => STATE.me && RANKS[STATE.me.role] >= 2; // GM or Owner
const isOwner = () => STATE.me && STATE.me.role === "Owner";
const GRANTS = { Owner: ["Front Desk", "Manager", "GM", "Owner"], GM: ["Front Desk", "Manager", "GM"], Manager: ["Front Desk", "Manager"] };
const canGrant = (role) => !!STATE.me && (GRANTS[STATE.me.role] || []).includes(role);
const ROLE_TITLE = { Owner: "Owner", GM: "General Manager", Manager: "Manager" };
const hotelObj = (id) => STATE.hotels.find((h) => h.id === (id || STATE.hotel)) || {};
const hotelName = (id) => (STATE.hotels.find((h) => h.id === id) || {}).name || id;
const sysName = (h) => (h.system === "pep" ? "PEP" : "HotelKey");
const brandName = (h) => (h.brand === "hilton" ? "Hilton" : "Independent");

/* ---------- toast ---------- */
let toastS, toastH;
function toast(t) {
  $("toastT").textContent = t; const b = $("toast"); b.hidden = false;
  toastS = toastS || Spring(0, (v) => { b.style.opacity = v; b.style.transform = `translateX(-50%) scale(${0.9 + 0.1 * v})`; b.style.filter = `blur(${(1 - v) * 6}px)`; });
  toastS.to(1, { damping: 0.85, response: 0.35 }); clearTimeout(toastH);
  toastH = setTimeout(() => toastS.to(0, { damping: 1, response: 0.3 }, () => (b.hidden = true)), 2600);
}
const fail = (e) => toast(e.message || String(e));

/* ---------- segmented control ---------- */
function Seg(root, onPick) {
  const thumb = root.querySelector(".thumb"), btns = [...root.querySelectorAll("button")];
  const sp = Spring(0, (x) => (thumb.style.transform = `translateX(${x}px)`));
  const place = (v, anim) => { const b = btns.find((b) => b.dataset.v === v); if (!root.offsetParent) return; thumb.style.opacity = b ? 1 : 0; btns.forEach((x) => x.setAttribute("aria-selected", x === b)); if (!b) return; anim ? sp.to(b.offsetLeft - 2, { damping: 1, response: 0.3 }) : sp.set(b.offsetLeft - 2); };
  btns.forEach((b) => b.addEventListener("click", () => onPick(b.dataset.v)));
  addEventListener("resize", () => place(root._v, false));
  return (v, anim = true) => { root._v = v; place(v, anim); };
}

/* ---------- menus ---------- */
const menus = [];
function Menu(btn, menu) {
  const sp = Spring(0, (v) => { menu.style.opacity = v; menu.style.transform = `scale(${0.85 + 0.15 * v})`; });
  const set = (o) => {
    btn.setAttribute("aria-expanded", o);
    if (o) { const r = btn.getBoundingClientRect(); menu.style.top = r.bottom + 6 + "px"; menu.style.right = Math.max(12, innerWidth - r.right) + "px"; menu.hidden = false; sp.to(1, { damping: 0.86, response: 0.32 }); }
    else if (!menu.hidden) sp.to(0, { damping: 1, response: 0.22 }, () => (menu.hidden = true));
  };
  btn.addEventListener("click", (e) => { e.stopPropagation(); closeMenus(menu); set(menu.hidden); });
  menu._close = () => set(false); menus.push(menu);
}
function closeMenus(except) { menus.forEach((m) => m !== except && m._close()); }
document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) closeMenus(); });
Menu($("propBtn"), $("propMenu"));
$("propBtn").addEventListener("click", (e) => { if ($("propBtn").classList.contains("single")) { e.stopImmediatePropagation(); closeMenus(); } }, true);
Menu($("avBtn"), $("acctMenu"));

/* ---------- screens ---------- */
function showScreen() {
  const u = STATE.me;
  $("login").hidden = !!u;
  $("pwScreen").hidden = !(u && u.must_change_pw);
  $("app").hidden = !(u && !u.must_change_pw);
  if (!u) { setTimeout(() => $("lg-user").focus(), 50); }
}

async function start() {
  try {
    const me = await api("/api/me", { hotel: false, quiet401: true });
    STATE.me = me.user; STATE.hotels = me.hotels;
  } catch { STATE.me = null; }
  if (!STATE.me) window.applyAccent(null); // the sign-in screen is always Lotus gold
  showScreen();
  if (STATE.me && !STATE.me.must_change_pw) await enterApp();
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("lg-err"); err.hidden = true;
  try {
    await api("/api/login", { hotel: false, quiet401: true, body: { username: $("lg-user").value, password: $("lg-pass").value } });
    $("lg-pass").value = "";
    await start();
  } catch (x) { err.textContent = x.message; err.hidden = false; }
});

$("pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("pw-err"); err.hidden = true;
  const n = $("pw-new").value;
  if (n !== $("pw-new2").value) { err.textContent = "The new passwords don't match."; err.hidden = false; return; }
  try {
    await api("/api/password", { hotel: false, body: { current: $("pw-cur").value, next: n } });
    ["pw-cur", "pw-new", "pw-new2"].forEach((id) => ($(id).value = ""));
    toast("Password saved");
    await start();
  } catch (x) { err.textContent = x.message; err.hidden = false; }
});
async function signOut() { try { await api("/api/logout", { hotel: false, body: {} }); } catch {} STATE.me = null; newChat(true); closeMenus(); window.applyAccent(null); document.body.classList.remove("shell"); history.replaceState(null, "", location.pathname); showScreen(); }
$("pwCancel").onclick = signOut;
$("signOut").onclick = signOut;
$("setOut").onclick = signOut;
$("changePw").onclick = () => { closeMenus(); STATE.me.must_change_pw = true; showScreen(); $("pw-cur").focus(); };
$("setPw").onclick = () => $("changePw").onclick();
$("dashChat").onclick = () => go("chat");
$("dashNew").onclick = () => $("newSop").click();

/* ---------- app shell ---------- */
let mode = null;
const modeSeg = Seg($("modeSeg"), (v) => (location.hash = v));

async function enterApp() {
  const u = STATE.me;
  const mine = STATE.hotels.filter((h) => u.hotels.includes(h.id));
  const saved = (() => { try { return localStorage.getItem("asklotus.hotel"); } catch { return null; } })();
  STATE.hotel = (mine.find((h) => h.id === saved && h.ready) || mine.find((h) => h.ready) || mine[0] || {}).id;
  if (!STATE.hotel) { toast("You aren't assigned to a hotel yet. Ask your manager."); return; }
  renderPropMenu();
  $("avBtn").style.background = color(u.id); $("avBtn").textContent = initials(u.name);
  $("acctWho").innerHTML = `${avatar(u, 36)}<span><b>${esc(u.name)}</b><small>${esc(u.role)} · @${esc(u.username)}</small></span>`;
  $("hello").textContent = `Hi ${u.name.split(" ")[0]}, how can I help?`;
  // Managers get the sidebar / tab bar (dash.js) instead of the Front Desk | Manager switch and the gear buttons.
  $("modeSeg").hidden = true; $("appTitle").hidden = false;
  $("gearBtn").hidden = true; $("ownerBtn").hidden = true;
  tab = canManage() ? "dashboard" : "sops"; STATE.home = null;
  await loadHotel();
  if (!canManage() && location.hash === "#admin") location.hash = "chat";
  if (!isOwner() && location.hash === "#owner") location.hash = "chat";
  // Owner, GM and Manager land on the Dashboard; Front Desk lands on chat.
  if (canManage() && !location.hash && hotelObj().ready) history.replaceState(null, "", "#admin");
  mode = null; route();
}

// Switches to a screen by hash; runs the router directly when the hash is already there.
const go = (h) => (location.hash === "#" + h ? route() : (location.hash = h));

async function refreshMe() {
  const me = await api("/api/me", { hotel: false });
  STATE.me = me.user; STATE.hotels = me.hotels; renderPropMenu();
}

function renderPropMenu() {
  const mine = STATE.hotels.filter((h) => STATE.me.hotels.includes(h.id));
  $("propBtn").classList.toggle("single", mine.length < 2); $("propBtn").setAttribute("aria-haspopup", mine.length < 2 ? "false" : "menu");
  $("propBtn").querySelector(".lbl").textContent = hotelName(STATE.hotel).replace("Hampton Inn Overland Park", "Hampton OP");
  // Hotels that aren't live can't be chatted with. Owners and GMs can open them to set them up.
  $("propMenu").innerHTML = mine.map((h) => {
    const dis = !h.ready && !isGM();
    const sub = h.id === STATE.hotel ? "" : h.ready ? "" : `<small>${isGM() ? "Set up" : "Not set up"}</small>`;
    return `<button class="mi" role="menuitemradio" data-h="${esc(h.id)}" aria-checked="${h.id === STATE.hotel}" ${dis ? "disabled" : ""}>${esc(h.name)} ${h.id === STATE.hotel ? `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--tint)" stroke-width="2" stroke-linecap="round"><path d="M2.5 7.5 5.5 10.5 11.5 3.5"/></svg>` : sub}</button>`;
  }).join("");
  $("propMenu").querySelectorAll("[data-h]:not([disabled])").forEach((b) => (b.onclick = async () => {
    closeMenus(); if (b.dataset.h === STATE.hotel) return;
    await selectHotel(b.dataset.h, mode === "admin" ? "admin" : mode === "owner" ? "owner" : "chat");
  }));
}

async function selectHotel(id, target) {
  STATE.hotel = id; STATE.home = null;
  if (hotelObj(id).ready) { try { localStorage.setItem("asklotus.hotel", id); } catch {} }
  newChat(true); renderPropMenu();
  try { await loadHotel(); } catch (e) { fail(e); }
  if (mode === "admin") renderAdmin();
  // A hotel that isn't live goes to its setup page, whatever screen we came from.
  go(hotelObj(id).ready ? target : "chat");
}

async function loadHotel() {
  const d = await api("/api/bootstrap");
  Object.assign(STATE, { cats: d.cats, sops: d.sops, contacts: d.contacts, routes: d.routes, settings: d.settings, details: d.details || {}, chats: d.chats || {}, chatDefaults: d.chatDefaults || {}, info: d.info || {} });
  const ho = STATE.hotels.find((h) => h.id === STATE.hotel);
  if (ho && d.info) ho.accent = d.info.accent || null;
  Glass.applyHotelAccent();
  const live = hotelObj().ready;
  $("helloSub").textContent = live ? `Answers from ${hotelName(STATE.hotel)} procedures.` : `${hotelName(STATE.hotel)} isn't open to staff yet. Ask your manager.`;
  $("askInput").disabled = !live;
  $("aiPill").hidden = !STATE.settings.aiOn;
  $("askInput").placeholder = !live ? "Not open yet" : STATE.settings.aiOn ? "Ask anything" : "Ask about a procedure";
  $("adminHotel").textContent = hotelName(STATE.hotel);
  renderCatPills();
  setupHeader();
  restoreConvo();
}

const MODE_ORDER = ["chat", "admin", "owner", "import", "setup"];
function route() {
  if (!STATE.me || STATE.me.must_change_pw) return;
  let v = "chat";
  const ready = hotelObj().ready, hash = location.hash;
  if (hash === "#owner" && isOwner()) v = "owner";
  else if (hash === "#import" && isOwner()) { ownerTab = "import"; v = "owner"; } // the Owner's Import lives under the Owner tabs
  else if (hash === "#import" && isGM()) v = "import";
  else if (isGM() && !ready && hash !== "#admin") v = "setup"; // a hotel that isn't live opens its setup
  else if (isGM() && ready && (hash === "#manage" || hash === "#details" || hash === "#kit")) v = "setup";
  else if (hash === "#admin" && canManage()) v = "admin";
  if (v === mode) { if (v === "setup") renderSetup(false); return; }
  if (v !== "setup") document.body.classList.remove("wzon");
  const prev = mode; mode = v; modeSeg(v, !!prev); $("composer").hidden = v !== "chat"; document.body.dataset.mode = v;
  const inEl = $(v); MODE_ORDER.forEach((m) => { if (m !== v) $(m).hidden = true; }); inEl.hidden = false;
  $("ownerBtn").setAttribute("aria-pressed", v === "owner");
  Glass.renderNav();
  if (v === "admin") {
    if (SU.dirty) { SU.dirty = false; loadHotel().then(() => renderAdmin(true)).catch(fail); } else renderAdmin(true);
  } else $("gearBtn").setAttribute("aria-pressed", false);
  if (v === "owner") renderOwner(true);
  if (v === "import") renderImport();
  if (v === "setup") renderSetup(true);
  if (prev && !RM.matches) { const dir = MODE_ORDER.indexOf(v) > MODE_ORDER.indexOf(prev) ? 1 : -1; Spring(0, (p) => { inEl.style.opacity = p; inEl.style.transform = `translateX(${(1 - p) * 24 * dir}px)`; }).to(1, { damping: 1, response: 0.38 }, () => (inEl.style.transform = "")); }
  scrollTo(0, 0);
}
addEventListener("hashchange", route);
addEventListener("scroll", () => $("hdr").classList.toggle("scrolled", scrollY > 4), { passive: true });

/* ---------- contacts and text rendering ---------- */
const contact = (role) => STATE.contacts.find((c) => norm(c.role) === norm(role));
const who = (role) => { const c = contact(role); return c ? `${c.name} (${c.role}) ${c.phone}` : role; };
const tokKey = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
// {Detail name} from the hotel's details; contacts win when a name collides.
const detailVal = (k) => { const e = Object.entries(STATE.details || {}).find(([key]) => tokKey(key) === tokKey(k)); return e && String(e[1]).trim() ? String(e[1]).trim() : null; };
// A token with no value becomes [FILL], which staffText shows as "ask a manager".
const fill = (t) => String(t || "").replace(/\{([^}]+)\}/g, (m, r) => (contact(r) ? who(r) : detailVal(r) ?? "[FILL]"));
function routeText(r) {
  const a = contact(r.first), b = r.then && contact(r.then);
  return [a && who(r.first), b && who(r.then)].filter(Boolean).join(r.join === "and" ? " and " : ", then ") || "Not set";
}
const TEL_IC = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.5 1.5h2.2l1.1 3.1-1.5 1.1a8 8 0 0 0 4.4 4.4l1.1-1.5 3.1 1.1v2.2a1.5 1.5 0 0 1-1.6 1.5A11.5 11.5 0 0 1 2 3.1 1.5 1.5 0 0 1 3.5 1.5Z"/></svg>`;
const PHONE_RE = /(^|[^\d+])((?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4}))(?!\d)/g;
// Runs on already-escaped text: wraps US phone numbers in a tap-to-call link.
const telize = (h) => h.replace(PHONE_RE, (m, pre, num, a, b, c) => `${pre}<a class="tel" href="tel:+1${a}${b}${c}">${TEL_IC}${num}</a>`);
function staffText(t) {
  return telize(esc(fill(t)).replace(/\[CHECK:[^\]]*\]|\[CHECK\]/g, "").replace(/\[FILL:?[^\]]*\]/g, '<span class="fillMark">ask a manager</span>'));
}
const SPARK = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 2.5c.4 3.4 2.6 5.6 6 6-3.4.4-5.6 2.6-6 6-.4-3.4-2.6-5.6-6-6 3.4-.4 5.6-2.6 6-6Z"/><path d="M15.5 12c.2 1.6 1.2 2.6 2.8 2.8-1.6.2-2.6 1.2-2.8 2.8-.2-1.6-1.2-2.6-2.8-2.8 1.6-.2 2.6-1.2 2.8-2.8Z"/><path d="M15 2c.15 1.1.85 1.8 2 2-1.15.15-1.85.85-2 2-.15-1.15-.85-1.85-2-2 1.15-.2 1.85-.9 2-2Z"/></svg>`;
const imgUrl = (id) => `/api/images/${encodeURIComponent(id)}`;
$("lightbox").onclick = () => ($("lightbox").hidden = true);
function openLB(src) { $("lbImg").src = src; $("lightbox").hidden = false; }

/* ---------- chat ---------- */
const picks = ["Guest wants late checkout", "Guest lost their key", "Guest wants to pay cash", "Guest has no ID", "Can they bring a dog?", "Noise complaint"];
$("chips").innerHTML = picks.map((p) => `<button class="chip" type="button">${esc(p)}</button>`).join("");
$("chips").querySelectorAll(".chip").forEach((b) => (b.onclick = () => ask(b.textContent)));
function appear(el, origin) {
  if (RM.matches) return; el.style.transformOrigin = origin;
  Spring(0, (p) => { el.style.opacity = Math.min(1, p * 1.4); el.style.transform = `translateY(${(1 - p) * 14}px) scale(${0.96 + 0.04 * p})`; }).to(1, { damping: 0.82, response: 0.4 }, () => (el.style.transform = ""));
}
const TIP_IC = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a5.2 5.2 0 0 0-3 9.5c.5.4.8 1 .8 1.7V14.5h4.4v-.8c0-.7.3-1.3.8-1.7a5.2 5.2 0 0 0-3-9.5Z"/><path d="M8 16.5h4M8.6 18.3h2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
function sopCard(s, logId, answer, extra = {}) {
  const focus = new Set(extra.focusSteps || []);
  const card = document.createElement("div"); card.className = "a";
  card.innerHTML = `<div class="hd"><div class="eyebrow">${esc(s.cat)}</div><h3>${esc(s.title)}</h3></div>
    ${answer ? `<div class="aiAns"><b>${SPARK}AI answer</b>${telize(esc(answer))}${extra.tip ? `<div class="tipLine">${TIP_IC}<span><b>Tip</b> ${telize(esc(extra.tip))}</span></div>` : ""}</div>` : ""}
    ${escalateBlock(extra.escalate)}
    <ol class="steps">${s.steps.map((x, i) => `<li${focus.has(i + 1) ? ' class="hl"' : ""}><span>${staffText(x.t)}${x.img ? `<button type="button" class="ansImg" data-img="${esc(x.img)}" aria-label="Enlarge photo"><img alt="Photo for this step" loading="lazy" src="${imgUrl(x.img)}"></button>` : ""}</span></li>`).join("")}</ol>
    ${s.script ? `<div class="say"><b>Say it like this</b>${staffText(s.script)}</div>` : ""}
    ${s.flag ? `<div class="esc"><b>Call the manager if</b>${staffText(s.flag)}${flagHint(s, extra.escalate)}</div>` : ""}
    <div class="ft">${STATE.settings.showSource ? `<span class="tag">${esc(s.id)} · v${s.ver}</span><span>Updated ${fmtD(s.updated)}</span>` : ""}
    <span class="fb"><button type="button" data-v="y" class="press">Helpful</button><button type="button" data-v="n" class="press">Not helpful</button></span></div>`;
  card.querySelectorAll(".ansImg").forEach((b) => (b.onclick = () => openLB(imgUrl(b.dataset.img))));
  wireEscalate(card);
  card.querySelectorAll(".fb button").forEach((b) => (b.onclick = async () => {
    card.querySelectorAll(".fb button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
    try { await api("/api/feedback", { hotel: false, body: { logId, fb: b.dataset.v } }); toast(b.dataset.v === "n" ? "Sent to managers to review" : "Thanks for the feedback"); } catch (e) { fail(e); }
  }));
  return card;
}
/* ----- escalation: who to call now, or which WhatsApp chat to ask (Ask Lotus never posts or links to WhatsApp) ----- */
const chatName = (c) => (STATE.chats || {})[c] || (STATE.chatDefaults || {})[c] || (c === "housekeeping" ? "Housekeeping" : "Front Desk");
// Housekeeping topics use the housekeeping call route, everything else the guest route; emergencies use the emergency route.
function routeFor(e) {
  const find = (id, re) => STATE.routes.find((r) => r.id === id) || STATE.routes.find((r) => re.test(r.label)) || null;
  return e.emergency ? find("emergency", /fire|emergenc/i) : e.chat === "housekeeping" ? find("housekeeping", /housekeep/i) : find("guest", /guest/i);
}
const URGENT_WHY = {
  emergency: "Emergency. Call 911 first, then the people below.",
  safety: "Safety or security risk. Don't wait for a chat reply. Call now.",
  ai: "This can't wait for a chat reply. Call now.",
};
function callNowBlock(e) {
  const r = routeFor(e) || STATE.routes[0];
  const lines = [e.emergency ? `<span class="who-line"><strong>Call 911 first</strong></span>` : "", r ? `<span class="who-line">${esc(r.label)}: ${telize(esc(routeText(r)))}</span>` : ""].join("");
  return `<div class="callNow" role="group" aria-label="Call now"><b>Call now</b><p class="why">${esc(URGENT_WHY[e.why] || URGENT_WHY.ai)}</p>${lines}</div>`;
}
const replyMins = () => { const n = Math.round(Number((STATE.chats || {}).responseMinutes)); return n >= 1 && n <= 60 ? n : 5; };
const minWord = (n) => `${n} minute${n === 1 ? "" : "s"}`;
// "No reply in 5 minutes? Call Name (Role)": the first contact of the housekeeping route (housekeeping topics) or the guest route.
function callFallback(e) {
  const r = routeFor({ chat: e.chat }), c = r && contact(r.first);
  const who = c ? `${telize(esc(`${c.name} (${c.role}) ${c.phone}`))}` : "the manager on duty";
  return `<span class="noReply">No reply in ${minWord(replyMins())}? Call ${c ? who : esc(who)}</span>`;
}
function chatBlock(e) {
  return `<div class="chatAsk"><b>Ask in the <span class="chatNm">${esc(chatName(e.chat))}</span> chat</b>
    <span class="postLbl">Post this:</span>
    <blockquote class="msgQuote" tabindex="0">${esc(e.message)}</blockquote>
    <button type="button" class="pillbtn tint press copyMsg">Copy message</button>
    ${callFallback(e)}</div>`;
}
const EMERG_SOP_RE = /\b(fire|smoke|medical|ambulance|911|unconscious|collapsed|bleeding|injur\w*|heart attack|seizure|overdos\w*|choking|drown\w*|weapon|gun|shooting|stabb\w*|assault\w*|violen\w*|gas leak|carbon monoxide|flood\w*|burst pipe|suicid\w*)\b/i;
const isEmergencySop = (s) => /emergenc/i.test(s.cat || "") || EMERG_SOP_RE.test(s.title || "");
// Small muted line in the "Call the manager if" box: message the chat first unless this is an emergency or the turn is already urgent.
function flagHint(s, esc0) {
  if (isEmergencySop(s) || (esc0 && (esc0.level === "urgent" || esc0.emergency))) return "";
  return `<span class="flagHint">Not an emergency? Message the ${esc(chatName("front_desk"))} chat first. No reply in ${minWord(replyMins())}? Call.</span>`;
}
const escalateBlock = (e) => (!e ? "" : e.level === "urgent" ? callNowBlock(e) : chatBlock(e));
// Clipboard API first; if the browser refuses, select the text (and try the old copy command) so a long-press still works.
async function copyMessage(box) {
  const text = box.textContent;
  try { await navigator.clipboard.writeText(text); toast("Copied"); return; } catch { /* fall back */ }
  try {
    const rg = document.createRange(); rg.selectNodeContents(box);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg);
    toast(document.execCommand && document.execCommand("copy") ? "Copied" : "Selected. Press and hold to copy");
  } catch { toast("Select the message and copy it"); }
}
function wireEscalate(card) {
  card.querySelectorAll(".copyMsg").forEach((b) => (b.onclick = () => copyMessage(b.closest(".chatAsk").querySelector(".msgQuote"))));
}
const whoBlock = () => `<div class="esc"><b>Who to call</b>${STATE.routes.map((r) => `<span class="who-line">${esc(r.label)}: ${r.id === "emergency" ? "call 911 first, then " : ""}${telize(esc(routeText(r)))}</span>`).join("")}</div>`;
function missCard(general, aiDown, esc0) {
  const card = document.createElement("div"); card.className = "a miss";
  card.innerHTML = `<div class="hd"><div class="eyebrow">Not covered yet</div><h3>Check with the manager on duty</h3></div>
    ${general ? `<p class="generalAns"><b>General guidance (not an SOP):</b> ${esc(general)}</p>` : ""}
    <p>${aiDown ? "The assistant is having trouble right now. " : ""}This isn't in ${esc(hotelName(STATE.hotel))}'s procedures. Ask before you answer the guest. Your question was sent to the managers so it gets added.</p>
    ${esc0 ? escalateBlock(esc0) + `<details class="whoMore"><summary>Who to call</summary>${whoBlock()}</details>` : whoBlock()}<div style="height:14px"></div>`;
  wireEscalate(card);
  return card;
}
function adviceCard(r) {
  const card = document.createElement("div"); card.className = "a advice";
  card.innerHTML = `<div class="hd"><div class="eyebrow">Not in your SOPs &middot; Expert guidance</div><h3>General best practice</h3></div>
    <p class="adviceTxt">${telize(esc(r.advice))}</p>
    ${r.confirm ? `<div class="confirmBox"><b>Confirm with a manager before acting</b></div>` : ""}
    ${r.escalate ? escalateBlock(r.escalate) : r.confirm ? whoBlock() : ""}
    <p class="adviceNote">This isn't ${esc(hotelName(STATE.hotel))}'s procedure. It was sent to the managers so it gets added.</p>`;
  wireEscalate(card);
  return card;
}
function askCard(r, onPick) {
  const card = document.createElement("div"); card.className = "a askq";
  card.innerHTML = `<div class="hd"><div class="eyebrow">Quick question</div></div><p class="askText">${esc(r.question)}</p>
    <div class="opts" role="group" aria-label="Choose an answer">${r.options.map((o) => `<button type="button" class="chip opt">${esc(o)}</button>`).join("")}</div>
    <p class="askHint">Or type your answer below.</p>`;
  card.querySelectorAll(".opt").forEach((b) => (b.onclick = () => { if (card.classList.contains("done")) return; onPick(b.textContent, b); }));
  return card;
}
function lockAsk(card, picked) {
  card.classList.add("done");
  card.querySelectorAll(".opt").forEach((b) => { b.disabled = true; if (picked && b.textContent === picked) b.classList.add("picked"); });
}

/* conversation: the server keeps the context, we keep the id (and a light copy of the thread so a refresh continues) */
let convoId = null, convoLog = [];
const CK = () => "asklotus.convo." + (STATE.me ? STATE.me.id : "x");
function saveConvo() {
  try { if (convoId) sessionStorage.setItem(CK(), JSON.stringify({ hotel: STATE.hotel, convoId, log: convoLog.slice(-30) })); else sessionStorage.removeItem(CK()); } catch {}
}
function newChat(silent) {
  convoId = null; convoLog = []; $("thread").innerHTML = ""; saveConvo(); $("newRow").hidden = true;
  if (!silent) $("askInput").focus();
}
$("newChat").onclick = () => newChat();
function renderTurn(item, live) {
  const th = $("thread");
  if (item.t === "q") { const q = document.createElement("div"); q.className = "q"; q.textContent = item.text; th.appendChild(q); if (live) appear(q, "bottom right"); return q; }
  const r = item.r;
  const card = r.kind === "ask" ? askCard(r, (text, btn) => { lockAsk(card, text); ask(text); })
    : r.kind === "answer" && r.sop ? sopCard(r.sop, r.logId, r.answer, { tip: r.tip, focusSteps: r.focusSteps, escalate: r.escalate })
    : r.kind === "advise" ? adviceCard(r)
    : missCard(r.general, r.aiDown, r.escalate);
  th.appendChild(card); if (live) appear(card, "bottom left");
  return card;
}
function restoreConvo() {
  if (convoId || $("thread").children.length) return;
  let d = null; try { d = JSON.parse(sessionStorage.getItem(CK()) || "null"); } catch {}
  if (!d || d.hotel !== STATE.hotel || !d.convoId || !Array.isArray(d.log)) return;
  convoId = d.convoId; convoLog = d.log;
  convoLog.forEach((it, i) => { const el = renderTurn(it, false); if (it.t === "r" && it.r.kind === "ask" && i < convoLog.length - 1) lockAsk(el, (convoLog[i + 1] || {}).text); });
  $("newRow").hidden = false;
}
let asking = false;
async function ask(text) {
  text = text.trim(); if (!text || asking) return; asking = true;
  const th = $("thread");
  // A chat that was still waiting on a question: typing instead of tapping closes that card.
  th.querySelectorAll(".askq:not(.done)").forEach((c) => lockAsk(c, text));
  convoLog.push({ t: "q", text }); renderTurn({ t: "q", text }, true);
  const wait = document.createElement("div"); wait.className = "loading"; wait.setAttribute("role", "status"); wait.innerHTML = `Thinking<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>`; th.appendChild(wait);
  wait.scrollIntoView({ block: "nearest" });
  $("newRow").hidden = false;
  try {
    const r = await api("/api/ask", { body: { q: text, convoId } });
    wait.remove();
    convoId = r.convoId || convoId;
    convoLog.push({ t: "r", r }); saveConvo();
    const card = renderTurn({ t: "r", r }, true);
    card.scrollIntoView({ behavior: RM.matches ? "auto" : "smooth", block: "start" });
  } catch (e) { wait.textContent = e.message; wait.classList.add("err"); convoLog.pop(); }
  asking = false;
}
$("ask").addEventListener("submit", (e) => { e.preventDefault(); ask($("askInput").value); $("askInput").value = ""; });

/* ---------- admin ---------- */
let tab = "sops", cat = "", empFilter = null;
const TABS = [["dashboard", "Dashboard"], ["home", "Hotel home"], ["sops", "Library"], ["gaps", "Unanswered"], ["activity", "Activity"], ["team", "Team"], ["contacts", "Contacts"], ["settings", "Settings"]];
const TAB_TITLE = { dashboard: "Dashboard", home: "Hotel home", sops: "Library", gaps: "Unanswered", activity: "Activity", team: "Team", contacts: "Contacts", settings: "Settings" };
// The gear buttons are hidden now (the sidebar has Settings); they still work if shown.
let prevTab = "sops";
const leaveSettings = () => { tab = prevTab; renderAdmin(true); scrollTo(0, 0); };
$("gearBtn").onclick = () => {
  closeMenus();
  if (tab === "settings" && mode === "admin") return leaveSettings();
  prevTab = mode === "admin" && tab !== "settings" ? tab : "sops"; tab = "settings";
  if (mode === "admin") { renderAdmin(true); scrollTo(0, 0); } else location.hash = "admin";
};
$("backBtn").onclick = leaveSettings;
// The feed is one row per staff message; a conversation (same convo id) is one item. Older rows are one item each.
function groupLog(rows) {
  const m = new Map(), out = [];
  for (const l of rows) {
    const k = l.convo || "r" + l.id; let g = m.get(k);
    if (!g) { g = { key: k, uid: l.uid, user_name: l.user_name, rows: [] }; m.set(k, g); out.push(g); }
    g.rows.push(l);
  }
  for (const g of out) {
    g.rows.sort((a, b) => a.id - b.id);
    const last = g.rows[g.rows.length - 1], ans = [...g.rows].reverse().find((r) => r.sop);
    g.sop = ans ? ans.sop : null; g.when = last.when; g.id = last.id;
    g.fb = g.rows.some((r) => r.fb === "n") ? "n" : (ans && ans.fb) || null;
    g.dismissed = g.rows.every((r) => r.dismissed);
    const er = g.rows.filter((r) => r.esc_level);
    g.escLevel = er.some((r) => r.esc_level === "urgent") ? "urgent" : er.length ? "chat" : null;
    g.escChat = er.length ? er[er.length - 1].esc_chat : null;
    g.open = !g.sop && last.kind === "ask"; // still waiting on the staff member's answer: not a gap
    g.q = g.rows.map((r) => r.q).join(". ");
  }
  return out;
}
const setLog = (rows) => { STATE.log = rows; STATE.convos = groupLog(rows); };
const markDismissed = (id) => { const l = STATE.log.find((x) => x.id == id); if (l) STATE.log.forEach((x) => { if (x.id == id || (l.convo && x.convo === l.convo)) x.dismissed = true; }); setLog(STATE.log); };
const gaps = () => STATE.convos.filter((g) => ((!g.sop && !g.open) || g.fb === "n") && !g.dismissed);
const weekLog = () => STATE.convos.filter((g) => !g.open && Date.now() - new Date(g.when) < 7 * 864e5);

// The sidebar / phone tab bar (dash.js) replaces the old pill tabs.
const renderTabs = () => Glass.renderNav();
function renderCatPills() {
  $("cats").innerHTML = [{ name: "All" }, ...STATE.cats].map((c, i) => `<button type="button" class="press" data-c="${i ? esc(c.name) : ""}" aria-pressed="${(i ? c.name : "") === cat}">${esc(c.name)}</button>`).join("");
  $("cats").querySelectorAll("button").forEach((b) => (b.onclick = () => { cat = b.dataset.c; $("cats").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); renderList(); }));
  $("f-cat").innerHTML = STATE.cats.map((c) => `<option>${esc(c.name)}</option>`).join("");
}
$("filter").oninput = () => renderList();

async function renderAdmin(refresh) {
  if ((tab === "settings" || tab === "dashboard") && !canManage()) tab = "sops";
  if (tab === "home" && !isGM()) tab = "sops";
  if (refresh) {
    try {
      const [log, users] = await Promise.all([api("/api/activity"), api("/api/users", { hotel: false })]);
      setLog(log); STATE.users = users;
    } catch (e) { fail(e); }
  }
  renderTabs(); TABS.forEach(([k]) => ($("tab-" + k).hidden = k !== tab));
  const onSet = tab === "settings", onDash = tab === "dashboard";
  $("gearBtn").setAttribute("aria-pressed", onSet);
  $("tiles").hidden = onSet || onDash || tab === "home"; $("tabs").hidden = true; $("backBtn").hidden = true;
  $("adminHead").hidden = onDash;
  $("toSetup").hidden = onSet || hotelObj().ready;
  $("adminTitle").textContent = TAB_TITLE[tab] || "Manager";
  $("adminHotel").textContent = hotelName(STATE.hotel);
  if (!onSet) Glass.applyHotelAccent(); // an unsaved color preview never outlives the Settings page
  const wk = weekLog(), ans = wk.filter((l) => l.sop).length;
  $("sLive").textContent = STATE.sops.filter((s) => s.status === "live").length;
  $("sQ").textContent = wk.length;
  $("sRate").textContent = (wk.length ? Math.round((ans / wk.length) * 100) : 0) + "%";
  $("sGap").textContent = gaps().length;
  ({ dashboard: Glass.renderDashboard, home: renderHome, sops: renderList, gaps: renderGaps, activity: renderActivity, team: renderTeam, contacts: renderContacts, settings: Glass.renderSettingsPage })[tab]();
}

function renderList() {
  const f = norm($("filter").value);
  const rows = STATE.sops.filter((s) => (!cat || s.cat === cat) && (!f || norm(s.title + " " + s.kw + " " + s.id).includes(f)))
    .sort((a, b) => ({ draft: 0, live: 1, off: 2 }[a.status] - { draft: 0, live: 1, off: 2 }[b.status]) || a.id.localeCompare(b.id, "en", { numeric: true }));
  $("libCount").textContent = rows.length + " SOP" + (rows.length === 1 ? "" : "s");
  $("sopList").innerHTML = rows.length ? rows.map((s) => { const ph = s.steps.filter((x) => x.img).length;
    return `<button type="button" class="cell" data-edit="${esc(s.id)}"><span class="dot ${s.status}"></span>
    <span class="body"><span class="t">${esc(s.title)}</span><span class="m">${esc(s.id)} · v${s.ver}${cat ? "" : " · " + esc(s.cat)}${ph ? ` · <span class="ph">${IC.img}${ph}</span>` : ""} · ${fmtD(s.updated)}</span></span>${s.status === "draft" ? `<span class="status draft">Draft</span>` : s.status === "off" ? `<span class="status off">Off</span>` : ""}${chev}</button>`; }).join("") : `<div class="empty">No SOPs match that search.</div>`;
  $("sopList").querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => openSop(b.dataset.edit)));
}

function renderGaps() {
  const g = gaps();
  $("gapList").innerHTML = g.length ? g.map((l) => `<div class="cell" style="flex-wrap:wrap">
    <span class="body" style="min-width:180px"><span class="t wrap">${esc(l.q)}</span><span class="m">${esc(l.user_name || "Removed user")} · ${l.sop ? "Marked not helpful on " + esc(l.sop) : "No SOP matched"}${l.rows.length > 1 ? ` · ${l.rows.length}-message chat` : ""} · ${fmtDT(l.when)}</span></span>
    <span class="acts"><button type="button" class="pillbtn press" data-dismiss="${l.id}">Dismiss</button><button type="button" class="pillbtn tint press" data-make="${l.id}">Write SOP</button></span></div>`).join("") : `<div class="empty">Every question has an answer right now.</div>`;
  $("gapList").querySelectorAll("[data-make]").forEach((b) => (b.onclick = () => { const l = STATE.convos.find((x) => x.id == b.dataset.make); l.sop && l.fb === "n" && sop(l.sop) ? openSop(l.sop, null, l.id) : openSop(null, l.q, l.id); }));
  $("gapList").querySelectorAll("[data-dismiss]").forEach((b) => (b.onclick = async () => {
    try { await api(`/api/activity/${b.dataset.dismiss}/dismiss`, { body: {} }); markDismissed(b.dataset.dismiss); renderAdmin(); } catch (e) { fail(e); }
  }));
}

function topOf(ls) { const c = {}; ls.forEach((l) => { if (l.sop) { const s = sop(l.sop); if (s) c[s.title] = (c[s.title] || 0) + 1; } }); const t = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return t && t[0]; }
const escBadge = (l) => (l.escLevel === "urgent" ? `<span class="escBadge urgent">Urgent</span>` : `<span class="escBadge">${l.escChat === "housekeeping" ? "HK chat" : "FD chat"}</span>`);
function renderActivity() {
  const all = STATE.convos, log = empFilter ? all.filter((l) => l.uid === empFilter) : all;
  const fu = empFilter && STATE.users.find((u) => u.id === empFilter);
  $("actFilter").innerHTML = fu ? `<button type="button" class="filterchip press" id="clearEmp">Showing ${esc(fu.name)} <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2l6 6M8 2 2 8"/></svg></button>` : "";
  if (fu) $("clearEmp").onclick = () => { empFilter = null; renderActivity(); };
  const by = {}; all.forEach((l) => { if (l.uid) (by[l.uid] = by[l.uid] || []).push(l); });
  const emps = Object.entries(by).map(([uid, ls]) => ({ u: STATE.users.find((u) => u.id == uid) || { id: +uid, name: ls[0].user_name || "Removed user" }, n: ls.length, miss: ls.filter((l) => !l.sop && !l.open).length, top: topOf(ls) })).sort((a, b) => b.n - a.n);
  $("byEmp").innerHTML = emps.length ? emps.map((e) => `<button type="button" class="cell" data-emp="${e.u.id}">${avatar(e.u)}
    <span class="body"><span class="t">${esc(e.u.name)}</span><span class="m">${e.top ? "Asks most about " + esc(e.top) : "No answered questions yet"}${e.miss ? ` · <span class="no">${e.miss} not covered</span>` : ""}</span></span>
    <span class="val">${e.n}</span>${chev}</button>`).join("") : `<div class="empty">No questions yet. They'll show here as staff use the chat.</div>`;
  $("byEmp").querySelectorAll("[data-emp]").forEach((b) => (b.onclick = () => { empFilter = empFilter == b.dataset.emp ? null : +b.dataset.emp; renderActivity(); $("actFilter").scrollIntoView({ block: "nearest" }); }));
  const cnt = {}; log.forEach((l) => { if (l.sop) { const s = sop(l.sop); if (s) cnt[s.title] = (cnt[s.title] || 0) + 1; } });
  const e = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 6), max = Math.max(1, ...e.map((x) => x[1]));
  $("topTitle").textContent = fu ? `${fu.name.split(" ")[0]}'s topics` : "Most asked topics";
  $("usage").innerHTML = e.length ? e.map(([k, v]) => `<div class="bar"><span class="nm">${esc(k)}</span><span class="n">${v}</span><div class="track"><div class="fill" style="width:${(v / max) * 100}%"></div></div></div>`).join("") : `<div class="empty">No answered questions yet.</div>`;
  $("feedTitle").textContent = `Recent questions (${log.length})`;
  $("feed").innerHTML = log.length ? log.slice(0, 50).map((l) => { const u = { id: l.uid || 0, name: l.user_name || "Removed user" }, s = l.sop && sop(l.sop);
    return `<div class="cell">${avatar(u, 28)}<span class="body"><span class="t wrap">${esc(l.rows[0].q)}</span>${l.rows.length > 1 ? `<span class="convoTurns">${l.rows.slice(1).map((r) => `<span class="ct">&#8627; ${esc(r.q)}</span>`).join("")}</span>` : ""}<span class="m">${esc(u.name)} · ${s ? esc(s.id + " " + s.title) : l.open ? "Waiting on an answer" : `<span class="no">Not covered</span>`}${l.fb === "n" ? ` · <span class="no">Not helpful</span>` : ""}${l.escLevel ? ` · ${escBadge(l)}` : ""} · ${fmtDT(l.when)}</span></span></div>`; }).join("") : `<div class="empty">No questions yet.</div>`;
}

function renderTeam() {
  const r = {}; STATE.users.forEach((u) => (r[u.role] = (r[u.role] || 0) + 1));
  $("teamCount").textContent = Object.entries(r).map(([k, v]) => `${v} ${k}`).join(" · ") || "Team";
  $("teamList").innerHTML = STATE.users.map((u) => {
    const locked = !canGrant(u.role);
    const st = u.status === "off" ? `<span class="status off">Off</span>` : u.must_change_pw ? `<span class="status invited">Not signed in yet</span>` : "";
    return `<button type="button" class="cell" data-user="${u.id}" ${locked ? "disabled" : ""}>${avatar(u)}
      <span class="body"><span class="t">${esc(u.name)}${u.id === STATE.me.id ? " (you)" : ""}</span><span class="m">@${esc(u.username)} · ${esc(u.role)} · ${u.hotels.length > 1 ? u.hotels.length + " hotels" : esc(hotelName(u.hotels[0]))} · ${u.last_seen ? "Active " + fmtD(u.last_seen) : "Never signed in"}</span></span>${st}${locked ? "" : chev}</button>`;
  }).join("");
  $("teamList").querySelectorAll("[data-user]:not([disabled])").forEach((b) => (b.onclick = () => openUser(+b.dataset.user)));
  $("teamFoot").textContent = isOwner() ? "Everyone signs in with their own username, so every question is tied to them." : isGM() ? "GMs can add and edit people at their hotels, up to GM. Only an Owner can change Owner accounts." : "Managers can add and edit Front Desk and Manager accounts at their hotels.";
}

/* ----- contacts ----- */
function roleOpts(sel, allowNone) { return (allowNone ? `<option value="">None</option>` : "") + STATE.contacts.map((c) => `<option ${norm(c.role) === norm(sel) ? "selected" : ""}>${esc(c.role)}</option>`).join(""); }
function renderContacts() {
  $("routeList").innerHTML = STATE.routes.map((r) => `<div class="cell route"><span class="body"><span class="t">${esc(r.label)}</span><span class="m">${esc(r.sub)}</span></span>
    <span class="routesel"><label class="pick"><small>First call</small><select data-r="${esc(r.id)}" data-k="first" aria-label="${esc(r.label)} first call">${roleOpts(r.first)}</select></label><label class="pick"><small>${r.join === "and" ? "And" : "Then"}</small><select data-r="${esc(r.id)}" data-k="then" aria-label="${esc(r.label)} second call">${roleOpts(r.then, true)}</select></label></span></div>`).join("");
  $("routeList").querySelectorAll("select").forEach((s) => (s.onchange = async () => {
    const r = STATE.routes.find((x) => x.id === s.dataset.r);
    try { await api(`/api/routes/${encodeURIComponent(r.id)}`, { method: "PUT", body: { field: s.dataset.k, value: s.value } }); r[s.dataset.k] = s.value; toast(`${r.label}: ${routeText(r)}`); }
    catch (e) { fail(e); renderContacts(); }
  }));
  for (const [id, k] of [["chatFd", "front_desk"], ["chatHk", "housekeeping"]]) {
    const inp = $(id); inp.value = chatName(k); inp.placeholder = (STATE.chatDefaults || {})[k] || "";
    inp.onchange = async () => {
      try { const r = await api("/api/hotel/chats", { method: "PUT", body: { [k]: inp.value } }); STATE.chats = r.chats; STATE.chatDefaults = r.chatDefaults; inp.value = r.chats[k]; toast(`${r.chats[k]} chat saved`); }
      catch (e) { fail(e); inp.value = chatName(k); }
    };
  }
  const rm = $("chatMins"); rm.value = replyMins();
  rm.onchange = async () => {
    try { const r = await api("/api/hotel/chats", { method: "PUT", body: { response_minutes: rm.value } }); STATE.chats = r.chats; rm.value = replyMins(); toast(`Reply time set to ${minWord(replyMins())}`); }
    catch (e) { fail(e); rm.value = replyMins(); }
  };
  $("contactList").innerHTML = STATE.contacts.map((c) => `<button type="button" class="cell" data-c="${c.id}"><span class="av" style="background:${color(c.id)}">${esc(initials(c.name))}</span>
    <span class="body"><span class="t">${esc(c.role)}</span><span class="m">${esc(c.name)} · ${esc(c.phone)}</span></span>${chev}</button>`).join("") || `<div class="empty">No contacts yet. Add your AGM, GM, COO, Engineer and Head Housekeeper. The call routes above use those role names.</div>`;
  $("contactList").querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => openContact(+b.dataset.c)));
}
async function reloadHotelData() { await loadHotel(); renderAdmin(); }

/* ----- settings ----- */
const MODEL_HINTS = { anthropic: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"] };
const SUBS = { anthropic: "Claude models", openai: "GPT models", google: "Gemini models", azure: "Your Azure deployment", custom: "Any OpenAI-compatible endpoint" };
let draftProvider = null;
function renderSettings() {
  const st = STATE.settings;
  const provs = st.providers || [];
  if (!draftProvider) draftProvider = st.provider === "none" ? "anthropic" : st.provider;
  const p = provs.find((x) => x.id === draftProvider) || {};
  const same = draftProvider === st.provider;
  $("connRow").innerHTML = st.connected && st.provider !== "none"
    ? `<span class="light"></span><span class="body" style="flex:1"><b style="font-weight:600">Connected to ${esc((provs.find((x) => x.id === st.provider) || {}).name || st.provider)}</b><span style="display:block;font-size:.8rem;color:var(--label2)">Key ending ${esc(st.last4)} · added ${st.addedAt ? fmtD(st.addedAt) : ""} by ${esc(st.addedBy || "")}</span></span>`
    : `<span class="light off"></span><span class="body" style="flex:1"><b style="font-weight:600">No AI connected</b><span style="display:block;font-size:.8rem;color:var(--label2)">Answers use keyword matching. Pick a provider, paste its key and save to turn on AI matching.</span></span>`;
  $("provList").innerHTML = provs.map((x) => `<button type="button" class="radio" role="radio" data-p="${x.id}" aria-checked="${x.id === draftProvider}"><span class="body" style="flex:1"><span class="t" style="display:block;font-weight:500">${esc(x.name)}</span><span style="font-size:.8rem;color:var(--label2)">${esc(SUBS[x.id] || "")}</span></span>${checkSvg}</button>`).join("");
  $("provList").querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => { draftProvider = b.dataset.p; $("st-model").value = ""; $("st-model-w").value = ""; $("st-url").value = ""; renderSettings(); }));
  $("modelList").innerHTML = (MODEL_HINTS[draftProvider] || []).map((m) => `<option value="${m}">`).join("");
  if (same && !$("st-model").value) $("st-model").value = st.model || "";
  if (same && !$("st-model-w").value) $("st-model-w").value = st.modelWriting || "";
  // A newly picked provider starts with the recommended models filled in (a blank model can fall back to a pricier one).
  if (!same && !$("st-model").value && p.defaultModel) $("st-model").value = p.defaultModel;
  if (!same && !$("st-model-w").value && p.defaultWritingModel) $("st-model-w").value = p.defaultWritingModel;
  $("st-model").placeholder = p.defaultModel ? `Suggested: ${p.defaultModel}` : draftProvider === "azure" ? "Optional for Azure" : "Model name";
  $("st-model-w").placeholder = p.defaultWritingModel ? `Suggested: ${p.defaultWritingModel}` : "Same as chat model";
  $("baseUrlFld").hidden = !p.needsUrl;
  $("st-urlLabel").textContent = draftProvider === "azure" ? "Chat completions URL" : "Base URL";
  if (same && !$("st-url").value) $("st-url").value = st.baseUrl || "";
  $("st-key").value = "";
  $("st-key").placeholder = same && st.connected ? `Saved key ending ${st.last4}. Paste a new one to replace it.` : "Paste the API key";
  $("removeKey").hidden = !(st.connected && same);
  document.querySelectorAll("[data-set]").forEach((sw) => sw.setAttribute("aria-checked", !!st[sw.dataset.set]));
}
$("saveAi").onclick = async () => {
  const st = STATE.settings, key = $("st-key").value.trim();
  if (draftProvider !== st.provider && !key) { toast("Paste the API key for this provider"); $("st-key").focus(); return; }
  try {
    STATE.settings = await api("/api/settings", { hotel: false, method: "PUT", body: { provider: draftProvider, model: $("st-model").value, modelWriting: $("st-model-w").value, baseUrl: $("st-url").value, apiKey: key || undefined } });
    $("st-key").value = ""; toast("AI settings saved"); renderSettings(); $("aiPill").hidden = !STATE.settings.aiOn;
  } catch (e) { fail(e); }
};
$("removeKey").onclick = async () => {
  try { STATE.settings = await api("/api/settings", { hotel: false, method: "PUT", body: { provider: "none", removeKey: true } }); draftProvider = null; toast("Key removed. Answers use keyword matching."); renderSettings(); $("aiPill").hidden = true; } catch (e) { fail(e); }
};
document.querySelectorAll("[data-set]").forEach((sw) => (sw.onclick = async () => {
  const k = sw.dataset.set, v = !STATE.settings[k];
  try { STATE.settings = await api("/api/settings", { hotel: false, method: "PUT", body: { [k]: v } }); renderSettings(); } catch (e) { fail(e); }
}));
$("testConn").onclick = async () => {
  const b = $("testConn"); b.disabled = true; b.innerHTML = `<span class="spin"></span> Testing`;
  try { const r = await api("/api/settings/test", { hotel: false, body: {} }); const rs = r.results || [];
    toast(rs.length > 1 ? rs.map((x) => `${x.label} answered in ${(x.ms / 1000).toFixed(1)}s`).join(" · ") : `Connected. The provider answered in ${(r.ms / 1000).toFixed(1)}s`); }
  catch (e) { fail(e); }
  b.disabled = false; b.textContent = "Test Connection";
};

/* ---------- appearance (light / dark) ---------- */
const THEMES = [["auto", "Automatic", "Match this phone or computer"], ["light", "Light", ""], ["dark", "Dark", ""]];
function renderTheme() {
  const cur = window.getTheme ? window.getTheme() : "auto";
  document.querySelectorAll(".themeList").forEach((g) => {
    g.innerHTML = THEMES.map(([k, l, d]) => `<button type="button" class="radio" role="radio" data-theme-pick="${k}" aria-checked="${k === cur}"><span class="body" style="flex:1"><span class="rt">${l}</span>${d ? `<span class="rs">${d}</span>` : ""}</span>${checkSvg}</button>`).join("");
  });
  document.querySelectorAll(".themeSeg").forEach((g) => {
    g.innerHTML = THEMES.map(([k, l]) => `<button type="button" class="themePill press" data-theme-pick="${k}" aria-pressed="${k === cur}">${k === "auto" ? "Auto" : l}</button>`).join("");
  });
  document.querySelectorAll("[data-theme-pick]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); window.setTheme && window.setTheme(b.dataset.themePick); }));
}
document.addEventListener("themechange", renderTheme);
renderTheme();

/* ---------- bottom sheet ---------- */
const cardEl = $("card"), sheet = $("sheet"), scrim = $("scrim"); let sheetH = 600;
const sheetS = Spring(0, (y) => { cardEl.style.transform = `translateY(${y}px)`; scrim.style.opacity = Math.max(0, Math.min(1, 1 - y / sheetH)); });
function showSheet(which) {
  const open = !sheet.hidden && sheetS.target === 0; // already on screen: just swap the form, no slide
  ["editor", "userEd", "contactEd", "hotelEd", "masterEd", "authorEd"].forEach((id) => ($(id).hidden = id !== which)); sheet.hidden = false; scrim.hidden = false; sheetH = cardEl.offsetHeight || 600;
  if (open) { sheet.querySelectorAll(".sbody").forEach((b) => (b.scrollTop = 0)); return; }
  if (!sheetS.raf && sheetS.value <= 0) sheetS.set(sheetH); sheetS.to(0, { damping: 1, response: 0.38 }); document.body.style.overflow = "hidden";
  sheet.querySelectorAll(".sbody").forEach((b) => (b.scrollTop = 0));
}
function hideSheet(velocity) { if (AU.active) authorDiscard(); sheetH = cardEl.offsetHeight || sheetH; sheetS.to(sheetH, { damping: 1, response: 0.32, velocity }, () => { sheet.hidden = true; scrim.hidden = true; document.body.style.overflow = ""; }); }
sheet.querySelectorAll(".cancel").forEach((b) => (b.onclick = () => hideSheet()));
scrim.onclick = () => hideSheet();
addEventListener("keydown", (e) => { if (e.key === "Escape") { if (!$("lightbox").hidden) $("lightbox").hidden = true; else if (!sheet.hidden) hideSheet(); } });
let drag = null;
function dStart(e) { if (e.target.closest("button")) return; cancelAnimationFrame(sheetS.raf); sheetS.raf = 0; sheetH = cardEl.offsetHeight; drag = { id: e.pointerId, startY: e.clientY, base: sheetS.value, hist: [{ y: e.clientY, t: e.timeStamp }] }; e.currentTarget.setPointerCapture(e.pointerId); }
function dMove(e) { if (!drag || e.pointerId !== drag.id) return; let y = drag.base + (e.clientY - drag.startY); if (y < 0) y = rubber(y, sheetH); sheetS.value = y; sheetS.velocity = 0; cardEl.style.transform = `translateY(${y}px)`; scrim.style.opacity = Math.max(0, Math.min(1, 1 - y / sheetH)); drag.hist.push({ y: e.clientY, t: e.timeStamp }); if (drag.hist.length > 6) drag.hist.shift(); }
function dEnd(e) { if (!drag || e.pointerId !== drag.id) return; const h = drag.hist, a = h[0], b = h[h.length - 1], v = ((b.y - a.y) / Math.max(1, b.t - a.t)) * 1000; drag = null; if (sheetS.value + project(v) > sheetH * 0.45) hideSheet(v); else sheetS.to(0, { damping: v < -50 ? 0.8 : 1, response: 0.35, velocity: v }); }
sheet.querySelectorAll(".grab,.sbar").forEach((el) => { el.addEventListener("pointerdown", dStart); el.addEventListener("pointermove", dMove); el.addEventListener("pointerup", dEnd); el.addEventListener("pointercancel", dEnd); });
$("f-status").onclick = (e) => { const b = e.currentTarget; b.setAttribute("aria-checked", b.getAttribute("aria-checked") !== "true"); };
$("u-active").onclick = (e) => { const b = e.currentTarget; if (b.disabled) return; b.setAttribute("aria-checked", b.getAttribute("aria-checked") !== "true"); };

/* ----- SOP editor ----- */
let editing = null, fromLog = null, draftSteps = [], saving = false;
const IC = {
  up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>',
  img: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="6" cy="7" r="1.3"/><path d="M14 11l-3.5-3.5L4 13"/></svg>',
  del: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};
$("newSop").onclick = () => (STATE.settings.aiOn ? authorOpen({ target: "hotel", from: "list" }) : openSop(null));
function fillEditor(p) {
  $("f-title").value = p.title || "";
  if (p.category && STATE.cats.some((c) => c.name === p.category)) $("f-cat").value = p.category;
  draftSteps = (p.steps || []).map((x) => ({ t: x.t, img: x.img || null })); if (!draftSteps.length) draftSteps = [{ t: "", img: null }];
  renderSteps(); $("f-script").value = p.script || ""; $("f-flag").value = p.flag || ""; $("f-kw").value = p.kw || "";
  growAll(); requestAnimationFrame(growAll);
}
function openSop(id, seedQ, logId, preset) {
  editing = id ? sop(id) : null; fromLog = logId || null;
  $("edTitle").textContent = editing ? editing.id : "New SOP";
  $("f-title").value = editing ? editing.title : seedQ || "";
  $("f-cat").value = editing ? editing.cat : (STATE.cats[0] || {}).name;
  draftSteps = editing ? editing.steps.map((s) => ({ ...s })) : [{ t: "", img: null }];
  renderSteps();
  $("f-script").value = editing ? editing.script : ""; $("f-flag").value = editing ? editing.flag : "";
  $("f-kw").value = editing ? editing.kw : seedQ ? norm(seedQ) : "";
  $("f-status").setAttribute("aria-checked", editing ? editing.status === "live" : true);
  $("f-statusNote").textContent = editing && editing.status === "off" ? "Turned off for this hotel. Staff can't see it." : editing && editing.master && isGM() ? "Switch off to hide it from staff. You can turn it back on any time." : "";
  $("delEd").hidden = !editing; $("delEd").dataset.armed = ""; $("delEd").textContent = "Delete SOP";
  $("edAi").hidden = !STATE.settings.aiOn;
  if (preset) {
    fillEditor(preset);
    if (!editing) { $("f-status").setAttribute("aria-checked", "false"); $("f-statusNote").textContent = "Saved as a draft. Switch it on when it is ready for staff."; }
  }
  showSheet("editor"); growAll(); requestAnimationFrame(growAll);
}
$("edAi").onclick = () => authorOpen({
  target: "hotel", from: "editor", sopId: editing ? editing.id : null,
  seed: { title: $("f-title").value.trim(), category: $("f-cat").value, steps: draftSteps.filter((x) => x.t.trim() || x.img).map((x) => ({ t: x.t.trim(), img: x.img })), script: $("f-script").value.trim(), flag: $("f-flag").value.trim(), kw: $("f-kw").value.trim() },
});
function grow(t) { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; }
const growAll = () => document.querySelectorAll("#stepsEd textarea,#mSteps textarea").forEach(grow);
addEventListener("resize", () => { if (!sheet.hidden) growAll(); });
// Shared step editor. o.field is "t" (the text) or "hk" (the HotelKey wording, blank = same as PEP).
function stepEditor(cont, steps, o) {
  const n = steps.length, hk = o.field === "hk", blank = () => ({ t: "", hk: null, img: null });
  cont.innerHTML = steps.map((s, i) => `<div class="stepRow" data-i="${i}"><span class="num">${i + 1}</span>
    <span class="stepText"><textarea rows="1" aria-label="Step ${i + 1}" placeholder="${hk ? "Same as PEP" : "Describe this step"}">${esc(hk ? s.hk : s.t)}</textarea>${hk && s.t ? `<span class="pepRef">PEP: ${esc(s.t)}</span>` : ""}</span>
    <span class="stepTools"><button type="button" class="iconbtn" data-a="up" aria-label="Move step ${i + 1} up" ${i ? "" : "disabled"}>${IC.up}</button><button type="button" class="iconbtn" data-a="down" aria-label="Move step ${i + 1} down" ${i < n - 1 ? "" : "disabled"}>${IC.down}</button><button type="button" class="iconbtn ${s.img ? "has" : ""}" data-a="img" aria-label="${s.img ? "Replace" : "Add"} photo for step ${i + 1}">${IC.img}</button><button type="button" class="iconbtn del" data-a="del" aria-label="Delete step ${i + 1}">${IC.del}</button></span>
    ${s.img ? `<span class="stepImg"><img alt="Photo for step ${i + 1}" src="${imgUrl(s.img)}"><button type="button" data-a="rmimg">Remove</button></span>` : ""}</div>`).join("");
  cont.querySelectorAll(".stepRow").forEach((row) => {
    const i = +row.dataset.i, ta = row.querySelector("textarea"); grow(ta);
    ta.oninput = () => { steps[i][o.field] = ta.value; grow(ta); o.onInput && o.onInput(); };
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); steps.splice(i + 1, 0, blank()); o.redraw(i + 1); }
      else if (e.key === "Backspace" && !hk && !ta.value && steps.length > 1 && !steps[i].img) { e.preventDefault(); steps.splice(i, 1); o.redraw(Math.max(0, i - 1)); }
    };
    row.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => {
      const a = b.dataset.a;
      if (a === "up" && i) { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; o.redraw(i - 1); }
      if (a === "down" && i < n - 1) { [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; o.redraw(i + 1); }
      if (a === "del") { steps.splice(i, 1); if (!steps.length) steps.push(blank()); o.redraw(Math.min(i, steps.length - 1)); }
      if (a === "img") { imgCtx = { steps, i, redraw: o.redraw }; $("imgPick").value = ""; $("imgPick").click(); }
      if (a === "rmimg") { steps[i].img = null; o.redraw(); }
    }));
  });
  if (o.focus != null) { const t = cont.querySelectorAll("textarea")[o.focus]; if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
}
let imgCtx = null;
function renderSteps(focusIdx) { stepEditor($("stepsEd"), draftSteps, { field: "t", focus: focusIdx, redraw: renderSteps }); }
$("addStep").onclick = () => { draftSteps.push({ t: "", img: null }); renderSteps(draftSteps.length - 1); };
function shrink(file, max = 1600) {
  return new Promise((res, rej) => {
    const fr = new FileReader(); fr.onerror = rej;
    fr.onload = () => { const im = new Image(); im.onerror = rej; im.onload = () => { const k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement("canvas"); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", 0.82)); }; im.src = fr.result; };
    fr.readAsDataURL(file);
  });
}
$("imgPick").onchange = async () => {
  const f = $("imgPick").files[0]; if (!f || !imgCtx) return;
  if (!f.type.startsWith("image/")) { toast("Choose a photo or screenshot"); return; }
  try {
    toast("Uploading photo…");
    const dataUrl = await shrink(f);
    const r = await api("/api/images", { body: { dataUrl } });
    imgCtx.steps[imgCtx.i].img = r.id; imgCtx.redraw(); toast("Photo added. Save to keep it.");
  } catch (e) { fail(e.message ? e : new Error("That image couldn't be read. Try a JPG or PNG.")); }
};
$("delEd").onclick = async () => {
  const b = $("delEd");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to delete for everyone"; return; }
  try { await api(`/api/sops/${encodeURIComponent(editing.id)}`, { method: "DELETE" }); STATE.sops = STATE.sops.filter((s) => s !== editing); hideSheet(); renderAdmin(); toast("SOP deleted"); } catch (e) { fail(e); }
};
$("editor").addEventListener("submit", async (e) => {
  e.preventDefault(); if (saving) return;
  const d = { title: $("f-title").value.trim(), cat: $("f-cat").value, steps: draftSteps.map((s) => ({ t: s.t.trim(), img: s.img })).filter((s) => s.t || s.img), script: $("f-script").value.trim(), flag: $("f-flag").value.trim(), kw: $("f-kw").value.trim(), status: $("f-status").getAttribute("aria-checked") === "true" ? "live" : editing && editing.status === "off" ? "off" : editing && editing.status === "live" && editing.master && isGM() ? "off" : "draft" };
  if (!d.title) { $("f-title").focus(); toast("Add a title"); return; }
  if (!d.steps.length) { toast("Add at least one step"); return; }
  saving = true;
  try {
    const out = editing ? await api(`/api/sops/${encodeURIComponent(editing.id)}`, { method: "PUT", body: d }) : await api("/api/sops", { body: d });
    if (editing) Object.assign(editing, out); else STATE.sops.push(out);
    STATE.sops.sort((a, b) => a.id.localeCompare(b.id));
    if (fromLog) { try { await api(`/api/activity/${fromLog}/dismiss`, { body: {} }); markDismissed(fromLog); } catch {} }
    toast(out.status === "live" ? `Published ${out.id} v${out.ver}` : `Saved ${out.id} as a draft`); hideSheet(); renderAdmin();
  } catch (x) { fail(x); }
  saving = false;
});

/* ----- contact editor ----- */
let ec = null;
$("newContact").onclick = () => openContact(null);
function openContact(id) {
  ec = id ? STATE.contacts.find((c) => c.id === id) : null;
  $("cTitle").textContent = ec ? ec.role : "Add Role";
  $("c-role").value = ec ? ec.role : ""; $("c-name").value = ec ? ec.name : ""; $("c-phone").value = ec ? ec.phone : "";
  const used = ec && STATE.routes.filter((r) => norm(r.first) === norm(ec.role) || norm(r.then) === norm(ec.role)).map((r) => r.label);
  $("c-hint").textContent = ec ? (used.length ? `Used for: ${used.join(", ")}. Changing the person updates every SOP and answer that uses {${ec.role}}.` : `SOPs can use {${ec.role}} to show this person.`) : "Add a role like Night Manager or Sales Director, then use it in SOPs as {Role}.";
  $("c-del").hidden = !ec; $("c-del").dataset.armed = ""; $("c-del").textContent = "Remove Role";
  showSheet("contactEd");
}
$("c-del").onclick = async () => {
  const b = $("c-del");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to remove"; return; }
  try { await api(`/api/contacts/${ec.id}`, { method: "DELETE" }); hideSheet(); await reloadHotelData(); toast("Role removed"); } catch (e) { fail(e); }
};
$("contactEd").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { role: $("c-role").value.trim(), name: $("c-name").value.trim(), phone: $("c-phone").value.trim() };
  try {
    if (ec) await api(`/api/contacts/${ec.id}`, { method: "PUT", body }); else await api("/api/contacts", { body });
    hideSheet(); await reloadHotelData(); toast(`Saved ${body.role}`);
  } catch (x) { fail(x); }
});

/* ----- user editor ----- */
let eu = null, draftRole = "Front Desk", draftHotels = [];
const ROLES = { "Front Desk": "Chat only", Manager: "SOPs, team and activity for their hotels", GM: "Runs their hotel: setup, SOPs on and off, details, updates and team", Owner: "Everything at every hotel, including AI settings and the master library" };
$("newUser").onclick = () => openUser(null);
function renderRoles() {
  $("u-roles").innerHTML = Object.entries(ROLES).map(([r, d]) => { const dis = !canGrant(r); return `<button type="button" class="radio" role="radio" data-r="${r}" aria-checked="${r === draftRole}" ${dis ? "disabled" : ""}><span class="body" style="flex:1"><span style="display:block;font-weight:500;${dis ? "color:var(--label3)" : ""}">${r}</span><span style="font-size:.8rem;color:var(--label2)">${dis ? (r === "Owner" ? "Only an Owner can grant this" : "You can't grant this role") : d}</span></span>${checkSvg}</button>`; }).join("");
  $("u-roles").querySelectorAll("[data-r]:not([disabled])").forEach((b) => (b.onclick = () => { draftRole = b.dataset.r; renderRoles(); }));
}
function renderHotels() {
  const mine = STATE.hotels.filter((h) => STATE.me.hotels.includes(h.id));
  $("u-hotels").innerHTML = mine.map((h) => `<button type="button" class="rowline" data-h="${esc(h.id)}"><span>${esc(h.name)}${h.ready ? "" : "<small>Not set up yet</small>"}</span><span class="switch" aria-hidden="true" ${draftHotels.includes(h.id) ? 'style="background:#34C759"' : ""}><i ${draftHotels.includes(h.id) ? 'style="transform:translateX(20px)"' : ""}></i></span></button>`).join("");
  $("u-hotels").querySelectorAll("[data-h]").forEach((b) => (b.onclick = () => { const id = b.dataset.h; draftHotels = draftHotels.includes(id) ? draftHotels.filter((x) => x !== id) : [...draftHotels, id]; renderHotels(); }));
}
function showTemp(pw) { $("u-temp").textContent = pw; $("u-tempBox").hidden = false; }
$("u-copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("u-temp").textContent); toast("Copied"); }
  catch { const r = document.createRange(); r.selectNodeContents($("u-temp")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast("Selected. Copy it from here."); }
};
function openUser(id, preset) {
  eu = id ? STATE.users.find((u) => u.id === id) : null; const self = eu && eu.id === STATE.me.id;
  $("uTitle").textContent = eu ? eu.name : preset && preset.role === "GM" ? "Invite GM" : "Add Employee"; $("uSave").textContent = eu ? "Save" : "Create";
  $("u-name").value = eu ? eu.name : ""; $("u-username").value = eu ? eu.username : ""; $("u-email").value = eu && eu.email ? eu.email : "";
  draftRole = eu ? eu.role : (preset && preset.role) || "Front Desk"; draftHotels = eu ? [...eu.hotels] : (preset && preset.hotels) || [STATE.hotel];
  renderRoles(); renderHotels();
  const act = $("u-active"); act.setAttribute("aria-checked", eu ? eu.status !== "off" : true); act.disabled = !!self;
  $("u-activeNote").textContent = self ? "You can't turn off your own account." : "Turn off when someone leaves. Their question history stays.";
  $("u-reset").hidden = !eu; $("u-tempBox").hidden = true;
  $("u-hint").textContent = eu ? (eu.must_change_pw ? "They haven't set their own password yet." : "") : "You'll get a temporary password to give them. They set their own the first time they sign in.";
  showSheet("userEd");
}
$("u-reset").onclick = async () => {
  try { const r = await api(`/api/users/${eu.id}/reset`, { hotel: false, body: {} }); showTemp(r.tempPassword); $("u-hint").textContent = "Their old password and any open sessions no longer work."; } catch (e) { fail(e); }
};
$("userEd").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { name: $("u-name").value.trim(), username: $("u-username").value.trim().toLowerCase(), email: $("u-email").value.trim(), role: draftRole, hotels: draftHotels, status: $("u-active").getAttribute("aria-checked") === "true" ? "active" : "off" };
  try {
    if (eu) { await api(`/api/users/${eu.id}`, { hotel: false, method: "PUT", body }); toast("Saved " + body.name); hideSheet(); }
    else { const r = await api("/api/users", { hotel: false, body }); showTemp(r.tempPassword); $("u-hint").textContent = `${body.name} is set up. Sign-in: username ${body.username} with the temporary password above.`; $("uSave").textContent = "Done"; eu = { id: r.id, ...body }; }
    STATE.users = await api("/api/users", { hotel: false }); renderAdmin();
    if (mode === "owner") { await loadOwnerHotels(); renderOwner(); }
  } catch (x) { fail(x); }
});

/* ---------- setup flow, SOP switches, hotel details and hotel home ---------- */
const NOT_OFFERED = "not offered at this hotel";
const AMEN_LIST = ["breakfast", "pool", "pets", "laundry", "market"];
const AMEN_Q = {
  breakfast: ["Breakfast", "Do you serve breakfast?"],
  pool: ["Pool", "Do you have a pool?"],
  pets: ["Pets", "Do you allow pets?"],
  laundry: ["Laundry", "Is there a guest laundry room?"],
  market: ["Market", "Do you sell snacks at the front desk?"],
};
// Yes/no questions that only fill in hotel details (no SOPs switch on or off). Early check-in has no yes/no, just its three details.
const DQ_LIST = ["cash", "rollaways", "pack_and_plays", "connecting_rooms"];
const DQ_Q = {
  cash: ["Cash", "Does the front desk accept cash?"],
  rollaways: ["Rollaways", "Do you offer rollaways?"],
  pack_and_plays: ["Pack-and-plays", "Do you have pack-and-plays for guests?"],
  connecting_rooms: ["Connecting rooms", "Do you have connecting rooms?"],
};
const SEC_ORDER = ["Hotel identity", "Timing & policies", "Rooms", "Supplies & storage", "Tools & systems", "Other details"];
const SU = {
  hotel: null, data: null, view: "wizard", step: 0, ans: {}, det: {}, ov: { on: new Set(), off: new Set() },
  pick: "questions", from: null, open: new Set(), showAll: false, secOpen: new Set(["Timing & policies"]),
  saveP: Promise.resolve(), busy: false, focus: null, dirty: false,
};
const suView = () => (!hotelObj().ready ? "wizard" : location.hash === "#details" ? "details" : location.hash === "#kit" ? "kit" : "manage");
const suBrand = () => SU.data.hotel.brand;
const suFits = (m) => m.applies === "all" || suBrand() === "hilton";
const suSuggest = (m) => suFits(m) && (!m.requires || !!SU.ans[m.requires]);
// The same rule the server uses at go live: suggestion, then the GM's own switches. Hilton-only never turns on at an independent hotel.
const suOn = (m) => (SU.view === "manage" ? m.st === "live" : suFits(m) && (SU.ov.on.has(m.id) ? true : SU.ov.off.has(m.id) ? false : suSuggest(m)));
const suById = (id) => SU.data.sops.find((m) => m.id === id);
const suDet = (k) => String(SU.det[k] ?? "").trim();
// A value that still holds a [FILL: ...] prompt from the standard wording counts as not filled in yet.
const suFilled = (k) => !!suDet(k) && !/\[FILL/.test(suDet(k));
const suRun = (fn) => { const p = SU.saveP.then(fn); SU.saveP = p.catch(() => {}); return p; };
const sw = (on, label, attrs = "", dis = false) => `<button type="button" class="switch" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}" ${attrs} ${dis ? "disabled" : ""}><i></i></button>`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const titleList = (ids) => ids.map((m) => m.title).join(", ");

function setupHeader() {
  const h = hotelObj(), view = suView();
  $("setupTitle").textContent = view === "manage" ? "SOPs on and off" : view === "details" ? "Hotel details" : view === "kit" ? "Welcome kit" : h.name || "Set up";
  $("setupSub").textContent = view === "wizard" ? `Setting up · ${brandName(h)} · ${sysName(h)}` : `${h.name || ""} · ${brandName(h)} · ${sysName(h)}`;
  $("setupBack").lastChild.textContent = view === "wizard" ? "Hotels" : "Home";
  $("setupBack").hidden = view === "wizard" && !isOwner();
}
$("setupBack").onclick = async () => {
  if (suView() === "wizard") return go("owner");
  tab = "home";
  if (SU.dirty) { SU.dirty = false; try { await loadHotel(); } catch {} }
  go("admin");
};

async function suLoad() {
  const hid = STATE.hotel;
  const d = await api("/api/setup");
  if (hid !== STATE.hotel) return false;
  SU.data = d;
  SU.ans = {}; [...AMEN_LIST, ...DQ_LIST].forEach((k) => (SU.ans[k] = d.answers[k])); // undefined = not answered yet
  SU.det = { ...(d.details || {}) };
  SU.ov = { on: new Set(d.selection.on), off: new Set(d.selection.off) };
  if (d.copyFrom) { SU.pick = "copy"; SU.from = SU.from || d.copyFrom; }
  if (!SU.from && d.sources[0]) SU.from = d.sources[0].id;
  return true;
}

async function renderSetup(fresh) {
  setupHeader();
  if (SU.hotel !== STATE.hotel) { Object.assign(SU, { hotel: STATE.hotel, data: null, step: 0, open: new Set(), showAll: false, from: null, pick: "questions", busy: false }); fresh = true; WZ.crows = null; WZ.more = new Set(); WZ.pend = {}; WZ.pw = {}; }
  SU.view = suView();
  if (SU.view === "kit") { renderKit(); return; }
  if (fresh || !SU.data) {
    $("suBody").innerHTML = `<div class="group"><div class="empty">Loading…</div></div>`;
    try { if (!(await suLoad())) return; } catch (e) { fail(e); return; }
    if (SU.view === "wizard") { WZ.screen = wzStartScreen(); WZ.crows = null; WZ.prevPct = ((Math.max(wzIdx(WZ.screen), 0) + 1) / WZ_STEPS.length) * 100; }
  }
  paintSetup();
}

function paintSetup() {
  if (SU.view === "manage") paintReview();
  else if (SU.view === "details") paintDetails();
  else if (SU.view === "kit") renderKit();
  else paintWizard(false);
  // put keyboard focus back on the control that was just used (the wizard does this itself)
  if (SU.focus && SU.view !== "wizard") {
    const el = [...$("suBody").querySelectorAll("[data-f]")].find((e) => e.dataset.f === SU.focus);
    if (el) el.focus({ preventScroll: true });
    SU.focus = null;
  }
}

/* ----- details form pieces (used by step 2, the review side panel and Hotel details) ----- */
function fldHtml(df, opt = {}) {
  const long = (df.hint || "").length > 30;
  return `<label class="fld"><span>${esc(df.key)}</span><input data-k="${esc(df.key)}" value="${esc(SU.det[df.key] || "")}" placeholder="${long ? "" : esc(df.hint || "")}" autocomplete="off" autocapitalize="sentences">${long ? `<em class="fh">${esc(df.hint)}</em>` : ""}${opt.used ? `<em class="fh">Used in ${plural(opt.used, "SOP")}</em>` : ""}</label>`;
}
function saveDetail(k, v) {
  return suRun(() => api("/api/hotel/details", { method: "PUT", body: { merge: true, details: { [k]: v } } })).catch(fail);
}
function bindFields(root, onChange) {
  root.querySelectorAll("input[data-k]").forEach((i) => {
    i.oninput = () => { SU.det[i.dataset.k] = i.value; i.classList.remove("saved"); const sec = i.closest("[data-sec]"); if (sec) secCount(sec); };
    i.onchange = async () => { await saveDetail(i.dataset.k, i.value); i.classList.add("saved"); onChange && onChange(i); };
  });
}
function secCount(secEl) {
  const ins = [...secEl.querySelectorAll("input[data-k]")];
  const el = secEl.querySelector("[data-count]");
  if (el) el.textContent = `${ins.filter((i) => i.value.trim()).length} of ${ins.length}`;
}
// Collapsible block of fields. open state is remembered in SU.secOpen.
function secHtml(title, defs) {
  const open = SU.secOpen.has(title), filled = defs.filter((d) => suFilled(d.key)).length;
  const id = "sec-" + title.replace(/[^a-z]/gi, "");
  return `<div class="dsec group" data-sec="${esc(title)}"><button type="button" class="secbtn" aria-expanded="${open}" aria-controls="${id}" data-toggle="${esc(title)}"><span class="body"><span class="t">${esc(title)}</span><span class="m"><span data-count>${filled} of ${defs.length}</span> filled</span></span><svg class="chev ${open ? "dn" : ""}" viewBox="0 0 8 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 1.5 6.5 6.5 1.5 11.5"/></svg></button>
    <div class="form" id="${id}" ${open ? "" : "hidden"}>${defs.map((d) => fldHtml(d)).join("")}</div></div>`;
}
function bindSecs(root) {
  root.querySelectorAll("[data-toggle]").forEach((b) => (b.onclick = () => {
    const t = b.dataset.toggle, open = !SU.secOpen.has(t);
    open ? SU.secOpen.add(t) : SU.secOpen.delete(t);
    b.setAttribute("aria-expanded", open); b.nextElementSibling.hidden = !open; b.querySelector(".chev").classList.toggle("dn", open);
  }));
}
const generalSections = (defs) => SEC_ORDER.map((t) => [t, defs.filter((d) => !d.group && !d.q && d.section === t)]).filter(([, l]) => l.length);

// The yes/no detail questions and the early check-in fields, as one block each (setup step 2 and Hotel details).
function dqHtml(k) {
  const [name, q] = DQ_Q[k], yes = !!SU.ans[k], defs = (SU.data.qkeys[k] || []).map((key) => SU.data.detailDefs.find((d) => d.key === key)).filter(Boolean);
  return `<div class="amen" data-amen="${k}"><div class="amenhead"><span class="body"><b>${name}</b><small>${q}</small></span>
      <span class="yn" role="radiogroup" aria-label="${esc(q)}"><button type="button" role="radio" data-f="yn-${k}-yes" data-yn="yes" aria-checked="${yes}">Yes</button><button type="button" role="radio" data-f="yn-${k}-no" data-yn="no" aria-checked="${!yes}">No</button></span></div>
    ${defs.length ? `<p class="amennote">Filled in for you. Change anything that isn't right.</p><div class="form amenform" data-sec="${esc(name)}">${defs.map((x) => fldHtml(x)).join("")}</div>` : ""}</div>`;
}
function earlyHtml() {
  const defs = (SU.data.qkeys.early_checkin || []).map((key) => SU.data.detailDefs.find((d) => d.key === key)).filter(Boolean);
  if (!defs.length) return "";
  return `<div class="amen"><div class="amenhead"><span class="body"><b>Early check-in</b><small>When does an early check-in cost extra?</small></span></div>
    <div class="form amenform" data-sec="Early check-in">${defs.map((x) => fldHtml(x)).join("")}</div>
    <p class="amennote">Leave blank if you don't charge for early check-in. Staff will see "ask a manager" in that step until it's filled in.</p></div>`;
}
const policiesHtml = () => `<div class="sec"><span>Policies and cash</span></div><div class="group">${DQ_LIST.map(dqHtml).join("")}${earlyHtml()}</div>`;

async function setAnswer(k, yes) {
  if (SU.ans[k] === yes) return;
  if (DQ_LIST.includes(k)) return setDq(k, yes);
  return wzSetAnswer(k, yes);
}

// A detail question answered: the server fills the standard wording into empty details (typed text is kept). Works before and after go-live.
async function setDq(k, yes) {
  SU.ans[k] = yes; SU.focus = `yn-${k}-${yes ? "yes" : "no"}`;
  const after = SU.view === "details";
  const repaint = () => paintSetup();
  repaint();
  try {
    const r = await suRun(() => api(after ? "/api/hotel/answers" : "/api/setup/answers", { method: "PUT", body: { answers: { [k]: yes } } }));
    SU.det = { ...r.details }; SU.dirty = true;
    SU.focus = `yn-${k}-${yes ? "yes" : "no"}`; repaint();
  } catch (e) { fail(e); }
}

/* ----- step 3 and "SOPs on and off": categories with switches ----- */
async function suSet(ids, on) {
  const ms = ids.map(suById).filter((m) => m && (!on || suFits(m)));
  if (!ms.length) return;
  if (SU.view === "manage") {
    const prev = ms.map((m) => m.st);
    ms.forEach((m) => (m.st = on ? "live" : "off")); paintSetup();
    try { await suRun(() => api("/api/hotel/sops-toggle", { body: { ids: ms.map((m) => m.id), on } })); SU.dirty = true; }
    catch (e) { ms.forEach((m, i) => (m.st = prev[i])); paintSetup(); fail(e); }
    return;
  }
  for (const m of ms) {
    SU.ov.on.delete(m.id); SU.ov.off.delete(m.id);
    if (suSuggest(m) !== on) (on ? SU.ov.on : SU.ov.off).add(m.id);
  }
  paintSetup();
  wzTrack(suRun(() => api("/api/setup/selection", { method: "PUT", body: { on: [...SU.ov.on], off: [...SU.ov.off] } }))).catch(fail);
}

// The category list with switches: used by "SOPs on and off" and by the SOP summary on the Review screen.
function catRowsHtml() {
  const d = SU.data, sops = d.sops, manage = SU.view === "manage";
  const cats = d.cats.map((c) => ({ ...c, list: sops.filter((m) => m.cat === c.name) })).filter((c) => c.list.length);
  const reqName = (m) => (m.requires ? ` · Needs ${AMEN_Q[m.requires][0].toLowerCase()}` : "");
  return cats.map((c) => {
    const elig = c.list.filter(suFits), cOn = c.list.filter(suOn).length, all = elig.length && elig.every(suOn);
    const off = !elig.length, open = SU.open.has(c.name), id = "cat-" + c.prefix;
    const meta = off ? "Off: Hilton hotels only" : `${cOn} of ${c.list.length} on${elig.length < c.list.length ? ` · ${c.list.length - elig.length} Hilton only` : ""}`;
    return `<div class="catrow"><div class="cathead"><button type="button" class="catbtn" aria-expanded="${open}" aria-controls="${id}" data-cat="${esc(c.name)}" data-f="cat-${esc(c.name)}"><span class="body"><span class="t">${esc(c.name)}</span><span class="m ${off ? "offnote" : ""}">${meta}</span></span><svg class="chev ${open ? "dn" : ""}" viewBox="0 0 8 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 1.5 6.5 6.5 1.5 11.5"/></svg></button>${sw(all, `${c.name}: turn all ${all ? "off" : "on"}`, `data-catsw="${esc(c.name)}" data-f="catsw-${esc(c.name)}"`, off)}</div>
      <div class="sopRows" id="${id}" ${open ? "" : "hidden"}>${c.list.map((m) => {
        const fits = suFits(m);
        return `<div class="rowline"><span>${esc(m.title)}<small>${esc(m.id)}${reqName(m)}${fits ? "" : " · Off: Hilton hotels only"}${m.st === "draft" ? " · Draft" : ""}</small></span>${sw(suOn(m), m.title, `data-sopsw="${esc(m.id)}" data-f="sop-${esc(m.id)}"`, !fits)}</div>`;
      }).join("")}</div></div>`;
  }).join("");
}
function bindCatRows(body) {
  const sops = SU.data.sops;
  body.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => { const n = b.dataset.cat; SU.open.has(n) ? SU.open.delete(n) : SU.open.add(n); SU.focus = "cat-" + n; paintSetup(); }));
  body.querySelectorAll("[data-catsw]").forEach((b) => (b.onclick = () => {
    const n = b.dataset.catsw, elig = sops.filter((m) => m.cat === n && suFits(m));
    SU.focus = "catsw-" + n; suSet(elig.map((m) => m.id), !elig.every(suOn));
  }));
  body.querySelectorAll("[data-sopsw]").forEach((b) => (b.onclick = () => { const m = suById(b.dataset.sopsw); SU.focus = "sop-" + m.id; suSet([m.id], !suOn(m)); }));
}

// "SOPs on and off" on Hotel home (the setup review lives in setup.js).
function paintReview() {
  const d = SU.data, h = d.hotel, sops = d.sops, on = sops.filter(suOn).length;
  $("suBody").innerHTML = `<div class="sumbar" aria-live="polite"><b>${on}</b><span>of ${sops.length} SOPs are on</span></div>
    <div class="rvgrid"><div class="rvmain"><div class="sec" style="margin-top:6px"><span>Categories</span></div><div class="group" id="catList">${catRowsHtml()}</div>
      <p class="foot">Tap a category to switch single SOPs. ${h.brand === "hilton" ? "" : "Hilton-only SOPs stay off for independent hotels."} Changes save right away.</p></div></div>`;
  bindCatRows($("suBody"));
}

/* ----- Hotel details (all details, saved as you go) ----- */
function paintDetails() {
  const d = SU.data, defs = d.detailDefs;
  const amenSecs = AMEN_LIST.map((k) => [AMEN_Q[k][0], defs.filter((x) => x.group === k)]).filter(([, l]) => l.length);
  const all = [...generalSections(defs), ...amenSecs];
  $("suBody").innerHTML = `<p class="hint" style="margin-top:6px">These fill the {Detail name} gaps in your SOPs. Changes save as you go and every SOP updates. Leave blank if you don't know; staff see "ask a manager".</p>
    ${policiesHtml()}
    ${all.map(([t, l]) => secHtml(t, l)).join("")}`;
  bindSecs($("suBody"));
  bindFields($("suBody"), () => toast("Saved"));
  $("suBody").querySelectorAll("[data-yn]").forEach((b) => (b.onclick = () => setAnswer(b.closest("[data-amen]").dataset.amen, b.dataset.yn === "yes")));
}

/* ----- Hotel home ----- */
const CHANGED = { title: "title", category: "category", steps: "steps", script: "what to say", flag: "when to call a manager", keywords: "search words" };
async function renderHome() {
  const box = $("homeBody");
  if (!hotelObj().ready) {
    box.innerHTML = `<div class="group"><div class="empty"><b>${esc(hotelName(STATE.hotel))} is still being set up</b><br>Finish setup to open it to staff.</div></div><button type="button" class="bigbtn press" id="homeSetup">Continue setup</button>`;
    $("homeSetup").onclick = () => go("chat");
    return;
  }
  if (!STATE.home) box.innerHTML = `<div class="group"><div class="empty">Loading…</div></div>`;
  const hid = STATE.hotel;
  try { const h = await api("/api/home"); if (hid !== STATE.hotel || tab !== "home") return; STATE.home = h; } catch (e) { fail(e); return; }
  paintHome();
}
function paintHome() {
  const H = STATE.home, box = $("homeBody");
  const ups = H.updates, fresh = H.fresh, pending = ups.filter((u) => !u.kept);
  const sys = H.system === "pep" ? "PEP" : "HotelKey";
  const upRows = ups.map((u) => `<div class="cell upd" data-sop="${esc(u.sopId)}"><span class="body"><span class="t wrap">${esc(u.title)}</span><span class="m wrapm">${esc(u.sopId)} · v${u.have} to v${u.latest} · ${u.relevant ? (u.changed.length ? "Changed: " + esc(u.changed.map((k) => CHANGED[k] || k).join(", ")) : "Updated") : "No change to what your staff see"}${u.kept ? " · You edited this one" : ""}${u.status === "off" ? " · Off at your hotel" : ""}</span></span>
      <span class="acts"><button type="button" class="pillbtn press" data-keep="${esc(u.sopId)}">Keep mine</button><button type="button" class="pillbtn tint press" data-accept="${esc(u.sopId)}">Accept</button></span></div>`).join("");
  const newRows = fresh.map((m) => `<div class="cell upd" data-new="${esc(m.id)}"><span class="body"><span class="t wrap">New from Lotus: ${esc(m.title)}</span><span class="m wrapm">${esc(m.id)} · ${esc(m.cat)}</span></span>
      <span class="acts"><button type="button" class="pillbtn press" data-skip="${esc(m.id)}">Skip</button><button type="button" class="pillbtn tint press" data-add="${esc(m.id)}">Add</button></span></div>`).join("");
  box.innerHTML = `<div class="statusline"><span class="status ok">Live</span><span><b>${plural(H.counts.live, "SOP")} on</b> · ${H.counts.off} off · ${sys}</span></div>
    <div class="sec"><span>Updates from Lotus</span>${pending.length > 1 ? `<button type="button" id="acceptAll">Accept all (${pending.length})</button>` : ""}</div>
    <div class="group">${upRows || `<div class="empty">You're up to date with Lotus.</div>`}</div>
    ${fresh.length ? `<div class="sec"><span>New from Lotus</span></div><div class="group">${newRows}</div>` : ""}
    <div class="sec"><span>Manage this hotel</span></div>
    <div class="htiles">
      <button type="button" class="htile press" data-go="manage"><span class="hl">SOPs on and off</span><strong>${H.counts.live} <small>on</small> · ${H.counts.off} <small>off</small></strong><span class="hs">Switch categories or single SOPs</span></button>
      <button type="button" class="htile press" data-go="details"><span class="hl">Hotel details</span><strong>${H.details.filled} <small>of ${H.details.total} filled</small></strong><span class="hs">Hours, fees, locations used in SOPs</span></button>
      <button type="button" class="htile press" data-go="contacts"><span class="hl">Contacts</span><strong>${H.contacts} <small>${H.contacts === 1 ? "person" : "people"}</small></strong><span class="hs">Who staff call</span></button>
      <button type="button" class="htile press" data-go="newsop"><span class="hl">Add a hotel-only SOP</span><strong>New</strong><span class="hs">Write a procedure only this hotel uses</span></button>
      <button type="button" class="htile press" data-go="kit"><span class="hl">Welcome kit</span><strong>Print</strong><span class="hs">Desk card, QR code, Home Screen steps, staff logins</span></button>
      <button type="button" class="htile press" data-go="import"><span class="hl">Import SOPs</span><strong>Import</strong><span class="hs">From a PDF, Word, Excel or text file, as drafts</span></button>
    </div>
    <p class="foot">Accept replaces your copy with Lotus's latest wording. Keep mine leaves your copy as it is.</p>`;
  const done = async (fn, msg) => { try { await fn(); toast(msg); STATE.home = null; await loadHotel(); renderAdmin(); } catch (e) { fail(e); } };
  box.querySelectorAll("[data-accept]").forEach((b) => (b.onclick = () => done(() => api(`/api/updates/${encodeURIComponent(b.dataset.accept)}/accept`, { body: {} }), "Accepted the update")));
  box.querySelectorAll("[data-keep]").forEach((b) => (b.onclick = () => done(() => api(`/api/updates/${encodeURIComponent(b.dataset.keep)}/keep`, { body: {} }), "Kept yours")));
  box.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => done(() => api(`/api/updates/new/${encodeURIComponent(b.dataset.add)}/add`, { body: {} }), "Added. Staff can ask about it now")));
  box.querySelectorAll("[data-skip]").forEach((b) => (b.onclick = () => done(() => api(`/api/updates/new/${encodeURIComponent(b.dataset.skip)}/skip`, { body: {} }), "Skipped. It's in your Off list if you change your mind")));
  const aa = $("acceptAll");
  if (aa) aa.onclick = () => done(async () => { for (const u of pending) await api(`/api/updates/${encodeURIComponent(u.sopId)}/accept`, { body: {} }); }, "Accepted all updates");
  box.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => {
    const g = b.dataset.go;
    if (g === "manage" || g === "details" || g === "kit") { SU.step = 0; WZ.celebrate = false; go(g); }
    else if (g === "contacts") { tab = "contacts"; renderAdmin(true); }
    else if (g === "import") openImport(STATE.hotel);
    else openSop(null);
  }));
}

$("toSetup").onclick = () => go("chat");

/* ---------- owner: hotels and master library ---------- */
let ownerTab = "hotels", mFilter = "all";
const OTABS = [["hotels", "Hotels"], ["master", "Master library"], ["import", "Import"]];
$("ownerBtn").onclick = () => { closeMenus(); go(mode === "owner" ? "admin" : "owner"); };

async function loadOwnerHotels() { STATE.owner.hotels = await api("/api/owner/hotels", { hotel: false }); }
async function loadMaster() { STATE.owner.master = await api("/api/master", { hotel: false }); }

async function renderOwner(refresh) {
  if (!isOwner()) return;
  $("ownerTabs").innerHTML = OTABS.map(([k, l]) => `<button type="button" role="tab" class="press" data-t="${k}" aria-pressed="${k === ownerTab}">${l}</button>`).join("");
  $("ownerTabs").querySelectorAll("button").forEach((b) => (b.onclick = () => { ownerTab = b.dataset.t; renderOwner(); }));
  $("ownerHotels").hidden = ownerTab !== "hotels"; $("ownerMaster").hidden = ownerTab !== "master"; $("ownerImport").hidden = ownerTab !== "import";
  $("ownerTitle").textContent = { hotels: "Hotels", master: "Master library", import: "Import" }[ownerTab];
  $("ownerSub").textContent = { hotels: "Every Lotus hotel in one place", master: "The source every hotel's procedures start from", import: "Bring in procedures from your own documents" }[ownerTab];
  if (ownerTab === "import") { renderImport(); return; }
  try {
    if (ownerTab === "hotels" && (refresh || !STATE.owner.hotels)) await loadOwnerHotels();
    if (ownerTab === "master" && (refresh || !STATE.owner.master)) await loadMaster();
  } catch (e) { fail(e); }
  if (ownerTab === "hotels") renderHotelCards(); else renderMasterList();
}

/* ----- hotels ----- */
function renderHotelCards() {
  const hs = STATE.owner.hotels;
  if (!hs) { $("hotelCards").innerHTML = ""; return; }
  const pill = (h) => h.setup === "live" ? `<span class="status ok">Live</span>` : h.setup === "setup" ? `<span class="status invited">Setting up</span>` : `<span class="status off">Not started</span>`;
  $("hotelCount").textContent = `${hs.length} hotel${hs.length === 1 ? "" : "s"}`;
  $("hotelCards").innerHTML = hs.map((h) => {
    const gms = h.gms.filter((g) => g.status === "active");
    return `<div class="hcard" data-id="${esc(h.id)}">
      <div class="hhead"><span class="hname">${esc(h.name)}</span>${pill(h)}</div>
      <div class="hsub">${brandName(h)} · ${sysName(h)}</div>
      <dl class="hstats">
        <div><dt>SOPs live</dt><dd>${h.live} <small>of ${h.total}</small></dd></div>
        <div><dt>${gms.length === 1 ? "GM" : "GMs"}</dt><dd class="gm">${gms.length ? gms.map((g) => esc(g.name) + (g.must_change_pw ? ' <small>invited</small>' : "")).join(", ") : '<small>None yet</small>'}</dd></div>
        ${h.pending ? `<div><dt>Updates</dt><dd>${h.pending} <small>waiting</small></dd></div>` : ""}
      </dl>
      ${h.setup === "live" ? "" : `<div data-prog="${esc(h.id)}">${ownerProgressHtml(h)}</div>`}
      <div class="acts"><button type="button" class="pillbtn press" data-open="${esc(h.id)}">Open hotel</button><button type="button" class="pillbtn tint press" data-gm="${esc(h.id)}">Invite GM</button>${h.setup === "live" ? "" : `<button type="button" class="pillbtn press" data-remind="${esc(h.id)}">Copy reminder</button>`}</div>
    </div>`;
  }).join("");
  $("hotelCards").querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => selectHotel(b.dataset.open, "admin")));
  $("hotelCards").querySelectorAll("[data-gm]").forEach((b) => (b.onclick = () => openUser(null, { role: "GM", hotels: [b.dataset.gm] })));
  $("hotelCards").querySelectorAll(".hcard").forEach(wzBindCopy);
  loadOwnerProgress();
}

let draftBrand = "independent", draftSystem = "hotelkey";
function radios(el, opts, cur, pick) {
  el.innerHTML = opts.map(([v, l, d]) => `<button type="button" class="radio" role="radio" data-v="${v}" aria-checked="${v === cur}"><span class="body" style="flex:1"><span style="display:block;font-weight:500">${l}</span><span style="font-size:.8rem;color:var(--label2)">${d}</span></span>${checkSvg}</button>`).join("");
  el.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => pick(b.dataset.v)));
}
function renderHotelPick() {
  radios($("h-brand"), [["hilton", "Hilton", "Hilton brand standards apply"], ["independent", "Independent", "Lotus brand, no franchise standards"]], draftBrand, (v) => { draftBrand = v; renderHotelPick(); });
  radios($("h-system"), [["pep", "PEP", "Hilton's name for HotelKey NextGen"], ["hotelkey", "HotelKey", "Front desk says HotelKey"]], draftSystem, (v) => { draftSystem = v; renderHotelPick(); });
}
$("newHotel").onclick = () => { $("h-name").value = ""; draftBrand = "independent"; draftSystem = "hotelkey"; renderHotelPick(); showSheet("hotelEd"); setTimeout(() => $("h-name").focus(), 380); };
$("hotelEd").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { name: $("h-name").value.trim(), brand: draftBrand, system: draftSystem };
  if (!body.name) { $("h-name").focus(); toast("Add the hotel's name"); return; }
  try {
    await api("/api/owner/hotels", { hotel: false, body });
    hideSheet(); await Promise.all([loadOwnerHotels(), refreshMe()]); renderOwner(); toast(`Added ${body.name}`);
  } catch (x) { fail(x); }
});

/* ----- master library ----- */
const AMEN = { breakfast: "Breakfast", pool: "Pool", pets: "Pets", laundry: "Laundry", market: "Market" };
const M_FILTERS = [
  ["all", "All", () => true],
  ["every", "Every hotel", (m) => m.applies === "all" && !m.requires],
  ["hilton", "Hilton and PEP only", (m) => m.applies === "hilton"],
  ["amen", "Depends on amenities", (m) => !!m.requires],
  ["hk", "PEP and HotelKey versions", (m) => m.hk_status !== "same"],
  ["review", "HotelKey needs review", (m) => m.hk_status === "draft"],
  ["draft", "Drafts", (m) => m.status === "draft"],
];
const mTags = (m) => [
  m.status === "draft" ? `<span class="mtag warn">Draft</span>` : "",
  m.applies === "hilton" ? `<span class="mtag">Hilton only</span>` : "",
  m.requires ? `<span class="mtag">${AMEN[m.requires]}</span>` : "",
  m.hk_status === "draft" ? `<span class="mtag warn">HotelKey to review</span>` : m.hk_status === "approved" ? `<span class="mtag hk">HotelKey approved</span>` : "",
].join("");
function renderMasterList() {
  const M = STATE.owner.master;
  if (!M) { $("masterList").innerHTML = `<div class="empty">Loading…</div>`; return; }
  $("masterFilters").innerHTML = M_FILTERS.map(([k, l, fn]) => `<button type="button" class="press" data-f="${k}" aria-pressed="${k === mFilter}">${l}<span class="cnt">${M.sops.filter(fn).length}</span></button>`).join("");
  $("masterFilters").querySelectorAll("button").forEach((b) => (b.onclick = () => { mFilter = b.dataset.f; renderMasterList(); }));
  const fn = M_FILTERS.find((f) => f[0] === mFilter)[2], f = norm($("mFilter").value);
  const rows = M.sops.filter((m) => fn(m) && (!f || norm(m.title + " " + m.kw + " " + m.id + " " + m.cat).includes(f)))
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  $("masterCount").textContent = rows.length + " SOP" + (rows.length === 1 ? "" : "s");
  $("masterList").innerHTML = rows.length ? rows.map((m) => `<button type="button" class="cell" data-m="${esc(m.id)}"><span class="dot ${m.status === "draft" || m.hk_status === "draft" ? "draft" : "live"}"></span>
    <span class="body"><span class="t">${esc(m.title)}</span><span class="m">${esc(m.id)} · v${m.ver} · ${esc(m.cat)}</span>${mTags(m) ? `<span class="mtags">${mTags(m)}</span>` : ""}</span>${chev}</button>`).join("") : `<div class="empty">No SOPs match.</div>`;
  $("masterList").querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => openMaster(b.dataset.m)));
  const det = M.details;
  $("masterDetailsSec").hidden = !det.length;
  $("masterDetails").innerHTML = det.map((d) => `<div class="cell"><span class="body"><span class="t"><span class="tokchip">${esc(d.key)}</span></span><span class="m">${d.example ? "e.g. " + esc(d.example) + " · " : ""}Used in ${d.uses} SOP${d.uses === 1 ? "" : "s"}</span></span></div>`).join("");
}
$("mFilter").oninput = () => renderMasterList();
$("newMaster").onclick = () => (STATE.settings.aiOn ? authorOpen({ target: "master", from: "list" }) : openMaster(null));

let em = null, mDraft = null, mView = "pep", mSaving = false;
const mSeg = Seg($("mView"), (v) => { mView = v; mSeg(v); renderMasterView(); });
const chipify = (t) => esc(t).replace(/\{([^}]+)\}/g, '<span class="tokchip">$1</span>');
function openMaster(id, preset) {
  const M = STATE.owner.master;
  em = id ? M.sops.find((m) => m.id === id) : null;
  mDraft = em ? { steps: em.steps.map((s) => ({ t: s.t, hk: s.hk ?? null, img: s.img || null })) } : { steps: [{ t: "", hk: null, img: null }] };
  $("mTitleBar").textContent = em ? em.id : "New master SOP";
  paintMasterStatus();
  $("m-title").value = em ? em.title : "";
  $("m-cat").innerHTML = M.cats.map((c) => `<option>${esc(c.name)}</option>`).join("");
  $("m-cat").value = em ? em.cat : M.cats[0].name;
  $("m-applies").value = em ? em.applies : "all";
  $("m-requires").value = em && em.requires ? em.requires : "";
  $("m-script").value = em ? em.script : ""; $("m-script-hk").value = em && em.script_hk ? em.script_hk : "";
  $("m-flag").value = em ? em.flag : ""; $("m-flag-hk").value = em && em.flag_hk ? em.flag_hk : "";
  $("m-kw").value = em ? em.kw : "";
  mView = "pep";
  $("mAi").hidden = !STATE.settings.aiOn;
  showSheet("masterEd"); mSeg("pep", false); renderMasterView();
  if (preset) fillMasterEditor(preset);
}
// Puts an AI draft into the open master editor. HotelKey wording is kept for steps whose PEP text did not change.
function fillMasterEditor(p) {
  const old = mDraft.steps, M = STATE.owner.master;
  const steps = (p.steps || []).map((x) => { const o = old.find((y) => y.t === x.t); return { t: x.t, hk: o ? o.hk : null, img: x.img || null }; });
  const dropped = old.filter((o) => o.hk && !steps.some((x) => x.hk === o.hk)).length;
  mDraft.steps = steps.length ? steps : [{ t: "", hk: null, img: null }];
  $("m-title").value = p.title || "";
  if (p.category && M.cats.some((c) => c.name === p.category)) $("m-cat").value = p.category;
  if ((p.script || "") !== $("m-script").value.trim()) $("m-script-hk").value = "";
  if ((p.flag || "") !== $("m-flag").value.trim()) $("m-flag-hk").value = "";
  $("m-script").value = p.script || ""; $("m-flag").value = p.flag || ""; $("m-kw").value = p.kw || "";
  mView = "pep"; mSeg("pep", false); renderMasterView();
  if (dropped) toast(`HotelKey wording was cleared on ${dropped} step${dropped === 1 ? "" : "s"} you changed. Check the HotelKey tab.`);
}
$("mAi").onclick = () => authorOpen({
  target: "master", from: "editor", sopId: em ? em.id : null,
  seed: { title: $("m-title").value.trim(), category: $("m-cat").value, steps: mDraft.steps.filter((x) => (x.t || "").trim() || x.img).map((x) => ({ t: (x.t || "").trim(), img: x.img })), script: $("m-script").value.trim(), flag: $("m-flag").value.trim(), kw: $("m-kw").value.trim() },
});
// Draft or live: drafts are not offered to hotels until published.
function paintMasterStatus() {
  const draft = !!em && em.status === "draft";
  $("mStatusState").innerHTML = !em ? `<span class="status draft">Draft</span>` : draft ? `<span class="status draft">Draft</span>` : `<span class="status ok">Live</span>`;
  $("mStatusHint").textContent = !em
    ? "New SOPs start as drafts. Save it, finish writing, then publish it when it is ready for hotels."
    : draft ? "Hotels can't see this yet. Publish it to offer it to every hotel as New from Lotus." : "Offered to hotels. Edits show up as updates they can accept or keep their own wording.";
  $("mPublish").hidden = !draft;
}
function renderMasterView() {
  const hk = mView === "hk";
  stepEditor($("mSteps"), mDraft.steps, { field: hk ? "hk" : "t", focus: mDraft.focus, onInput: renderMasterPreview, redraw: (i) => { mDraft.focus = i; renderMasterView(); mDraft.focus = null; } });
  $("m-script").closest(".fld").hidden = hk; $("m-flag").closest(".fld").hidden = hk;
  $("m-script-hk").closest(".fld").hidden = !hk; $("m-flag-hk").closest(".fld").hidden = !hk;
  $("mViewHint").textContent = hk
    ? "This is what a HotelKey hotel's front desk reads. Leave a step blank to use the PEP wording."
    : "The default wording. Hilton hotels that say PEP use this, and so does any HotelKey step left blank.";
  const st = em ? em.hk_status : "same";
  $("mHkRow").hidden = !em;
  $("mHkState").innerHTML = st === "draft" ? `<span class="status draft">Needs review</span>` : st === "approved" ? `<span class="status ok">Approved</span>` : `<span class="status off">Same as PEP</span>`;
  $("mApprove").hidden = st !== "draft";
  renderMasterPreview();
  growAll();
}
function renderMasterPreview() {
  const hk = mView === "hk";
  const pick = (t, h) => (hk && h ? h : t);
  const lines = mDraft.steps.filter((s) => s.t || s.img).map((s, i) => `<div class="prevLine"><b>${i + 1}</b><span>${chipify(pick(s.t, s.hk))}</span></div>`);
  const sc = hk ? $("m-script-hk").value || $("m-script").value : $("m-script").value, fl = hk ? $("m-flag-hk").value || $("m-flag").value : $("m-flag").value;
  if (sc) lines.push(`<div class="prevLine"><b>Say</b><span>${chipify(sc)}</span></div>`);
  if (fl) lines.push(`<div class="prevLine"><b>Call</b><span>${chipify(fl)}</span></div>`);
  $("mPreview").innerHTML = lines.join("") || `<div class="empty">Nothing yet.</div>`;
}
["m-script", "m-script-hk", "m-flag", "m-flag-hk"].forEach((id) => ($(id).oninput = () => renderMasterPreview()));
$("mAddStep").onclick = () => { mDraft.steps.push({ t: "", hk: null, img: null }); mDraft.focus = mDraft.steps.length - 1; renderMasterView(); mDraft.focus = null; };
$("mPublish").onclick = async () => {
  if (!em || em.status !== "draft") return;
  if (!confirm(`Publish ${em.id} to hotels? Every hotel it fits will see it as New from Lotus.`)) return;
  try {
    const out = await api(`/api/master/${encodeURIComponent(em.id)}/publish`, { hotel: false, body: {} });
    Object.assign(em, out); paintMasterStatus(); renderMasterList(); loadOwnerHotels().catch(() => {}); toast(`${em.id} published to hotels`);
  } catch (e) { fail(e); }
};
$("mApprove").onclick = async () => {
  if (!em) return;
  try {
    const out = await api(`/api/master/${encodeURIComponent(em.id)}/approve-hk`, { hotel: false, body: {} });
    Object.assign(em, out); renderMasterView(); renderMasterList(); toast("HotelKey wording approved");
  } catch (e) { fail(e); }
};
$("masterEd").addEventListener("submit", async (e) => {
  e.preventDefault(); if (mSaving) return;
  const d = {
    title: $("m-title").value.trim(), cat: $("m-cat").value,
    steps: mDraft.steps.map((s) => ({ t: (s.t || "").trim(), hk: (s.hk || "").trim() || null, img: s.img })).filter((s) => s.t || s.img),
    script: $("m-script").value.trim(), script_hk: $("m-script-hk").value.trim() || null,
    flag: $("m-flag").value.trim(), flag_hk: $("m-flag-hk").value.trim() || null,
    kw: $("m-kw").value.trim(), applies: $("m-applies").value, requires: $("m-requires").value || null,
  };
  if (!d.title) { $("m-title").focus(); toast("Add a title"); return; }
  if (!d.steps.length) { toast("Add at least one step"); return; }
  mSaving = true;
  try {
    const out = em ? await api(`/api/master/${encodeURIComponent(em.id)}`, { hotel: false, method: "PUT", body: d }) : await api("/api/master", { hotel: false, body: d });
    const M = STATE.owner.master;
    if (em) Object.assign(em, out); else M.sops.push(out);
    toast(`Saved ${out.id}${out.status === "draft" ? " as a draft" : ` v${out.ver}`}${out.hotelsWithUpdate ? ` · ${out.hotelsWithUpdate} hotel${out.hotelsWithUpdate === 1 ? " has" : "s have"} an update` : ""}`);
    hideSheet(); renderMasterList(); loadOwnerHotels().catch(() => {});
  } catch (x) { fail(x); }
  mSaving = false;
});

/* ---------- import: documents and spreadsheet -> review -> drafts ---------- */
const IMP = { target: null, info: null, batch: null, list: [], files: [], busy: "", group: "matches", open: new Set(), pick: {} };
const IMP_TYPES = [".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md"];
const impEl = () => (isOwner() ? $("ownerImport") : $("impBody"));
const impTargetName = (t) => (t === "master" ? "the master library" : hotelName(t));

// Opens Import for a hotel (GM, or the Owner coming from a hotel's setup or home).
function openImport(hotelId) {
  IMP.target = hotelId; IMP.batch = null; IMP.files = [];
  if (isOwner()) ownerTab = "import";
  go("import");
}
$("impBack").onclick = () => go(hotelObj().ready ? "admin" : "chat");

async function renderImport() {
  if (!isGM()) return;
  const box = impEl();
  const t = isOwner() ? IMP.target || "master" : STATE.hotel;
  if (IMP.target !== t) { IMP.target = t; IMP.batch = null; IMP.files = []; }
  $("impBack").lastElementChild.textContent = hotelObj().ready ? "Home" : "Setup";
  $("impSub").textContent = isOwner() ? "" : `${hotelName(STATE.hotel)} only`;
  if (!IMP.info) box.innerHTML = `<div class="group"><div class="empty">Loading…</div></div>`;
  try {
    const [info, list] = await Promise.all([api("/api/import/info", { hotel: false }), api(`/api/imports?target=${encodeURIComponent(IMP.target)}`, { hotel: false })]);
    IMP.info = info; IMP.list = list;
  } catch (e) { fail(e); return; }
  paintImport();
}

function paintImport() { if (IMP.batch) paintImpReview(); else paintImpStart(); }

const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

function paintImpStart() {
  const box = impEl(), I = IMP.info;
  const targets = isOwner() ? [["master", "Master library", "Every hotel starts from it. Changes reach hotels as updates."], ...I.hotels.map((h) => [h.id, `${h.name} only`, "Hotel-only procedures, added as drafts"])] : [];
  const files = IMP.files;
  box.innerHTML = `
    ${isOwner() ? `<div class="sec"><span>Import into</span></div><div class="group" id="impTargets" role="radiogroup" aria-label="Import into"></div>`
      : `<p class="hint" style="margin-top:14px">Importing into <b>${esc(hotelName(STATE.hotel))}</b> only. Everything arrives as a draft. Nothing goes live until you switch it on.</p>`}
    <div class="sec"><span>Upload documents</span></div>
    <div class="group"><div class="cell imp">
      <span class="body"><span class="t wrap">Read my binder, SOP files or checklists</span><span class="m wrapm">PDF, Word, Excel, CSV or text. Up to ${I.maxFiles} files, ${I.maxMb} MB each. We sort what we find into what you already have, new procedures and hotel details. You review everything first.</span></span>
      ${files.length ? `<div class="impfiles">${files.map((f, i) => `<span class="impfile"><span>${esc(f.name)} <small>${fmtSize(f.size)}</small></span><button type="button" class="iconbtn del" data-rm="${i}" aria-label="Remove ${esc(f.name)}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg></button></span>`).join("")}</div>` : ""}
      <div class="acts"><button type="button" class="pillbtn press" id="impPick" ${IMP.busy ? "disabled" : ""}>${files.length ? "Change files" : "Choose files"}</button>
      <button type="button" class="pillbtn tint press" id="impRead" ${!files.length || IMP.busy || !I.aiOn ? "disabled" : ""}>${IMP.busy === "ai" ? "Reading…" : "Read documents"}</button></div>
      ${IMP.busy === "ai" ? `<span class="m wrapm"><span class="spin"></span> Reading your files. This can take a minute.</span>` : ""}
      ${!I.aiOn ? `<span class="m wrapm no">Reading documents needs an AI key, and none is set up yet. ${isOwner() ? "Add one in Settings, or" : "Ask the Owner to add one, or"} use the spreadsheet below.</span>` : ""}
      <input type="file" id="impFile" multiple accept="${IMP_TYPES.join(",")}" hidden>
    </div></div>
    <div class="sec"><span>Spreadsheet</span></div>
    <div class="group"><div class="cell imp">
      <span class="body"><span class="t wrap">Fill in our template</span><span class="m wrapm">One row per procedure: title, category, up to 12 steps, what to say, when to call a manager. No AI needed. Rows with a title you already have are flagged.</span></span>
      <div class="acts"><a class="pillbtn press" href="/api/import/template.xlsx" download>Download template</a>
      <button type="button" class="pillbtn tint press" id="impSheet" ${IMP.busy ? "disabled" : ""}>${IMP.busy === "sheet" ? "Reading…" : "Upload spreadsheet"}</button></div>
      <input type="file" id="impSheetFile" accept=".xlsx,.csv" hidden>
    </div></div>
    <div class="sec"><span>Earlier imports</span></div>
    <div class="group">${IMP.list.length ? IMP.list.map((b) => `<button type="button" class="cell press" data-batch="${b.id}"><span class="body"><span class="t">${esc(b.files.join(", "))}</span><span class="m">${b.status === "done" ? "All handled" : `${b.open} of ${b.total} left to review`} · ${fmtDT(b.created)}${b.by ? " · " + esc(b.by) : ""}</span></span>${chev}</button>`).join("") : `<div class="empty">Nothing imported yet.</div>`}</div>
    <p class="foot">Imported procedures start as drafts that need approval. Nothing goes live by itself.</p>`;
  if (isOwner()) {
    radios($("impTargets"), targets, IMP.target, (v) => { IMP.target = v; IMP.batch = null; renderImport(); });
  }
  $("impPick").onclick = () => $("impFile").click();
  $("impFile").onchange = (e) => {
    const picked = [...e.target.files];
    const bad = picked.find((f) => !IMP_TYPES.includes("." + f.name.split(".").pop().toLowerCase()) || f.size > I.maxMb * 1048576);
    if (picked.length > I.maxFiles) return toast(`Choose up to ${I.maxFiles} files`);
    if (bad) return toast(`${bad.name}: use PDF, Word, Excel, CSV or text under ${I.maxMb} MB`);
    IMP.files = picked; paintImpStart();
  };
  box.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { IMP.files.splice(+b.dataset.rm, 1); paintImpStart(); }));
  $("impRead").onclick = () => impSend("ai");
  $("impSheet").onclick = () => $("impSheetFile").click();
  $("impSheetFile").onchange = (e) => { if (e.target.files[0]) impSend("sheet", e.target.files[0]); };
  box.querySelectorAll("[data-batch]").forEach((b) => (b.onclick = async () => {
    try { IMP.batch = await api(`/api/import/${b.dataset.batch}`, { hotel: false }); IMP.group = firstOpenGroup(); IMP.open = new Set(); paintImpReview(); scrollTo(0, 0); } catch (x) { fail(x); }
  }));
}

const readDataUrl = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error(`Couldn't read ${f.name}`)); r.readAsDataURL(f); });

async function impSend(kind, one) {
  if (IMP.busy) return;
  const target = IMP.target;
  IMP.busy = kind; paintImpStart();
  try {
    let batch;
    if (kind === "ai") {
      const files = await Promise.all(IMP.files.map(async (f) => ({ name: f.name, data: await readDataUrl(f) })));
      batch = await api("/api/import/upload", { hotel: false, body: { target, files } });
    } else {
      batch = await api("/api/import/sheet", { hotel: false, body: { target, file: { name: one.name, data: await readDataUrl(one) } } });
    }
    IMP.busy = ""; IMP.files = []; IMP.batch = batch; IMP.open = new Set(); IMP.group = firstOpenGroup();
    paintImpReview(); scrollTo(0, 0);
  } catch (e) { IMP.busy = ""; if (IMP.target === target) paintImpStart(); fail(e); }
}

const firstOpenGroup = () => ["matches", "new", "details"].find((g) => IMP.batch[g].some((x) => !x.state)) || ["matches", "new", "details"].find((g) => IMP.batch[g].length) || "new";
const STATE_TEXT = { kept: "Kept ours", used: "Used theirs", added: "Added as a draft", applied: "Saved", skipped: "Skipped" };

const olSteps = (steps, id, clamp) => `<ol class="${clamp ? "clamp" : ""}">${steps.map((t) => `<li>${chipify(t)}</li>`).join("")}</ol>${clamp && steps.length > 3 ? `<button type="button" class="inlinebtn" data-more="${id}">Show all ${steps.length}</button>` : ""}`;

function paintImpReview() {
  const box = impEl(), B = IMP.batch, g = IMP.group, master = B.target === "master";
  const counts = { matches: B.matches.filter((x) => !x.state).length, new: B.new.filter((x) => !x.state).length, details: B.details.filter((x) => !x.state).length };
  const label = { matches: "Already in the library", new: "New procedures", details: "Hotel details found" };
  const notes = [];
  if (B.meta.truncated) notes.push("The documents were longer than we can read at once, so only the first part was used. Split them and import the rest separately.");
  if (B.meta.failedParts) notes.push(`${B.meta.failedParts} of ${B.meta.parts} parts couldn't be read, so some procedures may be missing.`);
  if (B.meta.emptyFiles && B.meta.emptyFiles.length) notes.push(`No text found in: ${B.meta.emptyFiles.join(", ")}.`);
  if (B.meta.examples) notes.push(`${B.meta.examples} example row${B.meta.examples === 1 ? "" : "s"} ignored.`);
  if (B.meta.skippedCount) notes.push(`${B.meta.skippedCount} row${B.meta.skippedCount === 1 ? "" : "s"} skipped: ${(B.meta.skipped || []).slice(0, 5).map((s) => `row ${s.row}${s.title ? " (" + esc(s.title) + ")" : ""} ${esc(s.reason.toLowerCase())}`).join("; ")}${B.meta.skippedCount > 5 ? "…" : ""}.`);
  const list = B[g];
  const stateTag = (x) => (x.state ? `<span class="mtag">${STATE_TEXT[x.state]}${x.state === "added" && x.sop_id ? " · " + esc(x.sop_id) : ""}${x.state === "applied" && x.hotel ? " · " + esc(hotelName(x.hotel)) : ""}</span>` : "");
  let body = "";
  if (g === "matches") {
    body = B.matches.map((m) => {
      const k = "m" + m.i, full = IMP.open.has(k), ours = m.ours;
      return `<div class="cell imp ${m.state ? "done" : ""}">
        <div class="hd"><span class="body"><span class="t wrap">${esc(ours ? ours.title : m.title)}</span><span class="m wrapm">${esc(m.sop_id)}${m.difference ? " · " + esc(m.difference) : ""}</span></span>${stateTag(m)}</div>
        <div class="cmp"><div><h4>${ours && ours.library ? "In the library" : "Ours"}</h4>${ours ? olSteps(ours.steps, k, !full) : "<em>This SOP no longer exists.</em>"}</div><div><h4>Theirs</h4>${olSteps(m.steps, k, !full)}</div></div>
        ${m.state ? "" : `<div class="acts"><button type="button" class="pillbtn press" data-act="keep" data-i="${m.i}">Keep ours</button><button type="button" class="pillbtn tint press" data-act="use" data-i="${m.i}" ${ours && !ours.library ? "" : "disabled"}>Use theirs</button></div>
        <span class="m wrapm">${master ? "Using theirs updates the master and bumps its version. Hotels then see an update to accept or keep." : ours && ours.library ? "This hotel will start with the Lotus library wording when you go live. Keep ours is fine here. You can change wording from the Library after going live." : "Using theirs rewrites the steps of this SOP at your hotel."}</span>`}
      </div>`;
    }).join("");
  } else if (g === "new") {
    body = B.new.map((n) => {
      const k = "n" + n.i, full = IMP.open.has(k);
      return `<div class="cell imp ${n.state ? "done" : ""}">
        <div class="hd"><span class="body"><span class="t wrap">${esc(n.title)}</span><span class="m wrapm">${n.category ? esc(n.category) : '<span class="no">Needs a category</span>'} · ${plural(n.steps.length, "step")}${master && n.applies === "hilton" ? " · Hilton only" : ""}${master && n.requires ? " · only if " + esc(AMEN[n.requires] || n.requires) : ""}</span></span>${stateTag(n)}</div>
        ${full ? `<div class="cmp one"><div>${olSteps(n.steps, k, false)}${n.script ? `<p class="prevp"><b>Say</b> ${chipify(n.script)}</p>` : ""}${n.flag ? `<p class="prevp"><b>Call</b> ${chipify(n.flag)}</p>` : ""}</div></div>` : ""}
        ${n.state ? "" : `<div class="acts">
          ${n.category ? "" : `<select data-cat="${n.i}" aria-label="Category" class="impsel"><option value="">Pick a category</option>${B.cats.map((c) => `<option>${esc(c)}</option>`).join("")}</select>`}
          <button type="button" class="pillbtn press" data-prev="${k}">${full ? "Hide" : "Preview"}</button>
          <button type="button" class="pillbtn press" data-act="skip" data-i="${n.i}">Skip</button>
          <button type="button" class="pillbtn tint press" data-act="add" data-i="${n.i}">${master ? "Add to master as draft" : "Add as draft"}</button></div>`}
      </div>`;
    }).join("");
  } else {
    body = B.details.map((d) => `<div class="cell imp ${d.state ? "done" : ""}">
        <div class="hd"><span class="body"><span class="t wrap">${esc(d.key)}</span><span class="m wrapm">${esc(d.value)}${d.known ? "" : " · new detail name"}</span></span>${stateTag(d)}</div>
        ${d.state ? "" : `<div class="acts">
          ${master ? `<select data-dh="${d.i}" aria-label="Hotel" class="impsel"><option value="">Pick a hotel</option>${IMP.info.hotels.map((h) => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join("")}</select>` : ""}
          <button type="button" class="pillbtn press" data-act="skip" data-i="${d.i}">Skip</button>
          <button type="button" class="pillbtn tint press" data-act="apply" data-i="${d.i}">${master ? "Use" : "Use for " + esc(hotelName(B.target))}</button></div>`}
      </div>`).join("");
  }
  const addAll = g === "new" && counts.new > 1 ? `<button type="button" id="impAll">${master ? "Add all new to master as drafts" : "Add all new as drafts"} (${counts.new})</button>` : "";
  box.innerHTML = `
    <button type="button" class="backbtn press" id="impList" style="margin-top:10px"><svg viewBox="0 0 8 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 1.5 1.5 6.5l5 5"/></svg>Imports</button>
    <div class="statusline"><span class="status ${B.open ? "invited" : "ok"}">${B.open ? "In review" : "All handled"}</span><span><b>${esc(B.files.join(", "))}</b><br><small>Into ${esc(impTargetName(B.target))}${B.by ? " · " + esc(B.by) : ""} · ${fmtDT(B.created)}</small></span></div>
    ${notes.map((n) => `<p class="hint no">${n}</p>`).join("")}
    <div class="pills wrapp" role="tablist">${["matches", "new", "details"].map((k) => `<button type="button" class="press" role="tab" data-g="${k}" aria-pressed="${k === g}">${label[k]} (${counts[k]})</button>`).join("")}</div>
    <div class="sec"><span>${label[g]}</span>${addAll}</div>
    <div class="group">${list.length ? body : `<div class="empty">${g === "matches" ? "Nothing here matched a procedure you already have." : g === "new" ? "No new procedures found." : "No hotel details found."}</div>`}</div>
    <p class="foot">${g === "matches" ? "Keep ours leaves your wording alone. Use theirs replaces the steps." : g === "new" ? (master ? "Added procedures start as drafts in the master library. Hotels don't see them until you publish them there." : "Added procedures start as drafts. They are not visible to staff until switched on.") : "Details fill the {Detail name} placeholders in SOPs."}</p>
    <div class="acts" style="margin-top:14px"><button type="button" class="danger" id="impDiscard">Discard this import</button></div>`;
  $("impList").onclick = async () => { IMP.batch = null; await renderImport(); };
  box.querySelectorAll("[data-g]").forEach((b) => (b.onclick = () => { IMP.group = b.dataset.g; paintImpReview(); }));
  box.querySelectorAll("[data-more]").forEach((b) => (b.onclick = () => { IMP.open.add(b.dataset.more); paintImpReview(); }));
  box.querySelectorAll("[data-prev]").forEach((b) => (b.onclick = () => { const k = b.dataset.prev; IMP.open.has(k) ? IMP.open.delete(k) : IMP.open.add(k); paintImpReview(); }));
  box.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => {
    const body = { group: g, index: +b.dataset.i, action: b.dataset.act };
    if (g === "new") { const s = box.querySelector(`[data-cat="${b.dataset.i}"]`); if (s) body.category = s.value; }
    if (g === "details" && master && body.action === "apply") { body.hotel = (box.querySelector(`[data-dh="${b.dataset.i}"]`) || {}).value; if (!body.hotel) return toast("Pick a hotel first"); }
    impAct(body);
  }));
  const all = $("impAll"); if (all) all.onclick = () => impAct({ group: "new", action: "addAll" });
  $("impDiscard").onclick = async () => {
    if (!confirm("Discard this import? Items you haven't handled will be lost.")) return;
    try { await api(`/api/import/${B.id}/discard`, { hotel: false, body: {} }); IMP.batch = null; await renderImport(); toast("Import discarded"); } catch (e) { fail(e); }
  };
}

let impActing = false;
async function impAct(body) {
  if (impActing) return; impActing = true;
  try {
    const nb = await api(`/api/import/${IMP.batch.id}/act`, { hotel: false, body });
    const note = nb.note; delete nb.note;
    IMP.batch = nb;
    if (nb.target === "master") { STATE.owner.master = null; STATE.owner.hotels = null; }
    else { STATE.home = null; SU.dirty = true; if (nb.target === STATE.hotel) loadHotel().catch(() => {}); }
    paintImpReview(); toast(note || "Done");
  } catch (e) { fail(e); }
  impActing = false;
}

/* ---------- New SOP / Edit SOP with AI ---------- */
// A chat where the manager briefs the AI. The result always lands in the normal editor for review; nothing is published from here.
const AU = { active: false, target: "hotel", sopId: null, from: "list", seed: null, draftId: null, draft: null, thread: [], pending: [], busy: false, cardOpen: true };
const AU_MAX_PHOTOS = 6;
const fillify = (t) => chipify(t).replace(/\[FILL:([^\]]*)\]/g, '<span class="fill">[FILL:$1]</span>');
const auIntro = () => AU.sopId || (AU.seed && AU.seed.title)
  ? `I've loaded ${AU.sopId ? AU.sopId + ": " : ""}${AU.seed.title || "this SOP"}. Tell me what to change, for example "add a step after 3 about Quore", and attach a screenshot if it helps.`
  : "Tell me how this procedure works, in your own words. Attach screenshots or photos if you have them. I'll ask about anything I'm missing, then write the steps.";

function authorOpen({ target, from, sopId, seed }) {
  Object.assign(AU, { active: true, target, from, sopId: sopId || null, seed: seed && seed.title ? seed : null, draftId: null, draft: seed && seed.title ? seed : null, pending: [], busy: false, cardOpen: true });
  AU.thread = [{ role: "bot", text: auIntro() }];
  $("auTitle").textContent = AU.sopId ? `Edit ${AU.sopId} with AI` : seed && seed.title ? "Edit with AI" : AU.target === "master" ? "New master SOP with AI" : "New SOP with AI";
  $("auText").value = ""; $("auText").style.height = "auto";
  showSheet("authorEd"); authorRender(); setTimeout(() => $("auText").focus(), 380);
}
function authorDiscard() {
  const id = AU.draftId; AU.active = false; AU.draftId = null;
  if (id) api(`/api/author/${encodeURIComponent(id)}/discard`, { body: {} }).catch(() => {});
}
function authorBack() { // leave the chat without a draft: back to the editor it came from, or close
  const from = AU.from, target = AU.target; authorDiscard();
  if (from === "editor") showSheet(target === "master" ? "masterEd" : "editor"); else hideSheet();
}
$("auCancel").onclick = authorBack;
$("auSelf").onclick = () => {
  const from = AU.from, target = AU.target; authorDiscard();
  if (from === "editor") showSheet(target === "master" ? "masterEd" : "editor");
  else if (target === "master") openMaster(null); else openSop(null);
};
function authorHandoff() {
  if (!AU.draft) return;
  const d = AU.draft, from = AU.from, target = AU.target;
  authorDiscard();
  if (from === "editor") {
    if (target === "master") { fillMasterEditor(d); showSheet("masterEd"); }
    else { fillEditor(d); showSheet("editor"); }
    toast("Draft loaded. Review it, then save.");
  } else if (target === "master") openMaster(null, d); else openSop(null, null, null, d);
}
$("auOpen").onclick = authorHandoff;
function authorRestart() {
  if (AU.draftId && !confirm("Start over? The chat and the draft are cleared.")) return;
  const id = AU.draftId; AU.draftId = null;
  if (id) api(`/api/author/${encodeURIComponent(id)}/discard`, { body: {} }).catch(() => {});
  AU.draft = AU.seed; AU.thread = [{ role: "bot", text: auIntro() }]; AU.pending = []; AU.cardOpen = true; authorRender();
}

function authorCard() {
  const d = AU.draft; if (!d) return "";
  const r = AU.last || {};
  const line = (label, v) => (v ? `<div class="auLine"><b>${label}</b>${fillify(v)}</div>` : "");
  return `<div class="auCard ${AU.cardOpen ? "" : "collapsed"}" id="auCard">
    <div class="auHead"><span class="eyebrow">Draft so far</span><button type="button" data-a="toggle">${AU.cardOpen ? "Hide" : "Show"}</button></div>
    <h3>${esc(d.title || "Untitled")}</h3><div class="auMeta">${esc(d.category || "")} · ${d.steps.length} step${d.steps.length === 1 ? "" : "s"}</div>
    <ol>${d.steps.map((x) => `<li><span>${fillify(x.t)}${x.img ? `<img alt="Photo for this step" loading="lazy" data-img="${esc(x.img)}" src="${imgUrl(x.img)}">` : ""}</span></li>`).join("")}</ol>
    ${line("Say it like this", d.script)}${line("Call the manager if", d.flag)}${line("Ways staff might ask", d.kw)}
    ${r.notes ? `<div class="auNote">${esc(r.notes)}</div>` : ""}
    ${r.missing && r.missing.length ? `<div class="auMiss">Still needed: ${r.missing.map(esc).join("; ")}</div>` : ""}
    <div class="auActs"><button type="button" data-a="start">Start over</button><button type="button" class="pri" data-a="open">Open in editor</button></div>
  </div>`;
}
function authorRender(scrollTo) {
  const body = $("auBody"), lastIdx = AU.thread.map((m) => m.role).lastIndexOf("bot");
  body.innerHTML = AU.thread.map((m, i) => {
    if (m.role === "err") return `<div class="auMsg err" role="alert">${esc(m.text)}</div>`;
    if (m.role === "me") return `<div class="auMsg me">${m.text ? esc(m.text) : ""}${m.imgs && m.imgs.length ? `<div class="auThumbs">${m.imgs.map((id) => `<img alt="Attached photo" data-img="${esc(id)}" src="${imgUrl(id)}">`).join("")}</div>` : ""}</div>`;
    const chips = m.options && m.options.length ? `<div class="auChips">${m.options.map((o) => `<button type="button" class="chip press" data-opt="${esc(o)}" ${m.answered || AU.busy || i !== lastIdx ? "disabled" : ""}>${esc(o)}</button>`).join("")}</div>` : "";
    return `<div class="auMsg bot">${esc(m.text)}</div>${chips}`;
  }).join("") + (AU.busy ? `<div class="auTyping"><span class="spin"></span> Writing…</div>` : "") + authorCard();
  body.querySelectorAll("[data-opt]").forEach((b) => (b.onclick = () => { AU.thread[lastIdx].answered = true; authorSend(b.dataset.opt, []); }));
  body.querySelectorAll("[data-img]").forEach((im) => (im.onclick = () => openLB(im.src)));
  body.querySelectorAll("#auCard [data-a]").forEach((b) => (b.onclick = () => {
    const a = b.dataset.a;
    if (a === "toggle") { AU.cardOpen = !AU.cardOpen; authorRender(); } else if (a === "start") authorRestart(); else if (a === "open") authorHandoff();
  }));
  $("auOpen").disabled = !AU.draft;
  $("auSend").disabled = AU.busy || AU.pending.some((p) => p.up);
  $("auAtt").innerHTML = AU.pending.map((p, i) => `<span class="th ${p.up ? "up" : ""}"><img alt="Photo to send" src="${esc(p.url)}"><button type="button" data-rm="${i}" aria-label="Remove photo">×</button></span>`).join("");
  $("auAtt").querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { AU.pending.splice(+b.dataset.rm, 1); authorRender(); }));
  if (scrollTo === "last") { const el = [...body.querySelectorAll(".auMsg.bot")].pop(); if (el) body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 6; }
  else body.scrollTop = body.scrollHeight;
}

async function authorSend(text, imageIds) {
  text = String(text || "").trim();
  if (AU.busy || (!text && !imageIds.length)) return;
  AU.thread.push({ role: "me", text, imgs: imageIds });
  AU.busy = true; authorRender();
  try {
    const r = await api("/api/author", { body: { draftId: AU.draftId || undefined, message: text, imageIds, target: AU.target, sopId: AU.sopId || undefined, seed: AU.draftId ? undefined : AU.seed || undefined } });
    AU.draftId = r.draftId; AU.last = r;
    if (r.kind === "ask") { AU.thread.push({ role: "bot", text: r.question, options: r.options }); AU.cardOpen = false; }
    else { AU.draft = r.draft; AU.thread.push({ role: "bot", text: r.notes || "Here's the draft. Check it on the card below." }); AU.cardOpen = true; }
    AU.busy = false; authorRender("last");
  } catch (e) {
    AU.busy = false;
    AU.thread.pop(); // take the unsent message back so it can be edited and retried
    if (/expired/i.test(e.message)) { AU.draftId = null; }
    AU.thread.push({ role: "err", text: e.message });
    $("auText").value = text; AU.pending = imageIds.map((id) => ({ id, url: imgUrl(id), up: false }));
    authorRender();
  }
}
function authorSubmit() {
  if (AU.busy || AU.pending.some((p) => p.up)) return;
  const text = $("auText").value, ids = AU.pending.map((p) => p.id);
  $("auText").value = ""; $("auText").style.height = "auto"; AU.pending = [];
  authorSend(text, ids);
}
$("auSend").onclick = authorSubmit;
$("auText").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); authorSubmit(); } });
$("auText").addEventListener("input", () => { const t = $("auText"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 120) + "px"; });

async function authorAttach(files) {
  const list = [...files].filter((f) => f.type.startsWith("image/"));
  if (!list.length) { if (files.length) toast("Choose a photo or screenshot"); return; }
  for (const f of list) {
    if (AU.pending.length >= AU_MAX_PHOTOS) { toast(`Up to ${AU_MAX_PHOTOS} photos at a time`); break; }
    const p = { id: null, url: URL.createObjectURL(f), up: true }; AU.pending.push(p); authorRender();
    try {
      const dataUrl = await shrink(f, 1280);
      p.id = (await api("/api/images", { body: { dataUrl } })).id; p.up = false;
    } catch (e) { AU.pending.splice(AU.pending.indexOf(p), 1); fail(e.message ? e : new Error("That image couldn't be read. Try a JPG or PNG.")); }
    authorRender();
  }
}
$("auAttach").onclick = () => { $("auPick").value = ""; $("auPick").click(); };
$("auPick").onchange = () => authorAttach($("auPick").files);
$("auText").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); authorAttach(files); }
});

Glass.init();
start();
suInit();
