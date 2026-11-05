#!/usr/bin/env node
// Validates db/seed-data/master-sops.json against db/seed-data/hampton-sops.json.
// Rendering the master with hampton_details must reproduce the Hampton text byte-for-byte.
const path = require('path');
const orig = require(path.join(__dirname, '..', 'db', 'seed-data', 'hampton-sops.json'));
const master = require(path.join(__dirname, '..', 'db', 'seed-data', 'master-sops.json'));

const errors = [];
const err = (m) => errors.push(m);
const CONTACT_ROLES = new Set(['AGM', 'GM', 'COO', 'Engineer', 'Head Housekeeper']);
const APPLIES = new Set(['all', 'hilton']);
const REQUIRES = new Set([null, 'breakfast', 'pool', 'pets', 'laundry', 'market']);
const GROUPS = new Set([null, 'cash', 'early_checkin', 'rooms_policy', 'breakfast', 'pool', 'pets', 'laundry', 'market']);
const STATUS = new Set(['same', 'draft']);
const TOKEN = /\{([^{}]+)\}/g;

const details = master.details || [];
const hd = master.hampton_details || {};
const detailKeys = new Set();
details.forEach((d) => {
  if (!d.key || typeof d.key !== 'string') return err('detail without key');
  if (detailKeys.has(d.key)) err(`duplicate detail key: ${d.key}`);
  detailKeys.add(d.key);
  if (CONTACT_ROLES.has(d.key)) err(`detail key collides with contact role: ${d.key}`);
  if (typeof d.hint !== 'string' || !d.hint) err(`detail ${d.key}: missing hint`);
  if (!GROUPS.has(d.group === undefined ? undefined : d.group)) err(`detail ${d.key}: bad group ${d.group}`);
  if (typeof hd[d.key] !== 'string') err(`detail ${d.key}: no hampton_details value`);
});
Object.keys(hd).forEach((k) => { if (!detailKeys.has(k)) err(`hampton_details has unknown key: ${k}`); });

const usedTokens = new Set();
function render(text, where) {
  if (typeof text !== 'string') { err(`${where}: not a string`); return ''; }
  return text.replace(TOKEN, (m, name) => {
    if (CONTACT_ROLES.has(name)) return m; // contact tokens stay as-is
    if (!detailKeys.has(name)) { err(`${where}: undefined token ${m}`); return m; }
    usedTokens.add(name);
    return hd[name];
  });
}

if (orig.sops.length !== 234) err(`original has ${orig.sops.length} SOPs, expected 234`);
if (master.sops.length !== 234) err(`master has ${master.sops.length} SOPs, expected 234`);

// categories
if (JSON.stringify(master.cats.map((c) => c.name)) !== JSON.stringify(orig.cats)) err('categories differ or are out of order');
const prefixOf = {};
master.cats.forEach((c) => { if (!c.prefix) err(`cat ${c.name}: no prefix`); prefixOf[c.name] = c.prefix; });

let hkCount = 0;
const n = Math.max(orig.sops.length, master.sops.length);
for (let i = 0; i < n; i++) {
  const o = orig.sops[i], m = master.sops[i];
  if (!o || !m) { err(`index ${i}: missing SOP`); continue; }
  const id = o.id;
  if (m.id !== o.id) { err(`index ${i}: id ${m.id} != ${o.id}`); continue; }
  if (m.cat !== o.cat) err(`${id}: category differs`);
  if (m.title !== o.title) err(`${id}: title differs`);
  if (m.kw !== o.kw) err(`${id}: keywords differ`);
  if (prefixOf[m.cat] && !m.id.startsWith(prefixOf[m.cat] + '-')) err(`${id}: id does not match category prefix ${prefixOf[m.cat]}`);
  if (!Array.isArray(m.steps) || m.steps.length !== o.steps.length) { err(`${id}: step count differs`); continue; }
  let anyHk = false;
  m.steps.forEach((s, j) => {
    const r = render(s.t, `${id} step ${j + 1}`);
    if (r !== o.steps[j]) err(`${id} step ${j + 1}: render mismatch\n   got:  ${r}\n   want: ${o.steps[j]}`);
    if (!(s.hk === null || (typeof s.hk === 'string' && s.hk.trim() !== ''))) err(`${id} step ${j + 1}: hk must be null or non-empty string`);
    if (typeof s.hk === 'string') { anyHk = true; render(s.hk, `${id} step ${j + 1} hk`); }
  });
  const rs = render(m.script, `${id} script`);
  if (rs !== o.script) err(`${id} script: render mismatch\n   got:  ${rs}\n   want: ${o.script}`);
  const rf = render(m.flag, `${id} flag`);
  if (rf !== o.flag) err(`${id} flag: render mismatch\n   got:  ${rf}\n   want: ${o.flag}`);
  for (const f of ['script_hk', 'flag_hk']) {
    const v = m[f];
    if (!(v === null || (typeof v === 'string' && v.trim() !== ''))) err(`${id} ${f}: must be null or non-empty string`);
    if (typeof v === 'string') { anyHk = true; render(v, `${id} ${f}`); }
  }
  if (!APPLIES.has(m.applies)) err(`${id}: bad applies ${m.applies}`);
  if (!REQUIRES.has(m.requires === undefined ? undefined : m.requires)) err(`${id}: bad requires ${m.requires}`);
  if (!STATUS.has(m.hk_status)) err(`${id}: bad hk_status ${m.hk_status}`);
  if (m.hk_status !== (anyHk ? 'draft' : 'same')) err(`${id}: hk_status ${m.hk_status} does not match hk content`);
  if (m.applies === 'hilton' && anyHk) err(`${id}: hilton-only SOP should not have HotelKey versions`);
  if (anyHk) hkCount++;
  if (!(m.script_hk === null || m.script) && m.script_hk) err(`${id}: script_hk set but script empty`);
}

details.forEach((d) => { if (!usedTokens.has(d.key)) err(`detail never used: ${d.key}`); });

const hilton = master.sops.filter((s) => s.applies === 'hilton').length;
const reqs = master.sops.filter((s) => s.requires).map((s) => `${s.id}:${s.requires}`);
console.log(`SOPs: ${master.sops.length} (original ${orig.sops.length})`);
console.log(`Categories: ${master.cats.length}`);
console.log(`Detail keys: ${details.length}`);
console.log(`SOPs with HotelKey drafts: ${hkCount}`);
console.log(`applies=hilton: ${hilton}`);
console.log(`requires: ${reqs.join(', ')}`);
if (errors.length) {
  console.error(`\nFAILED with ${errors.length} error(s):`);
  errors.slice(0, 50).forEach((e) => console.error(' - ' + e));
  process.exit(1);
}
console.log('OK: all checks passed');
