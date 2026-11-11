"use strict";
/* Ask Lotus glass shell: manager navigation (sidebar and phone tab bar), the Dashboard, the Settings sections and the
   Hotel color picker. Loaded before app.js and used by it; it reads app.js globals (STATE, api, $, tab, mode...) only when called. */
const Glass = (function () {
  const RMQ = matchMedia("(prefers-reduced-motion: reduce)"), PHONE = matchMedia("(max-width: 899px)");
  const svg = (d, w = 1.9) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d.split("|").map((p) => `<path d="${p}"/>`).join("")}</svg>`;
  const P = {
    dashboard: "M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 9h8V3h-8z",
    chat: "M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12Z",
    sops: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5",
    gaps: "M12 8v5M12 16h.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
    activity: "M22 12h-4l-3 9L9 3l-3 9H2",
    import: "M12 3v12M7 10l5 5 5-5M5 21h14",
    upd: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
    add: "M12 5v14M5 12h14",
    draft: "M4 4h11l5 5v11H4zM14 4v6h6",
    info: "M12 16v-4M12 8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
    lib: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z",
    kit: "M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z",
    team: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
    contacts: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z",
    owner: "M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6",
    settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z|M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
    more: "M4 7h16M4 12h16M4 17h16",
    check: "M20 6 9 17l-5-5",
    send: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z",
    color: "M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2a2 2 0 0 0-1.5 3.3A1.6 1.6 0 0 1 12 22ZM7.5 11.5h.01M10.5 7.5h.01M15.5 7.5h.01",
    moon: "M12 3a9 9 0 1 0 9 9c0-.5 0-1-.1-1.4A5.5 5.5 0 0 1 12.4 3.1L12 3Z",
    ai: "M8 2.5c.4 3.4 2.6 5.6 6 6-3.4.4-5.6 2.6-6 6-.4-3.4-2.6-5.6-6-6 3.4-.4 5.6-2.6 6-6Z",
    sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0|M16 4v4M10 10v4M18 16v4",
    user: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z",
  };
  const ic = (k, w) => svg(P[k], w);
  const SPARKLE = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 0c.6 5.2 4.8 9.4 10 10-5.2.6-9.4 4.8-10 10-.6-5.2-4.8-9.4-10-10C5.2 9.4 9.4 5.2 10 0Z" fill="currentColor"/></svg>`;
  const html = String.raw;

  /* ---------- hotel color ---------- */
  const LOTUS = "#8C6A1F";
  const PRESETS = [
    ["lotus", "Lotus gold", "Default", "#8C6A1F"], ["lotusrose", "Lotus blossom", "Hotel Lotus, softer", "#A8456B"],
    ["lotusjade", "Lotus jade", "Lotus leaf green", "#2F6B5A"], ["hampton", "Hampton", "Navy", "#1F3A6E"],
    ["hi", "Holiday Inn", "Green", "#167A3A"], ["hie", "Holiday Inn Express", "Express blue", "#0B5CAD"],
    ["fairfield", "Fairfield", "Deep blue", "#1D4F7A"], ["element", "Element", "Leaf green", "#4E7A1F"],
    ["bw", "Best Western", "Blue", "#1B4F9C"], ["graphite", "Graphite", "Neutral", "#3B3F46"],
  ];
  // Paints a color on the whole page. Lotus gold is the stylesheet's own look (no overrides).
  const paint = (hex) => window.applyAccent(hex && hex.toUpperCase() !== LOTUS ? hex : null);
  // The hotel's saved color, applied to the page and remembered on this device.
  function applyHotelAccent() {
    const h = hotelObj(), a = h.accent || null;
    paint(a);
    window.cacheAccent(STATE.hotel, a);
    if (h.ready) { try { localStorage.setItem("asklotus.hotel", STATE.hotel); } catch {} }
  }
  // The text under the color picker, from how white text reads on the chosen color.
  function contrast(hex) {
    const m = window.accentMath, c = m.rgb(hex) || m.rgb(LOTUS), r = m.ratio(c, [255, 255, 255]);
    return r >= 4.5 ? ["ok", "White text on it reads well"] : r >= 3 ? ["warn", "Fine for big text: small text is darkened automatically"] : ["warn", "Light color: buttons switch to dark text"];
  }
  let draft = LOTUS;
  function renderColor() {
    const el = $("sec-color"), saved = (hotelObj().accent || LOTUS).toUpperCase(), name = hotelName(STATE.hotel);
    if (el.dataset.hotel !== STATE.hotel) { draft = saved; el.dataset.hotel = STATE.hotel; }
    const [cls, txt] = contrast(draft), cur = PRESETS.find((p) => p[3].toUpperCase() === draft.toUpperCase());
    el.innerHTML = html`<h2 class="sh">Hotel color</h2>
      <p class="sd">Sets buttons, highlights and the background glow for everyone at ${esc(name)}.</p>
      <div class="sl">Presets</div>
      <div class="presets" role="radiogroup" aria-label="Color presets">${PRESETS.map(([k, label, sub, hx]) => `<button type="button" class="preset${cur && cur[0] === k ? " on" : ""}" role="radio" aria-checked="${!!cur && cur[0] === k}" data-hex="${hx}" style="--hx:${hx}">
        <span class="sw" aria-hidden="true"><i></i></span><span class="pn">${esc(label)}<b aria-hidden="true">✓</b></span><span class="ps">${esc(sub)}</span></button>`).join("")}</div>
      <div class="sl">Custom</div>
      <div class="custom">
        <label class="cpick"><input type="color" id="colWheel" value="${draft.toLowerCase()}" aria-label="Pick any color"><span>Pick any color</span></label>
        <label class="hexf"><span>Hex</span><input id="colHex" type="text" value="${draft}" maxlength="7" autocomplete="off" spellcheck="false" aria-label="Hex color"></label>
        <span class="cl ${cls}" id="colNote" role="status">${txt}</span>
      </div>
      <div class="sl">Preview</div>
      <div class="cprev" aria-hidden="true"><span class="cp-bub">Guest wants a late checkout</span><span class="cp-cta">New SOP with AI</span><span class="cp-ai">AI ANSWER</span><span class="cp-seg"><i>7 days</i><u>30 days</u></span></div>
      <div class="cbtns"><button type="button" class="gbtn dark press" id="colSave">Save for ${esc(name)}</button><button type="button" class="gbtn press" id="colReset">Back to Lotus gold</button></div>`;
    const set = (hex) => { draft = hex.toUpperCase(); paint(draft); renderColor(); };
    el.querySelectorAll(".preset").forEach((b) => (b.onclick = () => set(b.dataset.hex)));
    $("colWheel").oninput = (e) => set(e.target.value);
    $("colHex").onchange = (e) => {
      const v = e.target.value.trim(), h = (v[0] === "#" ? v : "#" + v);
      if (/^#[0-9a-f]{6}$/i.test(h)) set(h); else { toast("Use a color like #1F3A6E"); e.target.value = draft; }
    };
    const save = async (hex) => {
      try {
        const r = await api("/api/hotel/color", { method: "PUT", body: { accent: hex && hex.toUpperCase() !== LOTUS ? hex.toUpperCase() : null } });
        hotelObj().accent = r.accent; draft = (r.accent || LOTUS).toUpperCase(); applyHotelAccent(); renderColor();
        toast(r.accent ? `Color saved for ${name}` : "Back to Lotus gold");
      } catch (e) { fail(e); }
    };
    $("colSave").onclick = () => save(draft);
    $("colReset").onclick = () => save(null);
  }

  /* ---------- settings sections ---------- */
  const SECS = [
    ["color", "Hotel color", "Presets or any color", "color", () => isGM()],
    ["appearance", "Appearance", "Light, dark, automatic", "moon", () => canManage()],
    ["ai", "AI", "Provider, models, key", "ai", () => isOwner()],
    ["answers", "How answers work", "Guidance, source, fallback", "sliders", () => isOwner()],
    ["account", "My account", "Password, sign out", "user", () => canManage()],
  ];
  let setSec = null;
  const secs = () => SECS.filter((s) => s[4]());
  function renderSettingsPage() {
    const list = secs();
    if (setSec && !list.some((s) => s[0] === setSec)) setSec = null;
    if (!setSec && !PHONE.matches) setSec = list[0][0]; // phone: stay on the list until a section is picked
    $("tab-settings").dataset.view = setSec ? "sec" : "list";
    $("setNav").innerHTML = list.map(([k, label, sub, icon]) => `<button type="button" class="snav${k === setSec ? " on" : ""}" data-s="${k}" ${k === setSec ? 'aria-current="true"' : ""}><span class="sico">${ic(icon, 2)}</span><span class="stx"><span>${label}</span><small>${sub}</small></span><svg class="chev" viewBox="0 0 8 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 1.5 6.5 6.5 1.5 11.5"/></svg></button>`).join("");
    $("setNav").querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => { setSec = b.dataset.s; renderSettingsPage(); scrollTo(0, 0); }));
    SECS.forEach(([k]) => ($("sec-" + k).hidden = k !== setSec));
    $("setBack").hidden = !PHONE.matches || !setSec;
    $("adminHotel").textContent = hotelName(STATE.hotel);
    if (setSec === "color") renderColor(); else applyHotelAccent(); // leaving the picker drops an unsaved preview
    if (setSec === "ai" || setSec === "answers") renderSettings();
    renderTheme();
  }

  /* ---------- navigation ---------- */
  const ITEMS = [
    ["dashboard", "Dashboard", "hotel", () => canManage()],
    ["chat", "Chat", "hotel", () => canManage()],
    ["sops", "Library", "hotel", () => canManage()],
    ["gaps", "Unanswered", "hotel", () => canManage()],
    ["activity", "Activity", "hotel", () => canManage()],
    ["team", "Team", "people", () => canManage()],
    ["contacts", "Contacts", "people", () => canManage()],
    ["owner", "Portfolio", "lotus", () => isOwner()],
  ];
  const GROUPS = { hotel: "Hotel", people: "People", lotus: "Lotus" };
  const PHONE_BAR = ["dashboard", "chat", "sops", "gaps"];
  const current = () => (mode === "chat" ? "chat" : mode === "owner" ? "owner" : mode === "admin" ? tab : null);
  function navTo(k) {
    closeMenus();
    if (k === "chat" || k === "owner") return go(k);
    tab = k; if (k === "settings") setSec = null;
    if (mode === "admin") { renderAdmin(true); scrollTo(0, 0); } else go("admin");
  }
  function renderNav() {
    const shell = canManage();
    document.body.classList.toggle("shell", !!shell);
    if (!shell) return;
    const cur = current(), badge = (STATE.convos ? gaps().length : 0), items = ITEMS.filter((i) => i[3]());
    const btn = (k, label, extra = "") => html`<button type="button" class="nav${k === cur ? " on" : ""}" data-n="${k}" ${k === cur ? 'aria-current="page"' : ""}>${ic(k)}<span class="nl">${label}</span>${extra}</button>`;
    const bdg = (k) => (k === "gaps" && badge ? `<span class="nb" aria-label="${badge} waiting">${badge}</span>` : "");
    const h = hotelObj(), live = STATE.sops.filter((s) => s.status === "live").length;
    $("side").innerHTML = html`<div class="sbrand"><span class="slogo">${SPARKLE}</span><span><b>Ask Lotus</b><small>Lotus Hospitality</small></span></div>
      ${Object.entries(GROUPS).map(([g, label]) => { const l = items.filter((i) => i[2] === g); return l.length ? `<div class="sgrp">${label}</div>${l.map(([k, t]) => btn(k, t, bdg(k))).join("")}` : ""; }).join("")}
      <div class="sgrp">Account</div>${btn("settings", "Settings")}
      <div class="sfoot"><div class="sfh"><b>${esc(hotelName(STATE.hotel))}</b><span class="spill${h.ready ? "" : " off"}">${h.ready ? "Live" : "Setting up"}</span></div><small>${live} SOP${live === 1 ? "" : "s"} on · ${esc(h.system ? sysName(h) : "")}</small></div>`;
    const more = items.filter((i) => !PHONE_BAR.includes(i[0]) && i[0] !== "chat").concat([["settings", "Settings"]]);
    $("tabbar").innerHTML = PHONE_BAR.map((k) => { const t = items.find((i) => i[0] === k); return html`<button type="button" class="tab${k === cur ? " on" : ""}" data-n="${k}" ${k === cur ? 'aria-current="page"' : ""}>${ic(k)}<span>${t[1]}</span>${bdg(k)}</button>`; }).join("")
      + html`<button type="button" class="tab${more.some((i) => i[0] === cur) ? " on" : ""}" id="moreBtn" aria-haspopup="menu" aria-expanded="false" aria-label="More">${ic("more")}<span>More</span></button>`;
    $("moreMenu").innerHTML = more.map(([k, t]) => `<button type="button" class="mi" role="menuitem" data-n="${k}">${ic(k)}<span>${t}</span></button>`).join("");
    $("moreBtn").onclick = (e) => { e.stopPropagation(); const m = $("moreMenu"); closeMenus(m); moreSet(m.hidden); };
    document.querySelectorAll("#side [data-n],#tabbar [data-n],#moreMenu [data-n]").forEach((b) => (b.onclick = () => navTo(b.dataset.n)));
  }
  let moreSet = () => {};
  function init() {
    const m = $("moreMenu"), sp = Spring(0, (v) => { m.style.opacity = v; m.style.transform = `scale(${0.85 + 0.15 * v})`; });
    moreSet = (o) => {
      const b = $("moreBtn"); if (!b) return;
      b.setAttribute("aria-expanded", o);
      if (o) { const r = b.getBoundingClientRect(); m.style.bottom = innerHeight - r.top + 10 + "px"; m.style.right = Math.max(12, innerWidth - r.right) + "px"; m.hidden = false; sp.to(1, { damping: 0.86, response: 0.32 }); }
      else if (!m.hidden) sp.to(0, { damping: 1, response: 0.22 }, () => (m.hidden = true));
    };
    m._close = () => moreSet(false); menus.push(m);
    $("setBack").onclick = () => { setSec = null; renderSettingsPage(); scrollTo(0, 0); };
    $("dashBody").addEventListener("click", dashClick);
    $("needsBody").addEventListener("click", needsClick);
    $("needsList").addEventListener("click", sheetClick);
    $("needsEd").addEventListener("submit", (e) => e.preventDefault());
    PHONE.addEventListener("change", () => { closeMenus(); if (mode === "admin" && tab === "settings") renderSettingsPage(); });
  }

  /* ---------- dashboard ---------- */
  let range = 7, dash = null, token = 0, raf = [];
  const RANGE_SUB = { 7: "Last 7 days", 30: "Last 30 days", 90: "Last 90 days" };
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
  const dayLabel = (ymd, long) => { const [y, m, d] = ymd.split("-").map(Number), dt = new Date(y, m - 1, d); return long ? dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
  const cancelCounts = () => { raf.forEach(cancelAnimationFrame); raf = []; };
  // Numbers count up from 0 (instantly under reduced motion).
  function countUp(el, to, suffix = "") {
    if (RMQ.matches || !to) { el.textContent = to + suffix; return; }
    const t0 = performance.now(), dur = 1000;
    const step = (now) => { const p = Math.min(1, (now - t0) / dur); el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))) + suffix; if (p < 1) raf.push(requestAnimationFrame(step)); };
    raf.push(requestAnimationFrame(step));
  }
  const BADGE = (r) => r.escLevel === "urgent" ? ["sent", "Urgent"] : r.escLevel ? ["sent", r.escChat === "housekeeping" ? "HK chat" : "FD chat"] : r.answered ? ["ok", "Answered"] : r.notHelpful ? ["miss", "Not helpful"] : ["miss", "Not covered"];
  const ago = (d) => { const m = Math.round((Date.now() - new Date(d)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : fmtD(d); };

  function chartHtml(d) {
    const days = d.days, max = Math.max(1, ...days.map((x) => x.total)), n = days.length, step = n <= 7 ? 1 : n <= 30 ? 5 : 15;
    const total = days.reduce((a, x) => a + x.total, 0), sent = days.reduce((a, x) => a + x.sent, 0);
    const aria = `${RANGE_SUB[d.range]}: ${total} question${total === 1 ? "" : "s"}, ${sent} sent to a manager${total ? `. Busiest day ${dayLabel(days.reduce((b, x) => (x.total > b.total ? x : b)).day)}` : ""}`;
    const cols = days.map((x, i) => `<div class="dcol" title="${esc(dayLabel(x.day, true))}: ${x.total} question${x.total === 1 ? "" : "s"}${x.sent ? `, ${x.sent} sent to a manager` : ""}">${n <= 7 ? `<span class="dval">${x.total}</span>` : ""}<div class="dstack"><div class="dseg sent" data-q="${x.sent ? (x.sent / max).toFixed(4) : 0}"></div><div class="dseg ans" data-q="${x.total - x.sent ? ((x.total - x.sent) / max).toFixed(4) : 0}"></div></div></div>`).join("");
    const axis = days.map((x, i) => `<span class="dax"><i>${(n - 1 - i) % step === 0 ? (n <= 7 ? dayLabel(x.day, true).split(",")[0] : dayLabel(x.day)) : ""}</i></span>`).join("");
    return { total, html: `<div class="dbars n${n}" role="img" aria-label="${esc(aria)}">${cols}</div><div class="daxis n${n}" aria-hidden="true">${axis}</div>` };
  }
  function bodyHtml(d, enter) {
    const r = enter ? " rise" : "", k = d.kpi, delay = (i) => (enter ? ` style="--d:${(0.1 + i * 0.06).toFixed(2)}s"` : "");
    if (d.empty) return html`<section class="dcard dempty${r}" ${delay(0)} aria-label="No questions yet"><span class="deico">${ic("chat")}</span><h2>No questions yet</h2><p>When staff start asking in the chat, ${esc(hotelName(STATE.hotel))}'s numbers show up here: how many questions, how many an SOP answered, and what the desk asks most.</p><button type="button" class="gbtn dark press" data-go="chat">Open chat</button></section>`;
    const ch = chartHtml(d), C = 490.1;
    const kp = [
      ["Questions", k.questions, "", RANGE_SUB[d.range].toLowerCase(), "chat", "activity"],
      ["Answered", k.answeredPct, "%", `${k.answered} of ${k.questions} had an SOP`, "check", "activity"],
      ["Waiting for an SOP", k.waiting, "", "in Unanswered", "gaps", "gaps"],
      ["Sent to chat", k.sentChat, "", k.sentUrgent ? `${k.sentUrgent} urgent call${k.sentUrgent === 1 ? "" : "s"}` : "none urgent", "send", "activity"],
    ];
    const tmax = Math.max(1, ...d.topics.map((t) => t.n));
    return html`<div class="drow">
      <section class="dcard dchart${r}" ${delay(0)} aria-label="Questions per day">
        <div class="dhd"><div><h2>Questions from the desk</h2><div class="dsub">${RANGE_SUB[d.range]} · ${ch.total} question${ch.total === 1 ? "" : "s"}</div></div>
          <div class="rng" role="group" aria-label="Range">${[7, 30, 90].map((v) => `<button type="button" data-r="${v}" aria-pressed="${v === d.range}">${v} days</button>`).join("")}</div></div>
        <div class="dleg"><span><i class="lg ans"></i>Questions</span><span><i class="lg sent"></i>Sent to a manager</span></div>
        ${ch.html}
      </section>
      <section class="dcard drate${r}" ${delay(1)} aria-label="Answer rate">
        <div><h2>Answer rate</h2><div class="dsub">Questions an SOP answered</div></div>
        <div class="dringw"><svg width="190" height="190" viewBox="0 0 190 190" role="img" aria-label="${k.answeredPct} percent of questions answered by an SOP"><circle cx="95" cy="95" r="78" fill="none" class="rtrack" stroke-width="14"/><circle class="dring" data-p="${k.answeredPct}" cx="95" cy="95" r="78" fill="none" stroke="url(#rg)" stroke-width="14" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}" transform="rotate(-90 95 95)"/><defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="g1"/><stop offset="1" class="g2"/></linearGradient></defs></svg>
          <div class="dring-t"><span><b data-count="${k.answeredPct}" data-suf="%">0%</b><small>answered</small></span></div></div>
        <div class="dmini"><div><b data-count="${d.rate.byAi}">0</b><small>By AI</small></div><div><b data-count="${d.rate.askedBack}">0</b><small>Asked back</small></div><div><b data-count="${d.rate.notCovered}">0</b><small>Not covered</small></div></div>
      </section></div>
    <div class="dkpis">${kp.map(([label, v, suf, sub, icon, go], i) => html`<button type="button" class="dcard dkpi lift${r}" ${delay(i + 2)} data-go="${go}"><span class="kico">${ic(icon, 2)}</span><b class="kv" data-count="${v}" data-suf="${suf}">0${suf}</b><span class="kl">${label}</span><span class="ks">${esc(sub)}</span></button>`).join("")}</div>
    <div class="drow">
      <section class="dcard dtop${r}" ${delay(6)} aria-label="Top topics"><h2>What the desk asks most</h2>
        ${d.topics.length ? d.topics.map((t) => `<button type="button" class="trow" data-sop="${esc(t.sop)}" aria-label="Open ${esc(t.title)}"><span class="tt"><span>${esc(t.title)}</span><b>${t.n}</b></span><span class="ttrack"><i class="dfill" data-w="${(t.n / tmax) * 100}"></i></span></button>`).join("") : `<p class="dnone">No answered questions in this range.</p>`}
      </section>
      <section class="dcard dfeed${r}" ${delay(7)} aria-label="Recent questions"><div class="dhd"><h2>Recent questions</h2><button type="button" class="dlink" data-go="activity">See all activity</button></div>
        ${d.recent.map((x) => { const [c, t] = BADGE(x); return `<button type="button" class="frow" data-go="activity"><span class="av" style="background:${color(x.id)}">${esc(initials(x.user))}</span><span class="fb2"><span class="fq">${esc(x.q)}</span><span class="fm">${esc(x.user)} · ${ago(x.when)}${x.sop ? " · " + esc(x.sop) : ""}</span></span><span class="fbg ${c}">${t}</span></button>`; }).join("")}
      </section></div>`;
  }
  // Plays the motion after the markup is in: bars grow, the ring fills, numbers count up.
  function animate(root) {
    cancelCounts();
    root.querySelectorAll("[data-count]").forEach((el) => countUp(el, +el.dataset.count, el.dataset.suf || ""));
    const C = 490.1, ring = root.querySelector(".dring");
    const go = () => {
      const bars = root.querySelector(".dbars"), H = bars ? bars.clientHeight - (bars.classList.contains("n7") ? 26 : 6) : 0;
      root.querySelectorAll(".dseg").forEach((el, i) => { const r = +el.dataset.q; el.style.transitionDelay = RMQ.matches ? "0s" : Math.min(0.9, Math.floor(i / 2) * 0.03) + "s"; el.style.height = r ? Math.max(4, r * H) + "px" : "0px"; });
      root.querySelectorAll(".dfill").forEach((el, i) => { el.style.transitionDelay = RMQ.matches ? "0s" : 0.3 + i * 0.07 + "s"; el.style.width = el.dataset.w + "%"; });
      if (ring) ring.style.strokeDashoffset = (C * (1 - ring.dataset.p / 100)).toFixed(1);
    };
    if (RMQ.matches) go(); else requestAnimationFrame(() => requestAnimationFrame(go));
  }
  function paintDash(enter) {
    const box = $("dashBody"), hadFocus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.r : null;
    box.innerHTML = bodyHtml(dash, enter);
    if (hadFocus) { const b = box.querySelector(`[data-r="${hadFocus}"]`); if (b) b.focus({ preventScroll: true }); }
    animate(box);
  }
  function dashClick(e) {
    const r = e.target.closest("[data-r]"), g = e.target.closest("[data-go]"), s = e.target.closest("[data-sop]");
    if (r) { const v = +r.dataset.r; if (v !== range) { range = v; loadDash(false); } }
    else if (s) { if (sop(s.dataset.sop)) openSop(s.dataset.sop); }
    else if (g) navTo(g.dataset.go);
  }
  async function loadDash(enter) {
    const mine = ++token, hid = STATE.hotel;
    try {
      const d = await api(`/api/dashboard?range=${range}`);
      if (mine !== token || hid !== STATE.hotel || tab !== "dashboard") return;
      dash = d; range = d.range; paintDash(enter);
    } catch (e) { if (mine === token) { $("dashBody").innerHTML = `<div class="dcard dempty"><h2>Couldn't load the dashboard</h2><p>${esc(e.message)}</p></div>`; } }
  }
  /* ---------- Needs you: what waits on the GM at this hotel (GM and Owner) ---------- */
  let needs = null, needsTok = 0, needsBusy = false, nsKind = null;
  const canNeeds = () => isGM() && hotelObj().ready;
  const SG_INLINE = 3;
  const some = (list, max) => list.slice(0, max).join(", ") + (list.length > max ? ` and ${list.length - max} more` : "");
  function needRows(H) {
    const rows = [], sg = H.suggestions || [];
    // Suggestions from the other hotels in the brand group: the first few here, the rest in the review sheet.
    for (const x of sg.slice(0, SG_INLINE)) rows.push({ k: "sg" + x.id, sg: x });
    if (sg.length > SG_INLINE) rows.push({ k: "sgmore", icon: "add", title: `${plural(sg.length - SG_INLINE, "more suggestion")} from your sister hotels`, sub: some(sg.slice(SG_INLINE).map((x) => x.title), 3), btns: [["Review all", "review-sg", 1]] });
    if (H.drafts) rows.push({ k: "drafts", icon: "draft", title: `${plural(H.drafts, "draft")} to review`, sub: "Staff can't see drafts until you turn them on.", btns: [["Review drafts", "drafts", 1]] });
    for (const b of H.imports) rows.push({ k: "imp" + b.id, icon: "lib", title: `Upload waiting: ${some(b.files, 2) || "your upload"}`, sub: `${plural(b.open, "procedure")} to decide: use the guide's steps or keep yours.`, btns: [["Decide", "import", 1, b.id]] });
    if (H.missing.length) rows.push({ k: "missing", icon: "info", title: `${plural(H.missing.length, "hotel detail")} missing`, sub: `${some(H.missing, 4)}. Staff see "ask a manager" until they are filled in.`, btns: [["Fill in", "details", 1]] });
    return rows;
  }
  // One suggestion: where it came from and what it is, with Skip / Tweak / Add (new) or Keep mine / Tweak / Use (a change to ours).
  const sgBtns = (x) => (x.type === "new"
    ? [["Skip", "sg-skip", 0], ["Tweak", "sg-tweak", 0], ["Add", "sg-add", 1]]
    : [["Keep mine", "sg-keep", 0], ["Tweak", "sg-tweak", 0], ["Use", "sg-use", 1]]);
  const sgMeta = (x) => `${x.type === "new" ? "New" : x.label} · ${x.from.name}${x.cat ? " · " + x.cat : ""}`;
  function sgRow(x) {
    return `<li class="nrow sg"><span class="nico sgdot" aria-hidden="true"></span><div class="nbody"><div class="nrt">${esc(x.title)}</div><div class="nrs">${esc(sgMeta(x))}</div>
      <div class="nacts">${sgBtns(x).map(([label, a, main]) => `<button type="button" class="nbtn press${main ? " main" : ""}" data-a="${a}" data-id="${x.id}" aria-label="${esc(label + ": " + x.title)}">${label}</button>`).join("")}</div></div></li>`;
  }
  function paintNeeds(enter) {
    const box = $("needsBody");
    if (!needs || !canNeeds()) { box.hidden = true; box.innerHTML = ""; return; }
    const rows = needRows(needs), focus = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.a : null;
    box.hidden = false; box.classList.toggle("rise", !!enter);
    box.innerHTML = html`<div class="nhd"><div class="nt"><h2>Needs you</h2>${rows.length ? `<span class="nbadge" role="status" aria-label="${rows.length} waiting">${rows.length}</span>` : ""}</div>
      <div class="nq"><button type="button" class="gbtn sm press" data-a="details">${ic("info", 2)}Hotel details</button><button type="button" class="gbtn sm press" data-a="kit">${ic("kit", 2)}Welcome kit</button></div></div>
      ${rows.length ? `<ul class="nrows">${rows.map((r) => r.sg ? sgRow(r.sg) : `<li class="nrow"><span class="nico" aria-hidden="true">${ic(r.icon, 2)}</span><div class="nbody"><div class="nrt">${esc(r.title)}</div><div class="nrs">${esc(r.sub)}</div>
        <div class="nacts">${r.btns.map(([label, a, main, id]) => `<button type="button" class="nbtn press${main ? " main" : ""}" data-a="${a}" ${id !== undefined ? `data-id="${esc(id)}"` : ""}>${label}</button>`).join("")}</div></div></li>`).join("")}</ul>`
      : `<p class="nclear" role="status">All caught up. Nothing is waiting on you at this hotel.</p>`}`;
    if (focus) { const b = box.querySelector(`[data-a="${focus}"]`); if (b) b.focus({ preventScroll: true }); }
  }
  async function loadNeeds(enter) {
    if (!canNeeds()) { needs = null; paintNeeds(); return; }
    const mine = ++needsTok, hid = STATE.hotel;
    try {
      const H = await api("/api/home");
      if (mine !== needsTok || hid !== STATE.hotel || tab !== "dashboard" || mode !== "admin") return;
      needs = H; paintNeeds(enter);
    } catch (e) { if (mine === needsTok) { needs = null; paintNeeds(); } }
  }
  // After anything is handled: the SOPs may have changed, so reload them, then the card.
  async function handled(msg) {
    if (msg) toast(msg);
    try { await loadHotel(); } catch { /* the card still refreshes */ }
    renderNav();
    const mine = ++needsTok;
    try { const H = await api("/api/home"); if (mine === needsTok) { needs = H; paintNeeds(); if (nsKind) paintSheet(); } } catch (e) { fail(e); }
  }
  const post = (path) => api(path, { body: {} });
  const enc = encodeURIComponent;
  async function needsRun(fn, msg) {
    if (needsBusy) return;
    needsBusy = true; document.querySelectorAll("#needsBody .nbtn,#needsList .pillbtn").forEach((x) => (x.disabled = true));
    try { await fn(); await handled(msg); } catch (e) { fail(e); await handled(); }
    needsBusy = false;
  }
  const goSetup = (view) => { SU.step = 0; WZ.celebrate = false; SU.backTab = "dashboard"; go(view); };
  function needsClick(e) {
    const b = e.target.closest("[data-a]"); if (!b || needsBusy) return;
    const a = b.dataset.a, id = b.dataset.id;
    if (a === "details" || a === "kit") goSetup(a);
    else if (a === "review-sg") openSheet("sg");
    else if (a === "drafts") { libDraft = true; cat = ""; renderCatPills(); navTo("sops"); }
    else if (a === "import") studioOpenBatch(+id);
    else if (a.startsWith("sg-")) sgAct(a.slice(3), +id);
  }
  const SG_MSG = { add: "Added. Staff can ask about it now", use: "Updated to the group's wording", keep: "Kept yours", skip: "Skipped" };
  async function sgAct(act, id) {
    if (act === "tweak") {
      if (needsBusy) return; needsBusy = true;
      try {
        const out = await api(`/api/suggestions/${id}/seed`);
        needsBusy = false; if (!sheet.hidden) hideSheet();
        studioOpen({ target: STATE.hotel, seed: out.draft, sopId: out.sopId, suggestion: out.id });
      } catch (e) { needsBusy = false; fail(e); await handled(); }
      return;
    }
    needsRun(() => post(`/api/suggestions/${id}/${act}`), SG_MSG[act]);
  }
  // The review sheet: every suggestion, with the same buttons.
  function openSheet(kind) { nsKind = kind; paintSheet(); showSheet("needsEd"); }
  function paintSheet() {
    const list = needs ? needs.suggestions || [] : [];
    if (!list.length) { nsKind = null; if (!sheet.hidden) hideSheet(); return; }
    $("needsTitle").textContent = "From your sister hotels";
    $("needsList").innerHTML = `<div class="group">${list.map((x) => `<div class="cell upd"><span class="body"><span class="t wrap">${esc(x.title)}</span><span class="m wrapm">${esc(sgMeta(x))}</span></span>
      <span class="acts">${sgBtns(x).map(([label, a, main]) => `<button type="button" class="pillbtn press${main ? " tint" : ""}" data-sg="${a}" data-id="${x.id}" aria-label="${esc(label + ": " + x.title)}">${label}</button>`).join("")}</span></div>`).join("")}</div>`;
    $("needsFoot").textContent = "Add and Use put the group's wording at your hotel. Keep mine and Skip leave your SOPs as they are. Tweak opens it in the studio first.";
  }
  function sheetClick(e) {
    const b = e.target.closest("button[data-sg]"); if (!b || needsBusy) return;
    sgAct(b.dataset.sg.slice(3), +b.dataset.id);
  }
  new MutationObserver(() => { if (sheet.hidden) nsKind = null; }).observe(sheet, { attributes: true, attributeFilter: ["hidden"] });

  function renderDashboard() {
    const u = STATE.me;
    $("dashHello").textContent = `${greeting()}, ${u.name.split(" ")[0]}`;
    $("dashSub").textContent = `${hotelName(STATE.hotel)} · the desk at a glance`;
    $("dashBody").innerHTML = "";
    needs = null; paintNeeds();
    loadNeeds(true);
    loadDash(true);
  }
  return { init, renderNav, renderDashboard, renderSettingsPage, applyHotelAccent, current };
})();
