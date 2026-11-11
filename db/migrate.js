const fs = require("fs");
const path = require("path");
const { pool } = require("../src/db");
const groups = require("./groups");

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("Schema ready.");
  // Brand groups: family, kind and amenity for every SOP, a copy source for hotels with none. Fills in NULLs only; never touches a SOP's text, status or images.
  const p = await groups.apply(pool);
  console.log(`Groups ready: ${p.updates.length} SOP row(s) classified, ${p.sources.length} copy source(s) set.`);
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
