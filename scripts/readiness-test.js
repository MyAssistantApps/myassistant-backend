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

  console.log("\nfinding documents");
  await atest("'show my adhar card' shows the Aadhaar card only, not the PAN cards", () => {
    const intel = require("../src/docs/intelligence");
    const docs = [
      { id: 3, title: "Aadhaar Card — Unique Identification Authority", category: "id" },
      { id: 4, title: "PAN Card — Income Tax Department", category: "id" },
      { id: 5, title: "PAN Card Back Side — NSDL", category: "id" },
      { id: 1, title: "My photo", category: "other" },
    ];
    // Embedding scores are never zero; the PAN card even ranked first.
    const ranked = [{ id: 4, score: 0.62 }, { id: 3, score: 0.6 }, { id: 5, score: 0.55 }, { id: 1, score: 0.3 }];
    const ask = (q) => intel._keepWhatWasAsked(ranked, docs, q.split(/\s+/).filter((w) => w.length > 2)).map((r) => r.id);
    for (const q of ["show my adhar card", "aadhar", "my aadhaar card"]) assert.deepStrictEqual(ask(q), [3], q);
    assert.deepStrictEqual(ask("pan card"), [4, 5]);
    // Asked by its full title, with a PAN card whose text says "authority".
    docs[1].full_text = "Income Tax Department ... issuing authority";
    assert.deepStrictEqual(ask("Aadhaar Card Unique Identification Authority"), [3]);
    delete docs[1].full_text;
    assert.deepStrictEqual(ask("passport"), [], "nothing that was not asked for");
    assert.deepStrictEqual(ask("my documents"), [4, 3, 5], "a generic ask keeps the ranking");
  });

  // ---- launch batch, 2026-11-28 ----
  console.log("\nlaunch hardening");
  await atest("a call is placed only for an account that has proved its phone number", async () => {
    const keep = { ...process.env };
    Object.assign(process.env, { PUBLIC_BASE_URL: "https://example.test", BOLNA_API_KEY: "k", BOLNA_FROM_NUMBER: "+911234567890", BOLNA_AGENT_ID: "a" });
    delete process.env.AGENT_CALL_REQUIRE_VERIFIED;
    const stamp = Date.now();
    const bare = await db.one(
      `INSERT INTO users (email, name, created_at) VALUES ($1,'Bare',$2) RETURNING id`, [`bare-${stamp}@example.test`, stamp]);
    try {
      assert.strictEqual(await agentCall._phoneVerified(bare.id), false);
      await assert.rejects(
        agentCall.start({ userId: Number(bare.id), toNumber: "+919845000001", contactName: "Ravi", task: "say hello" }),
        (e) => e.code === "failed" && e.reason === "caller_rejected" && /verify your phone number/.test(e.message));
      await db.run("UPDATE users SET phone_verified_at = $2, phone_number = $3 WHERE id = $1",
        [bare.id, stamp, `+9198${String(stamp).slice(-8)}`]);
      assert.strictEqual(await agentCall._phoneVerified(bare.id), true);
    } finally {
      for (const k of ["PUBLIC_BASE_URL", "BOLNA_API_KEY", "BOLNA_FROM_NUMBER", "BOLNA_AGENT_ID"]) {
        if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
      }
    }
  });

  await atest("reminder calls ring people in the daytime only (India time)", () => {
    const { reminderCallHours } = require("../src/proactive/scheduler");
    const at = (istHour) => Date.UTC(2026, 10, 28, istHour, 0) - 5.5 * 3600_000;
    for (const h of [9, 12, 19]) assert.strictEqual(reminderCallHours(at(h)), true, `${h}:00`);
    for (const h of [0, 3, 8, 20, 23]) assert.strictEqual(reminderCallHours(at(h)), false, `${h}:00`);
    process.env.REMINDER_CALL_HOURS = "10-18";
    assert.strictEqual(reminderCallHours(at(9)), false);
    assert.strictEqual(reminderCallHours(at(17)), true);
    delete process.env.REMINDER_CALL_HOURS;
    // What the caller is told to say: automated, on whose behalf, and no private reason.
    const src = require("fs").readFileSync(require("path").join(__dirname, "../src/proactive/scheduler.js"), "utf8");
    assert.ok(src.includes("This is an automated reminder call on behalf of Dr."));
    assert.ok(!/\$\{a\.reason \? /.test(src), "the reason for the visit is not read out");
    assert.ok(!/case "\$\{h\.case_title\}"/.test(src), "nor the title of the case");
  });

  await atest("all calls together have a daily ceiling, whatever accounts place them", async () => {
    const day = new Date().toISOString().slice(0, 10);
    agentCall._dayCounts.delete(`global:${day}`);
    assert.strictEqual(await agentCall._reserveGlobal(0), true, "0 switches the ceiling off");
    agentCall._dayCounts.set(`global:${day}`, 0);
    assert.strictEqual(await agentCall._reserveGlobal(2), true);
    assert.strictEqual(await agentCall._reserveGlobal(2), true);
    assert.strictEqual(await agentCall._reserveGlobal(2), false, "the third call of the day is refused");
    agentCall._dayCounts.delete(`global:${day}`);
  });

  await atest("a name search returns only the caller's own contacts, never another user's number", async () => {
    const stamp = Date.now();
    const mk = async (name, phone) => Number((await db.one(
      `INSERT INTO users (email, name, phone_number, phone_verified_at, created_at) VALUES ($1,$2,$3,$4,$4) RETURNING id`,
      [`ns-${stamp}-${name.replace(/\W/g, "")}@example.test`, name, phone, stamp])).id);
    const me = await mk("Searcher", `+9197${String(stamp).slice(-8)}`);
    await mk(`Zubin Unlisted${stamp}`, `+9196${String(stamp).slice(-8)}`);
    await require("../src/routes/contacts").migrate();
    const express = require("express");
    const app = express();
    app.use((req, _res, next) => { req.user = { sub: String(me) }; next(); });
    app.use("/contacts", require("../src/routes/contacts"));
    const server = await new Promise((r) => { const sv = app.listen(0, "127.0.0.1", () => r(sv)); });
    try {
      const get = async (name) => (await fetch(
        `http://127.0.0.1:${server.address().port}/contacts/resolve?name=${encodeURIComponent(name)}`)).json();
      const stranger = await get(`Zubin Unlisted${stamp}`);
      assert.strictEqual(stranger.match, null, "an app user who is not in my contacts is not found");
      assert.ok(!JSON.stringify(stranger).includes("+9196"), "and their number is nowhere in the answer");
      await db.run(`INSERT INTO contacts (user_id, name, phone, updated_at) VALUES ($1,$2,$3,$4)`,
        [me, "Asha Saved", "+919845011111", stamp]);
      const mine = await get("Asha Saved");
      assert.strictEqual(mine.match && mine.match.phone, "+919845011111", "my own saved contact still resolves");
    } finally { server.close(); }
  });

  await atest("publishing a build has its own key once one is set", () => {
    const { requirePublishKey } = require("../src/middleware/adminKey");
    const keep = [process.env.ADMIN_KEY, process.env.APK_PUBLISH_KEY];
    const run = (key) => {
      let out = "refused";
      requirePublishKey({ get: (h) => (h === "X-Admin-Key" ? key : undefined) },
        { status() { return { json() {} }; } }, () => { out = "ok"; });
      return out;
    };
    try {
      process.env.ADMIN_KEY = "admin-key-admin-key-0001";
      delete process.env.APK_PUBLISH_KEY;
      assert.strictEqual(run("admin-key-admin-key-0001"), "ok", "unset: the admin key publishes, as before");
      process.env.APK_PUBLISH_KEY = "publish-key-publish-0002";
      assert.strictEqual(run("publish-key-publish-0002"), "ok");
      assert.strictEqual(run("admin-key-admin-key-0001"), "refused", "the admin key no longer publishes");
      assert.strictEqual(run("wrong"), "refused");
    } finally {
      if (keep[0] === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = keep[0];
      if (keep[1] === undefined) delete process.env.APK_PUBLISH_KEY; else process.env.APK_PUBLISH_KEY = keep[1];
    }
  });

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
