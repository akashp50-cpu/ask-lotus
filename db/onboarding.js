// The onboarding migration: carries what each hotel already has into the merged setup fields (src/details.js).
// Fill-if-empty only. No detail key is ever removed or changed, so SOP text renders exactly as before; the old keys stay in hotels.details and keep
// winning over derived values. Safe to run on every deploy: a second run finds nothing to do.
const D = require("../src/details");

async function plan(c) {
  const hasRooms = (await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name='hotels' AND column_name='rooms'")).rows.length > 0;
  const rows = (await c.query(`SELECT id, name, setup, details, answers, ${hasRooms ? "rooms" : "NULL::jsonb AS rooms"} FROM hotels ORDER BY id`)).rows;
  return rows.map((h) => {
    const before = { details: h.details || {}, answers: h.answers || {}, rooms: h.rooms || null };
    const after = D.migrateHotel(before);
    const dChanged = Object.keys(after.details).some((k) => after.details[k] !== before.details[k]);
    const aChanged = Object.keys(after.answers).some((k) => after.answers[k] !== before.answers[k]);
    const rChanged = !before.rooms && !!after.rooms;
    return { id: h.id, name: h.name, setup: h.setup, before, after, changes: after.changes, merged: after.merged, write: dChanged || aChanged || rChanged, dChanged, aChanged, rChanged };
  });
}

async function apply(c) {
  const p = await plan(c);
  for (const h of p.filter((x) => x.write)) {
    if (h.dChanged) await c.query("UPDATE hotels SET details=$2 WHERE id=$1", [h.id, JSON.stringify(h.after.details)]);
    if (h.aChanged) {
      const added = {};
      for (const k of Object.keys(h.after.answers)) if (h.before.answers[k] === undefined) added[k] = h.after.answers[k];
      await c.query("UPDATE hotels SET answers = COALESCE(answers,'{}'::jsonb) || $2::jsonb WHERE id=$1", [h.id, JSON.stringify(added)]);
    }
    if (h.rChanged) await c.query("UPDATE hotels SET rooms=$2 WHERE id=$1 AND rooms IS NULL", [h.id, JSON.stringify(h.after.rooms)]);
  }
  return p;
}

module.exports = { plan, apply };
