/**
 * LOAD TEST — `npm run loadtest` (dev only; never point it at production).
 *
 * Seeds N throwaway users straight into the database the target server
 * uses, signs a session token for each (same JWT_SECRET as the server),
 * then drives the server with autocannon: a weighted mix of the requests
 * the app makes on launch and on the home screen, each request as a random
 * user from its own client IP (the per-IP limiter would otherwise turn the
 * test into a 429 benchmark — the server trusts one proxy hop, like
 * production behind Caddy).
 *
 * Env:
 *   LT_URL          target (default http://127.0.0.1:3999)
 *   DATABASE_URL    the target server's database (a throwaway one!)
 *   JWT_SECRET      the target server's secret
 *   LT_USERS        users to seed (default 200)
 *   LT_CONNECTIONS  concurrent connections (default 50)
 *   LT_DURATION     seconds per scenario (default 20)
 *   LT_SCENARIOS    comma list (default: all) — health,config,auth,mix
 *   LT_JSON         write the summary JSON here
 *
 * Output: per scenario, requests/s, latency p50/p97.5/p99, errors, non-2xx.
 */
const autocannon = require("autocannon");
const jwt = require("jsonwebtoken");

const URL_ = process.env.LT_URL || "http://127.0.0.1:3999";
const USERS = Number(process.env.LT_USERS) || 200;
const CONNECTIONS = Number(process.env.LT_CONNECTIONS) || 50;
const DURATION = Number(process.env.LT_DURATION) || 20;
const ONLY = (process.env.LT_SCENARIOS || "").split(",").map((s) => s.trim()).filter(Boolean);

if (/envisionsit|wishme/.test(URL_)) {
  console.error("Refusing to load-test a production host.");
  process.exit(2);
}
if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
  console.error("Set DATABASE_URL and JWT_SECRET to the target server's (throwaway) values.");
  process.exit(2);
}

// What a phone asks for when the app opens and the home screen draws,
// weighted roughly by how often it happens (lib/ grep, 2026-11-20).
const MIX = [
  ["/auth/me", 4],
  ["/config", 3],
  ["/ai/config", 3],
  ["/profile/full", 3],
  ["/chat/threads", 3],
  ["/messages/unread", 2],
  ["/reminders", 2],
  ["/quote-cards/today", 1],
  ["/go", 1],
  ["/news/feed", 1],
  ["/chat/groups", 1],
  ["/meetings", 1],
  ["/phone/methods", 1],
];
const WEIGHTED = MIX.flatMap(([p, w]) => Array(w).fill(p));

async function seed() {
  const db = require("../src/db");
  await db.init();
  const tag = `lt${Date.now().toString(36)}`;
  const ids = [];
  for (let i = 0; i < USERS; i++) {
    const r = await db.one(
      `INSERT INTO users (email, name, created_at, tz_offset_min) VALUES ($1,$2,$3,330) RETURNING id`,
      [`${tag}-${i}@load.test`, `Load User ${i}`, Date.now()]);
    ids.push(Number(r.id));
  }
  await db.close();
  return ids.map((uid) => jwt.sign({ uid }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "2h" }));
}

function ipFor(i) {
  return `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
}

function run(name, buildRequest) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const inst = autocannon({
      url: URL_,
      connections: CONNECTIONS,
      duration: DURATION,
      requests: [{ setupRequest: (req) => buildRequest(req, n++) }],
    }, (err, res) => (err ? reject(err) : resolve({ name, res })));
    autocannon.track(inst, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false });
  });
}

function summary({ name, res }) {
  return {
    scenario: name,
    reqPerSec: Math.round(res.requests.average),
    p50ms: res.latency.p50,
    p97_5ms: res.latency.p97_5,
    p99ms: res.latency.p99,
    maxMs: res.latency.max,
    total: res.requests.total,
    errors: res.errors,
    timeouts: res.timeouts,
    non2xx: res.non2xx,
  };
}

(async () => {
  const tokens = await seed();
  const pick = (i) => tokens[i % tokens.length];
  const scenarios = {
    // The floor: Express + middleware with no database.
    health: (req, i) => ({ ...req, method: "GET", path: "/health", headers: { "x-forwarded-for": ipFor(i % 5000) } }),
    // Public, cached config the app reads on every launch.
    config: (req, i) => ({ ...req, method: "GET", path: "/config", headers: { "x-forwarded-for": ipFor(i % 5000) } }),
    // Session check: JWT verify + the per-request user lookup.
    auth: (req, i) => ({
      ...req, method: "GET", path: "/auth/me",
      headers: { authorization: `Bearer ${pick(i)}`, "x-forwarded-for": ipFor(i % 5000), "x-app-build": "220", "x-tz-offset": "330" },
    }),
    // What the fleet of phones actually sends.
    mix: (req, i) => ({
      ...req, method: "GET", path: WEIGHTED[i % WEIGHTED.length],
      headers: { authorization: `Bearer ${pick(i * 7919)}`, "x-forwarded-for": ipFor(i % 5000), "x-app-build": "220", "x-tz-offset": "330" },
    }),
  };
  const results = [];
  for (const [name, build] of Object.entries(scenarios)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const r = summary(await run(name, build));
    results.push(r);
    console.log(JSON.stringify(r));
  }
  if (process.env.LT_JSON) require("fs").writeFileSync(process.env.LT_JSON, JSON.stringify(results, null, 2));
  console.table(results);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
