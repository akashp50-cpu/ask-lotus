// The brand-group migration: gives every SOP a family and a kind (and the amenity it needs), and every hotel with no SOPs a copy source.
// It only fills in NULLs, so it is safe to run on every deploy (db/migrate.js and db/seed.js both call it), and it never touches a SOP's text,
// status or images. plan() reads and reports; apply() writes the same thing.
const { classifyKind, familyOf, groupKey } = require("../src/groups");

// A dry run may be pointed at a database the schema step has not reached yet (the new columns are not there): they read as NULL.
async function has(c, table, column) {
  return (await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name=$1 AND column_name=$2", [table, column])).rows.length > 0;
}

async function plan(c) {
  const [cs, fam, kind, req] = await Promise.all([has(c, "hotels", "copy_source"), has(c, "sops", "family"), has(c, "sops", "kind"), has(c, "sops", "requires")]);
  const [hotels, rows] = await Promise.all([
    c.query(`SELECT id, name, brand, system, setup, ${cs ? "copy_source" : "NULL::text AS copy_source"} FROM hotels ORDER BY name`).then((r) => r.rows),
    c.query(
      `SELECT s.hotel_id, s.id, s.title, s.steps, s.script, s.flag, s.status, s.master_id, s.master_version,
              ${fam ? "s.family" : "NULL::text"} AS family, ${kind ? "s.kind" : "NULL::text"} AS kind, ${req ? "s.requires" : "NULL::text"} AS requires,
              m.applies AS m_applies, m.requires AS m_requires, m.version AS m_version
         FROM sops s LEFT JOIN master_sops m ON m.id = s.master_id ORDER BY s.hotel_id, s.id`
    ).then((r) => r.rows),
  ]);
  const updates = [];
  const per = new Map(hotels.map((h) => [h.id, { hotel: h, group: groupKey(h), total: 0, live: 0, kinds: { pms: 0, general: 0, brand: 0 }, families: new Set(), toClassify: 0, toFamily: 0 }]));
  const pending = [];
  for (const r of rows) {
    const p = per.get(r.hotel_id);
    if (!p) continue;
    const kind = r.kind || classifyKind(r, { applies: r.m_applies });
    const family = familyOf(r);
    const requires = r.requires || r.m_requires || null;
    p.total++; if (r.status === "live") p.live++;
    p.kinds[kind]++; p.families.add(family);
    if (!r.kind) p.toClassify++;
    if (!r.family) p.toFamily++;
    if (!r.kind || !r.family || (!r.requires && requires)) updates.push({ hotel: r.hotel_id, id: r.id, family, kind, requires });
    if (r.master_id && r.m_version != null && r.master_version != null && r.master_version < r.m_version) {
      pending.push({ hotel: r.hotel_id, sop: r.id, title: r.title, have: r.master_version, latest: r.m_version, status: r.status });
    }
  }
  // Hotels with no SOPs and no source yet: copy from the hotel in the same group with the most live SOPs (any group if the group has none).
  const sources = [];
  for (const h of hotels) {
    const p = per.get(h.id);
    if (h.copy_source || p.total) continue;
    const others = hotels.filter((o) => o.id !== h.id && per.get(o.id).total);
    const same = others.filter((o) => groupKey(o) === p.group);
    const pool = same.length ? same : others;
    const best = pool.sort((a, b) => per.get(b.id).live - per.get(a.id).live || (a.id < b.id ? -1 : 1))[0];
    if (best) sources.push({ hotel: h.id, source: best.id, sameGroup: same.length > 0 });
  }
  const famHotels = new Map();
  for (const p of per.values()) for (const f of p.families) famHotels.set(f, (famHotels.get(f) || 0) + 1);
  const summary = [...per.values()].map((p) => ({
    hotel: p.hotel.id, name: p.hotel.name, group: p.group, setup: p.hotel.setup, total: p.total, live: p.live, kinds: p.kinds,
    families: p.families.size, shared: [...p.families].filter((f) => famHotels.get(f) > 1).length,
    toClassify: p.toClassify, toFamily: p.toFamily,
    source: h2(hotels, p.hotel.id, sources),
  }));
  return { hotels: summary, updates, sources, pending };
}
const h2 = (hotels, id, sources) => (hotels.find((h) => h.id === id).copy_source) || (sources.find((s) => s.hotel === id) || {}).source || null;

async function apply(c) {
  const p = await plan(c);
  for (let i = 0; i < p.updates.length; i += 400) {
    const part = p.updates.slice(i, i + 400);
    await c.query(
      `UPDATE sops s SET family = COALESCE(s.family, x.f), kind = COALESCE(s.kind, x.k), requires = COALESCE(s.requires, x.r)
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS x(h, i, f, k, r)
        WHERE s.hotel_id = x.h AND s.id = x.i`,
      [part.map((u) => u.hotel), part.map((u) => u.id), part.map((u) => u.family), part.map((u) => u.kind), part.map((u) => u.requires)]
    );
  }
  for (const s of p.sources) await c.query("UPDATE hotels SET copy_source=$2 WHERE id=$1 AND copy_source IS NULL", [s.hotel, s.source]);
  return p;
}

module.exports = { plan, apply };
