const fs = require("fs");
const path = require("path");
const { pool } = require("../src/db");

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("Schema ready.");
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
