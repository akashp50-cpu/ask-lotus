// Prints what the brand-group migration (db/groups.js) would change, without changing anything.
//   DATABASE_URL=postgres://... node scripts/groups-dryrun.js
// Per hotel: group, SOP counts by kind (existing kinds are kept; unclassified rows get the heuristic's answer), families, copy source,
// and the pending master updates that the new Portfolio/suggestions model no longer shows (listed so you can see what is dropped).
const { pool } = require("../src/db");
const groups = require("../db/groups");

(async () => {
  const p = await groups.plan(pool);
  const pad = (s, n) => String(s).padEnd(n);
  console.log("HOTELS");
  console.log(pad("id", 6), pad("group", 24), pad("setup", 7), pad("SOPs", 5), pad("live", 5), pad("pms", 5), pad("general", 8), pad("brand", 6), pad("families", 9), pad("shared", 7), "source");
  for (const h of p.hotels) {
    console.log(pad(h.hotel, 6), pad(h.group, 24), pad(h.setup, 7), pad(h.total, 5), pad(h.live, 5), pad(h.kinds.pms, 5), pad(h.kinds.general, 8), pad(h.kinds.brand, 6), pad(h.families, 9), pad(h.shared, 7), h.source || "-");
  }
  console.log(`\nWOULD WRITE: family/kind/amenity on ${p.updates.length} SOP row(s); copy source on ${p.sources.length} hotel(s)`);
  for (const s of p.sources) console.log(`  ${s.hotel} will copy from ${s.source}${s.sameGroup ? "" : " (different group: general SOPs only)"}`);
  console.log(`\nPENDING MASTER UPDATES THAT ARE DROPPED: ${p.pending.length}`);
  for (const u of p.pending) console.log(`  ${u.hotel} ${u.sop} "${u.title}" is on master v${u.have}, master is at v${u.latest} (${u.status})`);
  console.log("\nNothing was changed: this script only reads. No SOP text, status or images are ever modified by the migration.");
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
