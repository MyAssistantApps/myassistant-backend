/**
 * PRODUCT-READINESS TESTS (2026-11-21) — `npm run test:readiness`.
 *
 * One test per abuse and integrity fix from the 2026-11-21 audit, so the
 * holes cannot quietly reopen. Needs a throwaway database (DATABASE_URL).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "readiness-test-secret-readiness-test-secret-01";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");
const db = require("../src/db");

let passed = 0;
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e && (e.stack || e.message)}`);
    process.exitCode = 1;
  }
}

(async () => {
  await db.init();
  const agentCall = require("../src/agents/agentCall");
  const jobs = require("../src/infra/jobs");
  // db.init() migrates the jobs table with the core schema.

  console.log("\noutbound calls");
  await atest("calls go to Indian numbers only; premium and service ranges are refused", () => {
    const ok = (n) => agentCall.allowedDestination(agentCall.normalizeNumber(n));
    assert.strictEqual(ok("9876543210"), true);
    assert.strictEqual(ok("+91 98765 43210"), true);
    assert.strictEqual(ok("+14155550100"), false, "international");
    assert.strictEqual(ok("+447700900123"), false, "international");
    assert.strictEqual(ok("+911900123456"), false, "premium rate");
    assert.strictEqual(ok("+9198765"), false, "too short");
  });
  await atest("AGENT_CALL_ALLOWED_PREFIXES widens the list when the owner asks", () => {
    const saved = process.env.AGENT_CALL_ALLOWED_PREFIXES;
    process.env.AGENT_CALL_ALLOWED_PREFIXES = "+91,+971";
    try {
      assert.strictEqual(agentCall.allowedDestination("+971501234567"), true);
      assert.strictEqual(agentCall.allowedDestination("+14155550100"), false);
    } finally {
      if (saved === undefined) delete process.env.AGENT_CALL_ALLOWED_PREFIXES;
      else process.env.AGENT_CALL_ALLOWED_PREFIXES = saved;
    }
  });
  await atest("an international number is refused before anything is dialled", async () => {
    const saved = { k: process.env.BOLNA_API_KEY, f: process.env.BOLNA_FROM_NUMBER, a: process.env.BOLNA_AGENT_ID, b: process.env.PUBLIC_BASE_URL };
    Object.assign(process.env, { BOLNA_API_KEY: "x", BOLNA_FROM_NUMBER: "+910000000000", BOLNA_AGENT_ID: "y", PUBLIC_BASE_URL: "https://example.test" });
    const realFetch = global.fetch;
    let dialled = 0;
    global.fetch = async () => { dialled++; throw new Error("no network in tests"); };
    try {
      await assert.rejects(
        agentCall.start({ userId: 999001, toNumber: "+14155550100", contactName: "X", task: "hello" }),
        (e) => e.code === "bad_number");
      assert.strictEqual(dialled, 0);
    } finally {
      global.fetch = realFetch;
      for (const [k, v] of [["BOLNA_API_KEY", saved.k], ["BOLNA_FROM_NUMBER", saved.f], ["BOLNA_AGENT_ID", saved.a], ["PUBLIC_BASE_URL", saved.b]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  console.log("\nthe job queue");
  await atest("a job that never returns is failed at its deadline and the queue moves on", async () => {
    const kind = `readiness_hang_${Date.now()}`;
    jobs.register(kind, () => new Promise(() => {})); // never settles
    const saved = process.env.JOB_TIMEOUT_MS;
    // The deadline is read at load time; drive one job through a fresh copy.
    delete require.cache[require.resolve("../src/infra/jobs")];
    process.env.JOB_TIMEOUT_MS = "300";
    const fresh = require("../src/infra/jobs");
    fresh.register(kind, () => new Promise(() => {}));
    const after = `readiness_after_${Date.now()}`;
    let ran = false;
    fresh.register(after, async () => { ran = true; });
    try {
      await fresh.enqueue(kind, {}, {});
      await fresh.enqueue(after, {}, {});
      const t0 = Date.now();
      await fresh.drain(5);
      assert.ok(Date.now() - t0 < 5000, "the hung job did not block the worker");
      const row = await db.one(`SELECT status, last_error FROM jobs WHERE kind = $1 ORDER BY id DESC LIMIT 1`, [kind]);
      assert.strictEqual(row.status, "failed", "timed-out jobs are not retried");
      assert.match(row.last_error, /timed out/);
      assert.ok(ran, "the next job ran");
    } finally {
      if (saved === undefined) delete process.env.JOB_TIMEOUT_MS; else process.env.JOB_TIMEOUT_MS = saved;
      delete require.cache[require.resolve("../src/infra/jobs")];
    }
  });
  await atest("finished jobs are pruned after the retention window", async () => {
    const fresh = require("../src/infra/jobs");
    const old = Date.now() - 30 * 86_400_000;
    const r = await db.one(
      `INSERT INTO jobs (kind, payload, status, attempts, run_after, created_at, updated_at)
       VALUES ('readiness_old', '{}', 'done', 1, $1, $1, $1) RETURNING id`, [old]);
    const n = await fresh.prune();
    assert.ok(n >= 1);
    assert.strictEqual(await db.one(`SELECT id FROM jobs WHERE id = $1`, [r.id]), null);
  });

  console.log("\nprivacy");
  await atest("the erase guard knows the other party's columns", () => {
    const privacy = require("../src/routes/privacy");
    for (const c of ["host_id", "caller_id", "from_user"]) assert.ok(privacy.USER_COLUMNS.includes(c), c);
    const pairs = privacy.USER_TABLES.map(([t, c]) => `${t}.${c}`);
    for (const p of ["connect_bookings.host_id", "connect_urgent.caller_id", "listing_requests.from_user"]) {
      assert.ok(pairs.includes(p), `${p} is erased`);
    }
  });

  console.log("\nhelp and feedback");
  await atest("the app files feedback and Pro interest into the Feedback inbox", async () => {
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { sub: "999002" }; next(); });
    app.use("/feedback", require("../src/feedback/routes"));
    const srv = app.listen(0);
    try {
      const url = `http://127.0.0.1:${srv.address().port}/feedback`;
      const post = (body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const summary = `Pro interest: professional monthly ${Date.now()}`;
      const ok = await post({ kind: "feature", summary, source: "premium" });
      assert.strictEqual(ok.status, 200);
      const row = await db.one(`SELECT source, kind, user_asked FROM developer_feedback WHERE summary = $1`, [summary]);
      assert.deepStrictEqual({ ...row, user_asked: Number(row.user_asked) }, { source: "premium", kind: "feature", user_asked: 1 });
      const empty = await post({ kind: "bug", summary: "   " });
      assert.strictEqual(empty.status, 400);
    } finally {
      srv.close();
      await db.run(`DELETE FROM developer_feedback WHERE user_id = 999002`);
    }
  });

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
