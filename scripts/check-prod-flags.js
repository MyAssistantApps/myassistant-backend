/**
 * Does this server's .env still match deploy/vps/production.flags (what
 * scripts/production-config-test.js tests)? Run by deploy.sh on the VPS.
 * Prints each difference and exits 0 either way: a drift is a warning to
 * update the flags file in a PR, never a reason to stop a deploy.
 * Secret VALUES are never printed, only whether they are set.
 */
const fs = require("fs");
const path = require("path");

const read = (file) => {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
};
const root = path.join(__dirname, "..");
const envFile = process.argv[2] || path.join(root, ".env");
const want = read(path.join(root, "deploy/vps/production.flags"));
const have = read(envFile);
const drift = [];
for (const [k, v] of Object.entries(want)) {
  if (v === "<secret>") { if (!have[k]) drift.push(`${k}: expected to be set, missing`); continue; }
  if (!(k in have)) drift.push(`${k}: tested as "${v}", not set here`);
  else if (have[k] !== v) drift.push(`${k}: tested as "${v}", here "${have[k]}"`);
}
for (const k of Object.keys(have)) {
  if (!(k in want)) drift.push(`${k}: set here, not in production.flags (untested)`);
}
if (drift.length) {
  console.warn(`WARNING: .env differs from deploy/vps/production.flags (${drift.length}):`);
  for (const d of drift) console.warn(`  - ${d}`);
  console.warn("Update production.flags in a PR so CI tests what production runs.");
} else {
  console.log("settings match deploy/vps/production.flags");
}
