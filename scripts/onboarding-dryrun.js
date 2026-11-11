#!/usr/bin/env node
// Read-only dry run of the onboarding migration (db/onboarding.js). Writes nothing.
//   DATABASE_URL=... node scripts/onboarding-dryrun.js [--hotel hop] [--json]
// Per hotel it prints: the fields merged, the values carried, the values now derived, the questions newly unanswered, and the key safety check:
// every live SOP is rendered through the same token resolver BEFORE (stored details) and AFTER (migrated details + resolver), and the strings compared.
//   identical        the text is byte-for-byte the same
//   filled           a token that read "ask a manager" now has a value (allowed: the hotel gained a derived value)
//   CHANGED          a token that had a value now reads differently (this must be zero)
const { pool } = require("../src/db");
const onboarding = require("../db/onboarding");
const D = require("../src/details");
const ob = require("../src/onboard");
const { tokKey, tokenFiller, forModel, UNSET } = require("../src/tokens");

const args = process.argv.slice(2);
const only = args.includes("--hotel") ? args[args.indexOf("--hotel") + 1] : null;
const asJson = args.includes("--json");

// before: the hotel's stored details as the app renders them today. after: migrated details through the resolver.
function renderDiff(sops, contacts, beforeCtx, afterCtx) {
  const out = { total: sops.length, identical: 0, filled: 0, changed: 0, examples: [] };
  const fillB = tokenFiller(contacts, beforeCtx.details), fillA = tokenFiller(contacts, afterCtx.details);
  for (const sop of sops) {
    const b = forModel(sop, contacts, beforeCtx.details), a = forModel(sop, contacts, afterCtx.details);
    if (JSON.stringify(b) === JSON.stringify(a)) { out.identical++; continue; }
    // Which tokens differ, and how.
    const text = [sop.title, ...(sop.steps || []).map((x) => (typeof x === "string" ? x : x.t)), sop.script, sop.flag].join("\n");
    let bad = false;
    const notes = [];
    for (const m of new Set([...text.matchAll(/\{([^{}]+)\}/g)].map((x) => x[1]))) {
      const tb = fillB(`{${m}}`), ta = fillA(`{${m}}`);
      if (tb === ta) continue;
      if (tb === UNSET || /\[FILL/.test(tb)) notes.push(`${m}: ask-a-manager -> "${ta.slice(0, 50)}"`);
      else { bad = true; notes.push(`${m}: "${tb.slice(0, 50)}" -> "${ta.slice(0, 50)}"`); }
    }
    if (bad) out.changed++; else out.filled++;
    if (out.examples.length < 8 || bad) out.examples.push({ sop: sop.id, bad, notes });
  }
  return out;
}

(async () => {
  const plans = (await onboarding.plan(pool)).filter((p) => !only || p.id === only);
  const report = [];
  let fallbackSops = null;
  for (const p of plans) {
    let sops = (await pool.query("SELECT id, title, steps, script, flag FROM sops WHERE hotel_id=$1 AND status='live' ORDER BY id", [p.id])).rows;
    let sopSource = "this hotel's live SOPs";
    if (!sops.length) {
      fallbackSops = fallbackSops || (require("../db/seed-data/hampton-sops.json").sops || []).map((s) => ({ id: s.id, title: s.title, steps: s.steps, script: s.script, flag: s.flag }));
      sops = fallbackSops; sopSource = "the Hampton SOP set (this hotel has none yet)";
    }
    const contacts = (await pool.query("SELECT role, name, phone FROM contacts WHERE hotel_id=$1", [p.id])).rows;
    const beforeRes = { details: p.before.details };
    const afterResolved = D.resolveFull(p.after.details, { answers: p.after.answers, rooms: p.after.rooms });
    const diff = renderDiff(sops, contacts, beforeRes, { details: afterResolved.details });
    // Questions the hotel would now see that have no usable answer. Uses every SOP that is on as "used".
    const byKey = new Map(Object.keys(afterResolved.details).map((k) => [tokKey(k), k]));
    const used = new Set();
    for (const s of sops) for (const m of JSON.stringify([s.title, s.steps, s.script, s.flag]).matchAll(/\{([^{}"\\]+)\}/g)) { const k = byKey.get(tokKey(m[1])) || (D.fieldOf(m[1]) || {}).key; if (k) used.add(k); }
    const qs = ob.applicable({ answers: p.after.answers, details: p.after.details, used: [...used] });
    const unanswered = qs.filter((q) => !q.filled).map((q) => q.key + (q.field.type === "percent" && D.rawGet(p.after.details, q.key) ? ` (existing value "${D.rawGet(p.after.details, q.key)}" is not a percent; kept, shown as unanswered)` : ""));
    const kept = Object.keys(p.before.details).filter((k) => !(k in p.after.details));
    report.push({
      hotel: p.id, name: p.name, setup: p.setup, sopSource,
      merged: p.merged, carried: p.changes,
      derived: afterResolved.derived.map((d) => `${d.key} = ${String(d.value).replace(/\n/g, " / ").slice(0, 70)} [${d.via}]`),
      rooms: p.after.rooms ? { types: p.after.rooms.types.length, total: p.after.rooms.types.reduce((n, t) => n + (t.count || 0), 0), accessible: p.after.rooms.types.filter((t) => t.accessible).map((t) => t.code) } : null,
      newlyUnanswered: unanswered, keysLost: kept, wouldWrite: p.write, renderDiff: diff,
    });
  }
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else for (const r of report) {
    console.log(`\n=== ${r.hotel} · ${r.name} (${r.setup}) ===`);
    console.log(`Fields merged (${r.merged.length}): ${r.merged.join("; ") || "none"}`);
    console.log(`Values carried (${r.carried.length}):${r.carried.map((c) => "\n   " + c).join("") || " none"}`);
    console.log(`Room inventory: ${r.rooms ? `${r.rooms.types} types, ${r.rooms.total} rooms, accessible: ${r.rooms.accessible.join(", ") || "none"}` : "none"}`);
    console.log(`Derived values now available (${r.derived.length}):${r.derived.map((d) => "\n   " + d).join("") || " none"}`);
    console.log(`Questions newly unanswered (${r.newlyUnanswered.length}): ${r.newlyUnanswered.join("; ") || "none"}`);
    console.log(`Old keys lost: ${r.keysLost.length ? r.keysLost.join(", ") : "none (every old key is kept)"}`);
    const d = r.renderDiff;
    console.log(`Render check on ${r.sopSource}: ${d.total} SOPs · identical ${d.identical} · filled-where-blank ${d.filled} · CHANGED ${d.changed}`);
    for (const e of d.examples) console.log(`   ${e.bad ? "CHANGED" : "filled "} ${e.sop}: ${e.notes.join(" | ")}`);
  }
  await pool.end();
  if (report.some((r) => r.renderDiff.changed || r.keysLost.length)) { console.error("\nFAILED: a rendered value changed or a key was lost."); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
