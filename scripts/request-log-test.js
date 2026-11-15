/**
 * REQUEST LOG TESTS — `npm run test:requestlog`.
 *
 * The 2-day request log (src/ops/requestLog.js) against a throwaway
 * database, through the real server: every request is recorded (health and
 * auth included), query strings and webhook secrets never reach the table,
 * rows past the retention window are pruned, and the admin panel's
 * /admin-panel/api/requests serves them only after sign-in.
 */
const assert = require("assert");
const net = require("net");
if (!process.env.DATABASE_URL) {
  console.log("request-log: set DATABASE_URL to a THROWAWAY database to run these tests");
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-request-log-0123456789abcdef";
process.env.ADMIN_KEY = "request-log-admin-key-0123456789";
process.env.NODE_ENV = process.env.NODE_ENV === "production" ? "production" : "test";
delete process.env.REQUEST_LOG;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

(async () => {
  const db = require("../src/db");
  const requestLog = require("../src/ops/requestLog");
  process.env.PORT = String(await freePort());
  const BASE = `http://127.0.0.1:${process.env.PORT}`;
  require("../src/server");
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(BASE + "/health")).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  await requestLog.migrate();

  const stamp = `t${Date.now()}`;
  const rowsFor = async (like) => {
    await requestLog.flush();
    return db.query(`SELECT * FROM request_logs WHERE path LIKE $1 ORDER BY id`, [like]);
  };

  console.log("\nrequest log");

  await test("a health check is logged with status, method and time", async () => {
    await requestLog.flush();
    const before = Number((await db.one(`SELECT COALESCE(MAX(id),0) AS m FROM request_logs`)).m);
    await fetch(BASE + "/health");
    await requestLog.flush();
    const r = await db.query(`SELECT * FROM request_logs WHERE id > $1 AND path = '/health'`, [before]);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].method, "GET");
    assert.strictEqual(r[0].status, 200);
    assert.ok(r[0].ms >= 0 && Number(r[0].ts) > Date.now() - 60_000);
    assert.ok(r[0].rid, "request id kept");
  });

  await test("an auth request is logged, and its body is not", async () => {
    await fetch(BASE + "/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${stamp}@example.test`, password: "hunter2-secret" }),
    });
    const r = (await rowsFor("/auth/login")).filter((x) => Number(x.ts) > Date.now() - 60_000);
    assert.ok(r.length >= 1);
    assert.ok(r[r.length - 1].status >= 400);
    const all = JSON.stringify(await db.query(`SELECT * FROM request_logs`));
    assert.ok(!all.includes("hunter2-secret"), "password stored");
  });

  await test("a 404 is logged; the query string never is", async () => {
    await fetch(`${BASE}/no-such-${stamp}?token=SHOULD_NOT_APPEAR&q=private`);
    const r = await rowsFor(`/no-such-${stamp}%`);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].status, 404);
    assert.strictEqual(r[0].path, `/no-such-${stamp}`);
  });

  await test("webhook secrets in a path are masked", async () => {
    await fetch(`${BASE}/inbound/webhook/abcdefabcdefabcdefabcdef${stamp}`, { method: "POST" });
    const all = JSON.stringify(await rowsFor("/inbound/%"));
    assert.ok(!all.includes(`abcdefabcdefabcdefabcdef${stamp}`), "secret stored");
    assert.ok(all.includes(":secret"));
  });

  await test("rows past the retention window are pruned, newer ones kept", async () => {
    const old = Date.now() - (requestLog.KEEP_DAYS + 1) * 86400_000;
    await db.query(
      `INSERT INTO request_logs (ts, method, path, status, ms) VALUES ($1,'GET',$2,200,1), ($3,'GET',$4,200,1)`,
      [old, `/old-${stamp}`, Date.now(), `/new-${stamp}`]
    );
    assert.ok((await requestLog.prune()) >= 1);
    assert.strictEqual((await rowsFor(`/old-${stamp}`)).length, 0);
    assert.strictEqual((await rowsFor(`/new-${stamp}`)).length, 1);
  });

  await test("the admin API refuses without sign-in", async () => {
    const r = await fetch(BASE + "/admin-panel/api/requests");
    assert.strictEqual(r.status, 401);
  });

  await test("the admin API lists requests newest first, with filters", async () => {
    const login = await fetch(BASE + "/admin-panel/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: process.env.ADMIN_KEY }),
    });
    assert.strictEqual(login.status, 200);
    const cookie = String(login.headers.get("set-cookie")).split(";")[0];
    const get = async (qs) => {
      const r = await fetch(BASE + "/admin-panel/api/requests" + qs, { headers: { cookie } });
      assert.strictEqual(r.status, 200);
      return r.json();
    };
    const d = await get("?limit=500");
    assert.ok(d.rows.length >= 4);
    assert.ok(d.rows[0].id > d.rows[d.rows.length - 1].id, "newest first");
    assert.ok(d.summary.total >= d.rows.length || d.summary.total >= 4);
    assert.strictEqual(d.summary.keepDays, requestLog.KEEP_DAYS);

    const only404 = await get(`?status=4xx&q=no-such-${stamp}`);
    assert.strictEqual(only404.rows.length, 1);
    assert.strictEqual(only404.rows[0].status, 404);

    const hidden = await get("?hideAdmin=1&limit=500");
    assert.ok(hidden.rows.every((r) => !r.path.startsWith("/admin-panel")));
    const withAdmin = await get("?q=/admin-panel/api/login");
    assert.ok(withAdmin.rows.length >= 1, "the panel's own requests are logged too");

    const page2 = await get(`?before=${d.rows[1].id}&limit=1`);
    assert.ok(page2.rows.length === 1 && page2.rows[0].id < d.rows[1].id);
  });

  await test("request_logs is erased with the account (privacy USER_TABLES)", () => {
    const privacy = require("../src/routes/privacy");
    assert.ok(privacy.USER_TABLES.some(([t, c]) => t === "request_logs" && c === "user_id"));
  });

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
