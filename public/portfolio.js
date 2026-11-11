/* ---------- Owner: Portfolio ----------
   One tab per brand group (brand + PMS). A glass table: SOP families down the side (in collapsible category sections), the group's hotels across.
   Dots: solid = on, ring = off, orange = a suggestion is waiting, dash = the hotel doesn't have it. Tapping a dot turns the SOP on or off there
   (or adds it); tapping a title opens a view of the SOP as each hotel words it. "Add hotel" and "+" (brand or PMS) open sheets.
   Loaded before app.js: everything here runs after app.js has defined $, api, STATE, showSheet and friends. */
const PF = { data: null, hotels: null, g: null, f: "all", q: "", open: {}, busy: new Set(), from: null, add: null, prev: null };
const PF_FILTERS = [["all", "All"], ["diff", "Differences"], ["pms", "PMS"], ["general", "General"], ["brand", "Brand"]];
const PF_STATE = {
  on: ["On", "pd on"], off: ["Off", "pd off"], sug: ["suggestion waiting", "pd sug"], none: ["not there", "pd none"],
};
const pfKey = (g, sec) => g + "::" + sec;
const pfOpenGet = () => { try { return JSON.parse(localStorage.getItem("asklotus.pf.open") || "{}"); } catch { return {}; } };
const pfOpenSave = () => { try { localStorage.setItem("asklotus.pf.open", JSON.stringify(PF.open)); } catch { /* the sections still open and close */ } };

$("ownerBtn").onclick = () => { closeMenus(); go(mode === "owner" ? "admin" : "owner"); };

async function loadOwnerHotels() { STATE.owner.hotels = await api("/api/owner/hotels", { hotel: false }); }
async function loadPortfolio() { PF.data = await api("/api/owner/portfolio", { hotel: false }); }
// A change to a SOP or to the hotels: the Portfolio reloads next time it is drawn.
const portfolioStale = () => { PF.data = null; STATE.owner.hotels = null; };

async function renderOwner(refresh) {
  if (!isOwner()) return;
  if (!PF.open.__loaded) { PF.open = { ...pfOpenGet(), __loaded: true }; }
  if (refresh || !PF.data || !STATE.owner.hotels) {
    if (!PF.data) $("ownerSub").textContent = "Loading…";
    try { await Promise.all([loadPortfolio(), loadOwnerHotels()]); } catch (e) { fail(e); }
  }
  if (mode !== "owner" || !PF.data) return;
  const D = PF.data;
  if (!D.groups.some((g) => g.key === PF.g)) PF.g = D.groups.length ? D.groups[0].key : null;
  const hs = STATE.owner.hotels || [];
  $("ownerSub").textContent = `${hs.length} hotel${hs.length === 1 ? "" : "s"} · ${D.groups.length} brand group${D.groups.length === 1 ? "" : "s"}`;
  pfTabs(); pfTable(); pfHotelCards();
}
const pfGroup = () => (PF.data ? PF.data.groups.find((g) => g.key === PF.g) : null);

/* ---------- tabs ---------- */
function pfTabs() {
  const D = PF.data;
  $("pfTabs").innerHTML = D.groups.map((g) => `<button type="button" role="tab" class="pftab press" data-g="${esc(g.key)}" aria-selected="${g.key === PF.g}">${esc(g.name)}<span class="num">${g.hotels.length}</span></button>`).join("");
  $("pfTabs").querySelectorAll("[data-g]").forEach((b) => (b.onclick = () => { PF.g = b.dataset.g; PF.f = "all"; pfTabs(); pfTable(); }));
}

/* ---------- the table ---------- */
const pfTagHtml = (k) => (k === "pms" ? `<span class="pftag">PMS</span>` : k === "brand" ? `<span class="pftag">BRAND</span>` : "");
const pfDiffers = (sop) => new Set(sop.cells.map((c) => c.s).filter((s) => s !== "none")).size > 1 || (sop.cells.some((c) => c.s === "none") && sop.cells.some((c) => c.s !== "none") && sop.cells.length > 1);
function pfMatch(sop, sec) {
  if (PF.f === "diff" && !pfDiffers(sop)) return false;
  if (["pms", "general", "brand"].includes(PF.f) && sop.kind !== PF.f) return false;
  const q = norm(PF.q);
  return !q || norm(`${sop.title} ${sop.code} ${sop.kw} ${sec.name}`).includes(q);
}
function pfCellHtml(sop, hotel, c) {
  const [word, cls] = PF_STATE[c.s];
  const label = c.s === "sug" ? `${sop.title} at ${hotel.name}: suggestion waiting` : `${sop.title} at ${hotel.name}: ${word}`;
  const busy = PF.busy.has(sop.family + "|" + hotel.id) ? " busy" : "";
  return `<div role="cell" class="pf-c"><button type="button" class="pfdot press${busy}" data-f="${esc(sop.family)}" data-h="${esc(hotel.id)}" aria-label="${esc(label)}" title="${esc(label)}"><span class="${cls}"></span></button></div>`;
}
function pfTable() {
  const g = pfGroup(), root = $("pfBody");
  if (!g) { root.innerHTML = `<div class="empty">No hotels yet.</div>`; return; }
  const n = g.hotels.length, filtering = PF.f !== "all" || !!norm(PF.q);
  root.style.setProperty("--n", n);
  $("pfFilters").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.f === PF.f));
  const sections = g.sections.map((sec) => ({ sec, rows: sec.sops.filter((s) => pfMatch(s, sec)) })).filter((x) => !filtering || x.rows.length);
  const allKeys = g.sections.map((s) => pfKey(g.key, s.name)), anyOpen = allKeys.some((k) => PF.open[k]) || filtering;
  $("pfAll").textContent = anyOpen ? "Collapse all" : "Expand all"; $("pfAll").disabled = filtering;
  const head = `<div role="row" class="pf-row pf-hd"><div role="columnheader" class="pf-t"></div>${g.hotels.map((h) => `<div role="columnheader" class="pf-col" title="${esc(h.name)}"><b>${esc(h.short)}</b><span class="pfst"><i class="sd ${h.live ? "live" : h.setup === "new" ? "new" : "setup"}"></i>${esc(h.status)}</span></div>`).join("")}</div>`;
  let shown = 0;
  const body = sections.map(({ sec, rows }) => {
    const key = pfKey(g.key, sec.name), open = filtering || !!PF.open[key], total = sec.sops.length;
    const sums = g.hotels.map((h, i) => {
      const cs = sec.sops.map((s) => s.cells[i]);
      if (cs.every((c) => c.s === "none")) return `<div role="cell" class="pf-c pf-sum dim">–</div>`;
      const on = cs.filter((c) => c.s === "on" || (c.s === "sug" && c.b === "on")).length, sug = cs.some((c) => c.s === "sug");
      return `<div role="cell" class="pf-c pf-sum${on === total ? " full" : ""}">${sug ? `<i class="sugdot" title="A suggestion is waiting" aria-label="suggestion waiting"></i>` : ""}${on}/${total}</div>`;
    }).join("");
    const secHtml = `<div role="row" class="pf-row pf-sec"><button type="button" class="pf-t pf-secbtn" data-sec="${esc(key)}" aria-expanded="${open}" ${filtering ? "disabled" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg><span class="pf-secname">${esc(sec.name)}</span><span class="num">${filtering ? rows.length : total}</span></button>${sums}</div>`;
    if (!open) return secHtml;
    shown += rows.length;
    return secHtml + rows.map((s) => `<div role="row" class="pf-row pf-item"><div role="rowheader" class="pf-t"><button type="button" class="pf-title" data-view="${esc(s.family)}" aria-label="Open ${esc(s.title)}, ${esc(s.code)}">${esc(s.title)}</button>${pfTagHtml(s.kind)}</div>${g.hotels.map((h, i) => pfCellHtml(s, h, s.cells[i])).join("")}</div>`).join("");
  }).join("");
  const empty = filtering && !sections.length ? `<div class="pf-empty">${PF.f === "diff" ? "No differences in this group" : "Nothing here"}</div>` : "";
  root.setAttribute("role", "table"); root.setAttribute("aria-label", `SOPs by hotel, ${g.name}`);
  root.innerHTML = head + body + empty;
}
$("pfBody").addEventListener("click", (e) => {
  const sec = e.target.closest("[data-sec]");
  if (sec) { const k = sec.dataset.sec; PF.open[k] = !PF.open[k]; pfOpenSave(); return pfTable(); }
  const v = e.target.closest("[data-view]");
  if (v) return pfOpenView(v.dataset.view);
  const d = e.target.closest(".pfdot");
  if (d) pfTap(d.dataset.f, d.dataset.h);
});
$("pfAll").onclick = () => {
  const g = pfGroup(); if (!g) return;
  const keys = g.sections.map((s) => pfKey(g.key, s.name)), anyOpen = keys.some((k) => PF.open[k]);
  keys.forEach((k) => (PF.open[k] = !anyOpen)); pfOpenSave(); pfTable();
};
$("pfFilters").innerHTML = PF_FILTERS.map(([k, l]) => `<button type="button" class="pfseg" data-f="${k}" aria-pressed="${k === "all"}">${l}</button>`).join("");
$("pfFilters").onclick = (e) => { const b = e.target.closest("[data-f]"); if (b) { PF.f = b.dataset.f; pfTable(); } };
$("pfSearch").oninput = (e) => { PF.q = e.target.value; pfTable(); };
$("pfKey").innerHTML = [["on", "On"], ["off", "Off"], ["sug", "Suggestion"], ["none", "Not there"]].map(([k, l]) => `<span><i class="pd ${k}"></i>${l}</span>`).join("");

// Tap a dot: on <-> off, or add it where the hotel doesn't have it. A suggestion is the GM's call, so it only says so.
async function pfTap(family, hid) {
  const g = pfGroup(); if (!g) return;
  const i = g.hotels.findIndex((h) => h.id === hid), sop = g.sections.flatMap((s) => s.sops).find((s) => s.family === family);
  if (i < 0 || !sop) return;
  const H = g.hotels[i], c = sop.cells[i], key = family + "|" + hid;
  if (!H.live) return toast(`${H.name} isn't live yet. Its GM picks the SOPs during setup.`);
  if (c.s === "sug") return toast(`A suggestion is waiting at ${H.short}. Its GM decides.`);
  if (PF.busy.has(key)) return;
  const was = { s: c.s, b: c.b }, on = c.b !== "on";
  c.s = c.b = on ? "on" : "off"; PF.busy.add(key); pfTable();
  const keep = document.querySelector(`.pfdot[data-f="${CSS.escape(family)}"][data-h="${CSS.escape(hid)}"]`); if (keep) keep.focus({ preventScroll: true });
  try {
    const out = await api(`/api/owner/hotels/${encodeURIComponent(hid)}/sops/${encodeURIComponent(family)}`, { hotel: false, method: "PUT", body: { on } });
    toast(`${sop.title} is ${on ? (was.s === "none" ? "added and on" : "on") : "off"} at ${H.short}`);
    if (was.s === "none") { portfolioStale(); await renderOwner(true); } else if (out && out.id) c.id = out.id;
  } catch (e) { c.s = was.s; c.b = was.b; fail(e); }
  PF.busy.delete(key); pfTable();
  const back = document.querySelector(`.pfdot[data-f="${CSS.escape(family)}"][data-h="${CSS.escape(hid)}"]`); if (back) back.focus({ preventScroll: true });
}

/* ---------- a SOP, as each hotel has it ---------- */
async function pfOpenView(family) {
  try {
    const d = await api(`/api/owner/sop?family=${encodeURIComponent(family)}`, { hotel: false });
    const one = d.hotels[0];
    $("svTitle").textContent = one.title;
    $("svBody").innerHTML = d.hotels.map((h, i) => {
      const steps = (h.steps || []).map((s, j) => `<li><span class="num">${j + 1}</span><span>${chipify(s.t)}${s.img ? `<img class="svimg" alt="Photo for step ${j + 1}" src="${imgUrl(s.img)}">` : ""}</span></li>`).join("");
      return `<details class="svh" ${i === 0 ? "open" : ""}><summary><b>${esc(h.hotelName)}</b><span class="status ${h.status === "live" ? "ok" : "off"}">${h.status === "live" ? "On" : h.status === "off" ? "Off" : "Draft"}</span><small>${esc(h.id)} · ${esc(KIND_NAME[h.kind] || h.kind)}</small></summary>
        <ol class="svsteps">${steps}</ol>${h.script ? `<p class="svl"><b>Say</b> ${chipify(h.script)}</p>` : ""}${h.flag ? `<p class="svl"><b>Call</b> ${chipify(h.flag)}</p>` : ""}</details>`;
    }).join("");
    showSheet("sopView");
  } catch (e) { fail(e); }
}

/* ---------- hotels (status, GM, open as GM) ---------- */
function pfHotelCards() {
  const hs = STATE.owner.hotels;
  if (!hs) { $("hotelCards").innerHTML = ""; return; }
  const pill = (h) => (h.setup === "live" ? `<span class="ppill ok">Live</span>` : h.setup === "setup" ? `<span class="ppill warn">Setting up</span>` : `<span class="ppill">Not started</span>`);
  $("hotelCards").innerHTML = hs.map((h, i) => {
    const gms = h.gms.filter((g) => g.status === "active"), live = h.setup === "live";
    const gm = gms.length ? `${gms.length === 1 ? "GM" : "GMs"}: ${gms.map((g) => esc(g.name) + (g.must_change_pw ? " <small>(invited)</small>" : "")).join(", ")}` : "No GM yet";
    return `<article class="dcard pcard lift rise" style="--d:${(0.05 + i * 0.05).toFixed(2)}s" data-id="${esc(h.id)}" aria-label="${esc(h.name)}">
      <div class="pc-top"><div class="pc-id"><h2>${esc(h.name)}</h2><div class="pc-meta">${esc(brandName(h))} · ${esc(pmsFullName(h))}</div></div>${pill(h)}</div>
      ${live ? `<div class="pc-nums"><div><b>${h.live}</b><span>SOPs on</span></div><div><b>${h.total - h.live}</b><span>off or draft</span></div></div>` : `<div data-prog="${esc(h.id)}">${ownerProgressHtml(h)}</div>`}
      <div class="pc-gm">${gm}</div>
      <div class="pc-acts"><button type="button" class="gbtn dark press" data-open="${esc(h.id)}" aria-label="Open ${esc(h.name)} as GM">Open as GM</button>${!gms.length ? `<button type="button" class="gbtn press" data-gm="${esc(h.id)}">Invite GM</button>` : live ? "" : `<button type="button" class="gbtn press" data-remind="${esc(h.id)}">Copy reminder</button>`}</div>
    </article>`;
  }).join("");
  const box = $("hotelCards");
  box.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => selectHotel(b.dataset.open, "admin")));
  box.querySelectorAll("[data-gm]").forEach((b) => (b.onclick = () => openUser(null, { role: "GM", hotels: [b.dataset.gm] })));
  box.querySelectorAll(".pcard").forEach(wzBindCopy);
  loadOwnerProgress();
}

/* ---------- Add hotel: name, brand, PMS, copy from, and what would be copied ---------- */
function pfChips(el, opts, cur, pick, label) {
  el.setAttribute("role", "radiogroup"); el.setAttribute("aria-label", label);
  el.innerHTML = opts.map(([v, l]) => `<button type="button" class="pfchip press" role="radio" data-v="${esc(v)}" aria-checked="${v === cur}">${esc(l)}</button>`).join("");
  el.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => pick(b.dataset.v)));
}
function pfAddOpen(brand, system) {
  const D = PF.data; if (!D) return;
  const g = pfGroup(), brands = D.brands, pmsl = D.pms;
  PF.add = { brand: brand || (g && g.brand) || (brands[0] || {}).id, system: system || (g && g.pms) || (pmsl[0] || {}).id, from: null };
  const sameGroup = D.hotels.filter((h) => h.brand === PF.add.brand && h.system === PF.add.system && h.setup === "live");
  PF.add.from = (sameGroup[0] || D.hotels.find((h) => h.setup === "live") || {}).id || "";
  $("h-name").value = "";
  pfAddPaint(); showSheet("hotelEd"); setTimeout(() => $("h-name").focus(), 380);
}
function pfAddPaint() {
  const D = PF.data, A = PF.add;
  pfChips($("h-brand"), D.brands.map((b) => [b.id, b.name]), A.brand, (v) => { A.brand = v; pfAddPaint(); }, "Brand");
  pfChips($("h-system"), D.pms.map((p) => [p.id, p.name]), A.system, (v) => { A.system = v; pfAddPaint(); }, "PMS");
  const live = D.hotels.filter((h) => h.setup === "live");
  pfChips($("h-from"), [...live.map((h) => [h.id, h.short]), ["", "Start empty"]], A.from, (v) => { A.from = v; pfAddPaint(); }, "Copy SOPs from");
  pfPreview();
}
async function pfPreview() {
  const A = PF.add, box = $("h-prev"), tok = (PF.prevTok = (PF.prevTok || 0) + 1);
  if (!A.from) { box.innerHTML = `<p class="hint">The hotel starts with no SOPs. Its GM writes them, or you copy from a hotel later.</p>`; return; }
  box.innerHTML = `<div class="pfprev dim">Checking…</div>`;
  try {
    const p = await api(`/api/owner/copy-preview?from=${encodeURIComponent(A.from)}&brand=${encodeURIComponent(A.brand)}&system=${encodeURIComponent(A.system)}`, { hotel: false });
    if (tok !== PF.prevTok) return;
    const cell = (n, label, o) => `<div class="pfpv${!o.n ? " none" : o.copied ? "" : " out"}"><b>${o.n}</b><span>${label}</span><em>${!o.n ? "None" : o.copied ? "Copied" : "Left out"}</em></div>`;
    box.innerHTML = `<div class="pfprev" role="group" aria-label="What would be copied">${cell(0, "General", p.general)}${cell(0, "PMS steps", p.pms)}${cell(0, "Brand program", p.brand)}</div>
      <p class="hint">General SOPs always copy. PMS steps copy only when the PMS matches, and brand programs only when the brand matches. Copies start on or off exactly as at ${esc((D => (D.hotels.find((h) => h.id === A.from) || {}).short)(PF.data))}.</p>`;
  } catch (e) { if (tok === PF.prevTok) box.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
}
$("hotelEd").addEventListener("submit", async (e) => {
  e.preventDefault();
  const A = PF.add, body = { name: $("h-name").value.trim(), brand: A.brand, system: A.system, copyFrom: A.from || null };
  if (!body.name) { $("h-name").focus(); toast("Add the hotel's name"); return; }
  const btn = $("hotelEd").querySelector(".done"); btn.disabled = true;
  try {
    const out = await api("/api/owner/hotels", { hotel: false, body });
    hideSheet(); portfolioStale(); await refreshMe(); PF.g = `${body.brand}|${body.system}`;
    toast(`Added ${body.name}${out.copied ? ` · ${out.total} SOPs copied` : ""}`); renderOwner(true);
  } catch (x) { fail(x); }
  btn.disabled = false;
});

/* ---------- "+" : add a brand or a PMS ---------- */
let pfListKind = "brand", pfPmsEdit = null;
function pfListOpen() {
  pfListKind = "brand"; pfPmsEdit = null; pfListPaint(); showSheet("listEd");
}
function pfListPaint() {
  const D = PF.data, brand = pfListKind === "brand";
  pfChips($("l-kind"), [["brand", "Brand"], ["pms", "PMS"]], pfListKind, (v) => { pfListKind = v; pfPmsEdit = null; pfListPaint(); }, "What to add");
  $("l-brandf").hidden = !brand; $("l-pmsf").hidden = brand;
  $("l-list").innerHTML = (brand ? D.brands : D.pms).map((x) => `<div class="cell"><span class="body"><span class="t">${esc(x.name)}</span>${brand ? "" : `<span class="m">Staff say "${esc(x.staff || x.name)}"</span>`}</span>${brand ? "" : `<button type="button" class="pillbtn press" data-edit="${esc(x.id)}">Edit</button>`}</div>`).join("");
  $("l-list").querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => { pfPmsEdit = D.pms.find((p) => p.id === b.dataset.edit); pfListPaint(); }));
  if (!brand) {
    const p = pfPmsEdit;
    $("l-pname").value = p ? p.name : ""; $("l-pstaff").value = p ? p.staff || "" : ""; $("l-prules").value = p ? p.rules || "" : "";
    $("l-psave").textContent = p ? "Save PMS" : "Add PMS";
  }
}
$("pfPlus").onclick = pfListOpen;
$("l-bsave").onclick = async () => {
  const name = $("l-bname").value.trim(); if (!name) { $("l-bname").focus(); return toast("Add the brand's name"); }
  try { await api("/api/owner/brands", { hotel: false, body: { name } }); $("l-bname").value = ""; await loadPortfolio(); await refreshMe(); pfListPaint(); toast(`Added ${name}`); } catch (e) { fail(e); }
};
$("l-psave").onclick = async () => {
  const body = { name: $("l-pname").value.trim(), staff: $("l-pstaff").value.trim(), rules: $("l-prules").value.trim() };
  if (!body.name) { $("l-pname").focus(); return toast("Add the PMS name"); }
  try {
    if (pfPmsEdit) await api(`/api/owner/pms/${encodeURIComponent(pfPmsEdit.id)}`, { hotel: false, method: "PUT", body });
    else await api("/api/owner/pms", { hotel: false, body });
    pfPmsEdit = null; await loadPortfolio(); await refreshMe(); pfListPaint(); toast(`Saved ${body.name}`);
  } catch (e) { fail(e); }
};
$("listEd").addEventListener("submit", (e) => e.preventDefault());
$("newHotel").onclick = () => pfAddOpen();
$("pfAdd2").onclick = () => pfAddOpen();
