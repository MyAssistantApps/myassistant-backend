/**
 * Every server module must at least LOAD (catches typos and requires of
 * deleted files). It walks src/ instead of naming modules: a hand-kept
 * list in ci.yml went stale twice (src/live/proxy, src/services/intents
 * were deleted and CI stayed red for days).
 *
 * Skipped: src/server.js (starts listening) and src/routes/admin_panel/
 * (browser code served to the admin page).
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "src");
const skip = (rel) => rel === "server.js" || rel.startsWith(`routes${path.sep}admin_panel${path.sep}`);
const bad = [];
let n = 0;
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    const rel = path.relative(root, p);
    if (!f.endsWith(".js") || skip(rel)) continue;
    n++;
    try { require(p); } catch (e) { bad.push(`${rel}: ${String(e.message).split("\n")[0]}`); }
  }
})(root);
console.log(`  ${bad.length ? "FAIL" : "ok  "} modules: ${n} loaded, ${bad.length} failed`);
for (const b of bad) console.log(`    ${b}`);
process.exit(bad.length ? 1 : 0);
