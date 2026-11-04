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
const COLORS = ["#9A7426", "#5856D6", "#C2410C", "#0A6CBF", "#B4237A", "#6D7A12", "#7C3AED"];
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
const STATE = { me: null, hotels: [], hotel: null, cats: [], sops: [], contacts: [], routes: [], settings: {}, log: [], users: [] };
const sop = (id) => STATE.sops.find((s) => s.id === id);
const canManage = () => STATE.me && STATE.me.role !== "Front Desk";
const isAdmin = () => STATE.me && STATE.me.role === "Admin";
const hotelName = (id) => (STATE.hotels.find((h) => h.id === id) || {}).name || id;

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
  const place = (v, anim) => { const b = btns.find((b) => b.dataset.v === v); if (!b || !root.offsetParent) return; btns.forEach((x) => x.setAttribute("aria-selected", x === b)); anim ? sp.to(b.offsetLeft - 2, { damping: 1, response: 0.3 }) : sp.set(b.offsetLeft - 2); };
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
  if (!u) { setTimeout(() => $("lg-email").focus(), 50); }
}

async function start() {
  try {
    const me = await api("/api/me", { hotel: false, quiet401: true });
    STATE.me = me.user; STATE.hotels = me.hotels;
  } catch { STATE.me = null; }
  showScreen();
  if (STATE.me && !STATE.me.must_change_pw) await enterApp();
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("lg-err"); err.hidden = true;
  try {
    await api("/api/login", { hotel: false, quiet401: true, body: { email: $("lg-email").value, password: $("lg-pass").value } });
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
async function signOut() { try { await api("/api/logout", { hotel: false, body: {} }); } catch {} STATE.me = null; $("thread").innerHTML = ""; closeMenus(); showScreen(); }
$("pwCancel").onclick = signOut;
$("signOut").onclick = signOut;
$("changePw").onclick = () => { closeMenus(); STATE.me.must_change_pw = true; showScreen(); $("pw-cur").focus(); };

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
  $("acctWho").innerHTML = `${avatar(u, 36)}<span><b>${esc(u.name)}</b><small>${esc(u.role)} · ${esc(u.email)}</small></span>`;
  $("hello").textContent = `Hi ${u.name.split(" ")[0]}, how can I help?`;
  $("modeSeg").hidden = !canManage(); $("appTitle").hidden = canManage();
  $("adminTitle").textContent = isAdmin() ? "Admin" : "Manager";
  $("gearBtn").hidden = !isAdmin();
  await loadHotel();
  if (!canManage() && location.hash === "#admin") location.hash = "chat";
  mode = null; route();
}

function renderPropMenu() {
  const mine = STATE.hotels.filter((h) => STATE.me.hotels.includes(h.id));
  $("propBtn").classList.toggle("single", mine.length < 2); $("propBtn").setAttribute("aria-haspopup", mine.length < 2 ? "false" : "menu");
  $("propBtn").querySelector(".lbl").textContent = hotelName(STATE.hotel).replace("Hampton Inn Overland Park", "Hampton OP");
  $("propMenu").innerHTML = mine.map((h) => `<button class="mi" role="menuitemradio" data-h="${esc(h.id)}" aria-checked="${h.id === STATE.hotel}" ${h.ready ? "" : "disabled"}>${esc(h.name)} ${h.id === STATE.hotel ? `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--tint)" stroke-width="2" stroke-linecap="round"><path d="M2.5 7.5 5.5 10.5 11.5 3.5"/></svg>` : h.ready ? "" : "<small>Not set up</small>"}</button>`).join("");
  $("propMenu").querySelectorAll("[data-h]:not([disabled])").forEach((b) => (b.onclick = async () => {
    closeMenus(); if (b.dataset.h === STATE.hotel) return;
    STATE.hotel = b.dataset.h; try { localStorage.setItem("asklotus.hotel", STATE.hotel); } catch {}
    $("thread").innerHTML = ""; renderPropMenu(); await loadHotel(); if (mode === "admin") renderAdmin();
  }));
}

async function loadHotel() {
  const d = await api("/api/bootstrap");
  Object.assign(STATE, { cats: d.cats, sops: d.sops, contacts: d.contacts, routes: d.routes, settings: d.settings });
  $("helloSub").textContent = `Answers from ${hotelName(STATE.hotel)} procedures.`;
  $("aiPill").hidden = !STATE.settings.aiOn;
  $("askInput").placeholder = STATE.settings.aiOn ? "Ask anything" : "Ask about a procedure";
  $("adminHotel").textContent = hotelName(STATE.hotel);
  renderCatPills();
}

function route() {
  if (!STATE.me || STATE.me.must_change_pw) return;
  const v = location.hash === "#admin" && canManage() ? "admin" : "chat";
  if (v === mode) return;
  const prev = mode; mode = v; modeSeg(v, !!prev); $("composer").hidden = v !== "chat";
  const inEl = $(v); if (prev) $(prev).hidden = true; inEl.hidden = false;
  if (v === "admin") renderAdmin(true);
  else $("gearBtn").setAttribute("aria-pressed", false);
  if (prev && !RM.matches) { const dir = v === "admin" ? 1 : -1; Spring(0, (p) => { inEl.style.opacity = p; inEl.style.transform = `translateX(${(1 - p) * 24 * dir}px)`; }).to(1, { damping: 1, response: 0.38 }, () => (inEl.style.transform = "")); }
  scrollTo(0, 0);
}
addEventListener("hashchange", route);
addEventListener("scroll", () => $("hdr").classList.toggle("scrolled", scrollY > 4), { passive: true });

/* ---------- contacts and text rendering ---------- */
const contact = (role) => STATE.contacts.find((c) => norm(c.role) === norm(role));
const who = (role) => { const c = contact(role); return c ? `${c.name} (${c.role}) ${c.phone}` : role; };
const fill = (t) => String(t || "").replace(/\{([^}]+)\}/g, (m, r) => (contact(r) ? who(r) : m));
function routeText(r) {
  const a = contact(r.first), b = r.then && contact(r.then);
  return [a && who(r.first), b && who(r.then)].filter(Boolean).join(r.join === "and" ? " and " : ", then ") || "Not set";
}
function staffText(t) {
  return esc(fill(t)).replace(/\[CHECK:[^\]]*\]|\[CHECK\]/g, "").replace(/\[FILL:?[^\]]*\]/g, '<span class="fillMark">ask a manager</span>');
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
function sopCard(s, logId, answer) {
  const card = document.createElement("div"); card.className = "a";
  card.innerHTML = `<div class="hd"><div class="eyebrow">${esc(s.cat)}</div><h3>${esc(s.title)}</h3></div>
    ${answer ? `<div class="aiAns"><b>${SPARK}AI answer</b>${esc(answer)}</div>` : ""}
    <ol class="steps">${s.steps.map((x) => `<li><span>${staffText(x.t)}${x.img ? `<button type="button" class="ansImg" data-img="${esc(x.img)}" aria-label="Enlarge photo"><img alt="Photo for this step" loading="lazy" src="${imgUrl(x.img)}"></button>` : ""}</span></li>`).join("")}</ol>
    ${s.script ? `<div class="say"><b>Say it like this</b>${staffText(s.script)}</div>` : ""}
    ${s.flag ? `<div class="esc"><b>Call the manager if</b>${staffText(s.flag)}</div>` : ""}
    <div class="ft">${STATE.settings.showSource ? `<span class="tag">${esc(s.id)} · v${s.ver}</span><span>Updated ${fmtD(s.updated)}</span>` : ""}
    <span class="fb"><button type="button" data-v="y" class="press">Helpful</button><button type="button" data-v="n" class="press">Not helpful</button></span></div>`;
  card.querySelectorAll(".ansImg").forEach((b) => (b.onclick = () => openLB(imgUrl(b.dataset.img))));
  card.querySelectorAll(".fb button").forEach((b) => (b.onclick = async () => {
    card.querySelectorAll(".fb button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
    try { await api("/api/feedback", { hotel: false, body: { logId, fb: b.dataset.v } }); toast(b.dataset.v === "n" ? "Sent to managers to review" : "Thanks for the feedback"); } catch (e) { fail(e); }
  }));
  return card;
}
function missCard(general, aiDown) {
  const card = document.createElement("div"); card.className = "a miss";
  card.innerHTML = `<div class="hd"><div class="eyebrow">Not covered yet</div><h3>Check with the manager on duty</h3></div>
    ${general ? `<p class="generalAns"><b>General guidance (not an SOP):</b> ${esc(general)}</p>` : ""}
    <p>${aiDown ? "The assistant is having trouble right now. " : ""}This isn't in ${esc(hotelName(STATE.hotel))}'s procedures. Ask before you answer the guest. Your question was sent to the managers so it gets added.</p>
    <div class="esc"><b>Who to call</b>${STATE.routes.map((r) => `<span class="who-line">${esc(r.label)}: ${r.id === "emergency" ? "call 911 first, then " : ""}${esc(routeText(r))}</span>`).join("")}</div><div style="height:14px"></div>`;
  return card;
}
let asking = false;
async function ask(text) {
  text = text.trim(); if (!text || asking) return; asking = true;
  const th = $("thread");
  const q = document.createElement("div"); q.className = "q"; q.textContent = text; th.appendChild(q); appear(q, "bottom right");
  const wait = document.createElement("div"); wait.className = "loading"; wait.textContent = "Looking that up…"; th.appendChild(wait);
  try {
    const r = await api("/api/ask", { body: { q: text } });
    wait.remove();
    const card = r.sop ? sopCard(r.sop, r.logId, r.answer) : missCard(r.general, r.aiDown);
    th.appendChild(card); appear(card, "bottom left");
    card.scrollIntoView({ behavior: RM.matches ? "auto" : "smooth", block: "start" });
  } catch (e) { wait.textContent = e.message; }
  asking = false;
}
$("ask").addEventListener("submit", (e) => { e.preventDefault(); ask($("askInput").value); $("askInput").value = ""; });

/* ---------- admin ---------- */
let tab = "sops", cat = "", empFilter = null;
const TABS = [["sops", "Library"], ["gaps", "Unanswered"], ["activity", "Activity"], ["team", "Team"], ["contacts", "Contacts"], ["settings", "Settings"]];
// Settings opens from the gear by the account button, not the tab bar.
$("gearBtn").onclick = () => { closeMenus(); tab = "settings"; if (mode === "admin") renderAdmin(true); else location.hash = "admin"; };
const gaps = () => STATE.log.filter((l) => (!l.sop || l.fb === "n") && !l.dismissed);
const weekLog = () => STATE.log.filter((l) => Date.now() - new Date(l.when) < 7 * 864e5);

function renderTabs() {
  const g = gaps().length;
  $("tabs").innerHTML = TABS.filter((t) => t[0] !== "settings").map(([k, l]) => `<button type="button" role="tab" class="press" data-t="${k}" aria-pressed="${k === tab}">${l}${k === "gaps" && g ? `<span class="badge">${g}</span>` : ""}</button>`).join("");
  $("tabs").querySelectorAll("button").forEach((b) => (b.onclick = () => { tab = b.dataset.t; renderAdmin(true); }));
}
function renderCatPills() {
  $("cats").innerHTML = [{ name: "All" }, ...STATE.cats].map((c, i) => `<button type="button" class="press" data-c="${i ? esc(c.name) : ""}" aria-pressed="${(i ? c.name : "") === cat}">${esc(c.name)}</button>`).join("");
  $("cats").querySelectorAll("button").forEach((b) => (b.onclick = () => { cat = b.dataset.c; $("cats").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); renderList(); }));
  $("f-cat").innerHTML = STATE.cats.map((c) => `<option>${esc(c.name)}</option>`).join("");
}
$("filter").oninput = () => renderList();

async function renderAdmin(refresh) {
  if (tab === "settings" && !isAdmin()) tab = "sops";
  if (refresh) {
    try {
      const [log, users] = await Promise.all([api("/api/activity"), api("/api/users", { hotel: false })]);
      STATE.log = log; STATE.users = users;
    } catch (e) { fail(e); }
  }
  renderTabs(); TABS.forEach(([k]) => ($("tab-" + k).hidden = k !== tab));
  $("gearBtn").setAttribute("aria-pressed", tab === "settings");
  const wk = weekLog(), ans = wk.filter((l) => l.sop).length;
  $("sLive").textContent = STATE.sops.filter((s) => s.status === "live").length;
  $("sQ").textContent = wk.length;
  $("sRate").textContent = (wk.length ? Math.round((ans / wk.length) * 100) : 0) + "%";
  $("sGap").textContent = gaps().length;
  ({ sops: renderList, gaps: renderGaps, activity: renderActivity, team: renderTeam, contacts: renderContacts, settings: renderSettings })[tab]();
}

function renderList() {
  const f = norm($("filter").value);
  const rows = STATE.sops.filter((s) => (!cat || s.cat === cat) && (!f || norm(s.title + " " + s.kw + " " + s.id).includes(f)));
  $("libCount").textContent = rows.length + " SOP" + (rows.length === 1 ? "" : "s");
  $("sopList").innerHTML = rows.length ? rows.map((s) => `<button type="button" class="cell" data-edit="${esc(s.id)}"><span class="dot ${s.status}"></span>
    <span class="body"><span class="t">${esc(s.title)}</span><span class="m">${esc(s.id)} · v${s.ver} · ${s.status === "live" ? "Live" : "Draft"} · ${fmtD(s.updated)}</span></span>${chev}</button>`).join("") : `<div class="empty">No SOPs match that search.</div>`;
  $("sopList").querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => openSop(b.dataset.edit)));
}

function renderGaps() {
  const g = gaps();
  $("gapList").innerHTML = g.length ? g.map((l) => `<div class="cell" style="flex-wrap:wrap">
    <span class="body" style="min-width:180px"><span class="t wrap">${esc(l.q)}</span><span class="m">${esc(l.user_name || "Removed user")} · ${l.sop ? "Marked not helpful on " + esc(l.sop) : "No SOP matched"} · ${fmtDT(l.when)}</span></span>
    <span class="acts"><button type="button" class="pillbtn press" data-dismiss="${l.id}">Dismiss</button><button type="button" class="pillbtn tint press" data-make="${l.id}">Write SOP</button></span></div>`).join("") : `<div class="empty">Every question has an answer right now.</div>`;
  $("gapList").querySelectorAll("[data-make]").forEach((b) => (b.onclick = () => { const l = STATE.log.find((x) => x.id == b.dataset.make); l.sop && l.fb === "n" && sop(l.sop) ? openSop(l.sop, null, l.id) : openSop(null, l.q, l.id); }));
  $("gapList").querySelectorAll("[data-dismiss]").forEach((b) => (b.onclick = async () => {
    try { await api(`/api/activity/${b.dataset.dismiss}/dismiss`, { body: {} }); STATE.log.find((x) => x.id == b.dataset.dismiss).dismissed = true; renderAdmin(); } catch (e) { fail(e); }
  }));
}

function topOf(ls) { const c = {}; ls.forEach((l) => { if (l.sop) { const s = sop(l.sop); if (s) c[s.title] = (c[s.title] || 0) + 1; } }); const t = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return t && t[0]; }
function renderActivity() {
  const all = STATE.log, log = empFilter ? all.filter((l) => l.uid === empFilter) : all;
  const fu = empFilter && STATE.users.find((u) => u.id === empFilter);
  $("actFilter").innerHTML = fu ? `<button type="button" class="filterchip press" id="clearEmp">Showing ${esc(fu.name)} <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2l6 6M8 2 2 8"/></svg></button>` : "";
  if (fu) $("clearEmp").onclick = () => { empFilter = null; renderActivity(); };
  const by = {}; all.forEach((l) => { if (l.uid) (by[l.uid] = by[l.uid] || []).push(l); });
  const emps = Object.entries(by).map(([uid, ls]) => ({ u: STATE.users.find((u) => u.id == uid) || { id: +uid, name: ls[0].user_name || "Removed user" }, n: ls.length, miss: ls.filter((l) => !l.sop).length, top: topOf(ls) })).sort((a, b) => b.n - a.n);
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
    return `<div class="cell">${avatar(u, 28)}<span class="body"><span class="t wrap">${esc(l.q)}</span><span class="m">${esc(u.name)} · ${s ? esc(s.id + " " + s.title) : `<span class="no">Not covered</span>`}${l.fb === "n" ? ` · <span class="no">Not helpful</span>` : ""} · ${fmtDT(l.when)}</span></span></div>`; }).join("") : `<div class="empty">No questions yet.</div>`;
}

function renderTeam() {
  const r = {}; STATE.users.forEach((u) => (r[u.role] = (r[u.role] || 0) + 1));
  $("teamCount").textContent = Object.entries(r).map(([k, v]) => `${v} ${k}`).join(" · ") || "Team";
  $("teamList").innerHTML = STATE.users.map((u) => {
    const locked = !isAdmin() && u.role === "Admin";
    const st = u.status === "off" ? `<span class="status off">Off</span>` : u.must_change_pw ? `<span class="status invited">Not signed in yet</span>` : "";
    return `<button type="button" class="cell" data-user="${u.id}" ${locked ? "disabled" : ""}>${avatar(u)}
      <span class="body"><span class="t">${esc(u.name)}${u.id === STATE.me.id ? " (you)" : ""}</span><span class="m">${esc(u.role)} · ${u.hotels.length > 1 ? u.hotels.length + " hotels" : esc(hotelName(u.hotels[0]))} · ${u.last_seen ? "Active " + fmtD(u.last_seen) : "Never signed in"}</span></span>${st}${locked ? "" : chev}</button>`;
  }).join("");
  $("teamList").querySelectorAll("[data-user]:not([disabled])").forEach((b) => (b.onclick = () => openUser(+b.dataset.user)));
  $("teamFoot").textContent = isAdmin() ? "Everyone signs in with their own email, so every question is tied to them." : "Managers can add and edit Front Desk and Manager accounts. Only an Admin can change Admin accounts.";
}

/* ----- contacts ----- */
function roleOpts(sel, allowNone) { return (allowNone ? `<option value="">None</option>` : "") + STATE.contacts.map((c) => `<option ${norm(c.role) === norm(sel) ? "selected" : ""}>${esc(c.role)}</option>`).join(""); }
function renderContacts() {
  $("routeList").innerHTML = STATE.routes.map((r) => `<div class="cell" style="flex-wrap:wrap"><span class="body" style="min-width:160px"><span class="t">${esc(r.label)}</span><span class="m">${esc(r.sub)}</span></span>
    <span class="routesel"><select data-r="${esc(r.id)}" data-k="first" aria-label="${esc(r.label)} first call">${roleOpts(r.first)}</select><small>${r.join === "and" ? "and" : "then"}</small><select data-r="${esc(r.id)}" data-k="then" aria-label="${esc(r.label)} second call">${roleOpts(r.then, true)}</select></span></div>`).join("");
  $("routeList").querySelectorAll("select").forEach((s) => (s.onchange = async () => {
    const r = STATE.routes.find((x) => x.id === s.dataset.r);
    try { await api(`/api/routes/${encodeURIComponent(r.id)}`, { method: "PUT", body: { field: s.dataset.k, value: s.value } }); r[s.dataset.k] = s.value; toast(`${r.label}: ${routeText(r)}`); }
    catch (e) { fail(e); renderContacts(); }
  }));
  $("contactList").innerHTML = STATE.contacts.map((c) => `<button type="button" class="cell" data-c="${c.id}"><span class="av" style="background:${color(c.id)}">${esc(initials(c.name))}</span>
    <span class="body"><span class="t">${esc(c.role)}</span><span class="m">${esc(c.name)} · ${esc(c.phone)}</span></span>${chev}</button>`).join("") || `<div class="empty">No contacts yet.</div>`;
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
  $("provList").querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => { draftProvider = b.dataset.p; $("st-model").value = ""; $("st-url").value = ""; renderSettings(); }));
  $("modelList").innerHTML = (MODEL_HINTS[draftProvider] || []).map((m) => `<option value="${m}">`).join("");
  if (same && !$("st-model").value) $("st-model").value = st.model || "";
  $("st-model").placeholder = p.defaultModel ? `Default: ${p.defaultModel}` : draftProvider === "azure" ? "Optional for Azure" : "Model name";
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
    STATE.settings = await api("/api/settings", { hotel: false, method: "PUT", body: { provider: draftProvider, model: $("st-model").value, baseUrl: $("st-url").value, apiKey: key || undefined } });
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
  try { const r = await api("/api/settings/test", { hotel: false, body: {} }); toast(`Connected. The provider answered in ${(r.ms / 1000).toFixed(1)}s`); }
  catch (e) { fail(e); }
  b.disabled = false; b.textContent = "Test Connection";
};

/* ---------- bottom sheet ---------- */
const cardEl = $("card"), sheet = $("sheet"), scrim = $("scrim"); let sheetH = 600;
const sheetS = Spring(0, (y) => { cardEl.style.transform = `translateY(${y}px)`; scrim.style.opacity = Math.max(0, Math.min(1, 1 - y / sheetH)); });
function showSheet(which) {
  ["editor", "userEd", "contactEd"].forEach((id) => ($(id).hidden = id !== which)); sheet.hidden = false; scrim.hidden = false; sheetH = cardEl.offsetHeight || 600;
  if (!sheetS.raf && sheetS.value <= 0) sheetS.set(sheetH); sheetS.to(0, { damping: 1, response: 0.38 }); document.body.style.overflow = "hidden";
  sheet.querySelectorAll(".sbody").forEach((b) => (b.scrollTop = 0));
}
function hideSheet(velocity) { sheetH = cardEl.offsetHeight || sheetH; sheetS.to(sheetH, { damping: 1, response: 0.32, velocity }, () => { sheet.hidden = true; scrim.hidden = true; document.body.style.overflow = ""; }); }
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
let editing = null, fromLog = null, draftSteps = [], imgFor = -1, saving = false;
const IC = {
  up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>',
  img: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="6" cy="7" r="1.3"/><path d="M14 11l-3.5-3.5L4 13"/></svg>',
  del: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};
$("newSop").onclick = () => openSop(null);
function openSop(id, seedQ, logId) {
  editing = id ? sop(id) : null; fromLog = logId || null;
  $("edTitle").textContent = editing ? editing.id : "New SOP";
  $("f-title").value = editing ? editing.title : seedQ || "";
  $("f-cat").value = editing ? editing.cat : (STATE.cats[0] || {}).name;
  draftSteps = editing ? editing.steps.map((s) => ({ ...s })) : [{ t: "", img: null }];
  renderSteps();
  $("f-script").value = editing ? editing.script : ""; $("f-flag").value = editing ? editing.flag : "";
  $("f-kw").value = editing ? editing.kw : seedQ ? norm(seedQ) : "";
  $("f-status").setAttribute("aria-checked", editing ? editing.status === "live" : true);
  $("delEd").hidden = !editing; $("delEd").dataset.armed = ""; $("delEd").textContent = "Delete SOP";
  showSheet("editor");
}
function grow(t) { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; }
function renderSteps(focusIdx) {
  const n = draftSteps.length;
  $("stepsEd").innerHTML = draftSteps.map((s, i) => `<div class="stepRow" data-i="${i}"><span class="num">${i + 1}</span>
    <textarea rows="1" aria-label="Step ${i + 1}" placeholder="Describe this step">${esc(s.t)}</textarea>
    <span class="stepTools"><button type="button" class="iconbtn" data-a="up" aria-label="Move step ${i + 1} up" ${i ? "" : "disabled"}>${IC.up}</button><button type="button" class="iconbtn" data-a="down" aria-label="Move step ${i + 1} down" ${i < n - 1 ? "" : "disabled"}>${IC.down}</button><button type="button" class="iconbtn ${s.img ? "has" : ""}" data-a="img" aria-label="${s.img ? "Replace" : "Add"} photo for step ${i + 1}">${IC.img}</button><button type="button" class="iconbtn del" data-a="del" aria-label="Delete step ${i + 1}">${IC.del}</button></span>
    ${s.img ? `<span class="stepImg"><img alt="Photo for step ${i + 1}" src="${imgUrl(s.img)}"><button type="button" data-a="rmimg">Remove</button></span>` : ""}</div>`).join("");
  $("stepsEd").querySelectorAll(".stepRow").forEach((row) => {
    const i = +row.dataset.i, ta = row.querySelector("textarea"); grow(ta);
    ta.oninput = () => { draftSteps[i].t = ta.value; grow(ta); };
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); draftSteps.splice(i + 1, 0, { t: "", img: null }); renderSteps(i + 1); }
      else if (e.key === "Backspace" && !ta.value && draftSteps.length > 1 && !draftSteps[i].img) { e.preventDefault(); draftSteps.splice(i, 1); renderSteps(Math.max(0, i - 1)); }
    };
    row.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => {
      const a = b.dataset.a;
      if (a === "up" && i) { [draftSteps[i - 1], draftSteps[i]] = [draftSteps[i], draftSteps[i - 1]]; renderSteps(i - 1); }
      if (a === "down" && i < n - 1) { [draftSteps[i + 1], draftSteps[i]] = [draftSteps[i], draftSteps[i + 1]]; renderSteps(i + 1); }
      if (a === "del") { draftSteps.splice(i, 1); if (!draftSteps.length) draftSteps.push({ t: "", img: null }); renderSteps(Math.min(i, draftSteps.length - 1)); }
      if (a === "img") { imgFor = i; $("imgPick").value = ""; $("imgPick").click(); }
      if (a === "rmimg") { draftSteps[i].img = null; renderSteps(); }
    }));
  });
  if (focusIdx != null) { const t = $("stepsEd").querySelectorAll("textarea")[focusIdx]; if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
}
$("addStep").onclick = () => { draftSteps.push({ t: "", img: null }); renderSteps(draftSteps.length - 1); };
function shrink(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader(); fr.onerror = rej;
    fr.onload = () => { const im = new Image(); im.onerror = rej; im.onload = () => { const k = Math.min(1, 1600 / Math.max(im.width, im.height)), c = document.createElement("canvas"); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", 0.82)); }; im.src = fr.result; };
    fr.readAsDataURL(file);
  });
}
$("imgPick").onchange = async () => {
  const f = $("imgPick").files[0]; if (!f || imgFor < 0) return;
  if (!f.type.startsWith("image/")) { toast("Choose a photo or screenshot"); return; }
  try {
    toast("Uploading photo…");
    const dataUrl = await shrink(f);
    const r = await api("/api/images", { body: { dataUrl } });
    draftSteps[imgFor].img = r.id; renderSteps(); toast("Photo added. Publish to save it.");
  } catch (e) { fail(e.message ? e : new Error("That image couldn't be read. Try a JPG or PNG.")); }
};
$("delEd").onclick = async () => {
  const b = $("delEd");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to delete for everyone"; return; }
  try { await api(`/api/sops/${encodeURIComponent(editing.id)}`, { method: "DELETE" }); STATE.sops = STATE.sops.filter((s) => s !== editing); hideSheet(); renderAdmin(); toast("SOP deleted"); } catch (e) { fail(e); }
};
$("editor").addEventListener("submit", async (e) => {
  e.preventDefault(); if (saving) return;
  const d = { title: $("f-title").value.trim(), cat: $("f-cat").value, steps: draftSteps.map((s) => ({ t: s.t.trim(), img: s.img })).filter((s) => s.t || s.img), script: $("f-script").value.trim(), flag: $("f-flag").value.trim(), kw: $("f-kw").value.trim(), status: $("f-status").getAttribute("aria-checked") === "true" ? "live" : "draft" };
  if (!d.title) { $("f-title").focus(); toast("Add a title"); return; }
  if (!d.steps.length) { toast("Add at least one step"); return; }
  saving = true;
  try {
    const out = editing ? await api(`/api/sops/${encodeURIComponent(editing.id)}`, { method: "PUT", body: d }) : await api("/api/sops", { body: d });
    if (editing) Object.assign(editing, out); else STATE.sops.push(out);
    STATE.sops.sort((a, b) => a.id.localeCompare(b.id));
    if (fromLog) { try { await api(`/api/activity/${fromLog}/dismiss`, { body: {} }); const l = STATE.log.find((x) => x.id == fromLog); if (l) l.dismissed = true; } catch {} }
    toast(`Published ${out.id} v${out.ver}`); hideSheet(); renderAdmin();
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
const ROLES = { "Front Desk": "Chat only", Manager: "SOPs, team and activity for their hotels", Admin: "Everything, including AI settings" };
$("newUser").onclick = () => openUser(null);
function renderRoles() {
  $("u-roles").innerHTML = Object.entries(ROLES).map(([r, d]) => { const dis = r === "Admin" && !isAdmin(); return `<button type="button" class="radio" role="radio" data-r="${r}" aria-checked="${r === draftRole}" ${dis ? "disabled" : ""}><span class="body" style="flex:1"><span style="display:block;font-weight:500;${dis ? "color:var(--label3)" : ""}">${r}</span><span style="font-size:.8rem;color:var(--label2)">${dis ? "Only an Admin can grant this" : d}</span></span>${checkSvg}</button>`; }).join("");
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
function openUser(id) {
  eu = id ? STATE.users.find((u) => u.id === id) : null; const self = eu && eu.id === STATE.me.id;
  $("uTitle").textContent = eu ? eu.name : "Add Employee"; $("uSave").textContent = eu ? "Save" : "Create";
  $("u-name").value = eu ? eu.name : ""; $("u-email").value = eu ? eu.email : "";
  draftRole = eu ? eu.role : "Front Desk"; draftHotels = eu ? [...eu.hotels] : [STATE.hotel];
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
  const body = { name: $("u-name").value.trim(), email: $("u-email").value.trim(), role: draftRole, hotels: draftHotels, status: $("u-active").getAttribute("aria-checked") === "true" ? "active" : "off" };
  try {
    if (eu) { await api(`/api/users/${eu.id}`, { hotel: false, method: "PUT", body }); toast("Saved " + body.name); hideSheet(); }
    else { const r = await api("/api/users", { hotel: false, body }); showTemp(r.tempPassword); $("u-hint").textContent = `${body.name} is set up. Sign-in: ${body.email.toLowerCase()} with the temporary password above.`; $("uSave").textContent = "Done"; eu = { id: r.id, ...body }; }
    STATE.users = await api("/api/users", { hotel: false }); renderAdmin();
  } catch (x) { fail(x); }
});

start();
