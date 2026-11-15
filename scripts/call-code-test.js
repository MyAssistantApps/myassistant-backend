/**
 * VERIFICATION-CALL TESTS — `npm run test:callcode`.
 *
 * The voice-call proof of a phone number (services/callCode.js), against a
 * throwaway database and with the Bolna call replaced by a fake that only
 * records what it would have said. Covers: the code is read out and never
 * stored in clear; only the newest code works; wrong codes run out; expiry;
 * one use; rate limits; a number someone else owns is never rung; and the
 * route assigns the number only after the right code.
 */
const assert = require("assert");
if (!process.env.DATABASE_URL) {
  console.log("call-code: set DATABASE_URL to a THROWAWAY database to run these tests");
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-call-codes-0123456789abcdef";
process.env.BOLNA_API_KEY = "bn-test";
process.env.BOLNA_FROM_NUMBER = "+910000000000";
process.env.BOLNA_AGENT_ID = "agent-test";

const db = require("../src/db");
const cc = require("../src/services/callCode");

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

const calls = [];
cc._setDial(async (c) => {
  calls.push(c);
  return `exec-${calls.length}`;
});
const lastCode = () => calls[calls.length - 1].code;

(async () => {
  await db.init();
  await cc.migrate();
  const mk = async (name) => Number((await db.one(
    "INSERT INTO users (email, name, created_at) VALUES ($1,$2,$3) RETURNING id",
    [`cc${Date.now()}${Math.random().toString(36).slice(2, 7)}@test.local`, name, Date.now()]
  )).id);
  const A = await mk("Asha Rao");
  const B = await mk("Ravi");
  const PHONE = "+919845012345";

  console.log("\nverification calls");

  await test("the spoken code is two groups of digits, and the task never asks for it back", () => {
    assert.strictEqual(cc.spoken("482913"), "4 8 2, 9 1 3");
    const t = cc.taskFor("482913");
    assert.ok(t.includes("4 8 2, 9 1 3"));
    assert.ok(/Do not ask them to tell you the code/.test(t));
  });

  await test("Indian mobiles only", () => {
    assert.ok(cc.callable("+919845012345"));
    assert.ok(!cc.callable("+14155550123"));
    assert.ok(!cc.callable("+911234567890"));
  });

  await test("start rings the number and stores only a hash", async () => {
    await cc.start(A, PHONE);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].to, PHONE);
    assert.strictEqual(calls[0].userName, "Asha");
    const row = await db.one("SELECT * FROM phone_call_codes WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [A]);
    assert.ok(!JSON.stringify(row).includes(lastCode()), "code stored in clear");
    assert.strictEqual(row.exec_id, "exec-1");
  });

  await test("a wrong code counts down; the right one works once", async () => {
    const good = lastCode();
    const bad = good === "000000" ? "111111" : "000000";
    const r1 = await cc.check(A, PHONE, bad);
    assert.strictEqual(r1.ok, false);
    assert.ok(/4 attempts remaining/.test(r1.error), r1.error);
    assert.deepStrictEqual(await cc.check(A, PHONE, good), { ok: true });
    assert.strictEqual((await cc.check(A, PHONE, good)).ok, false, "second use");
  });

  await test("only the newest code counts", async () => {
    await cc.start(A, PHONE);
    const old = lastCode();
    await cc.start(A, PHONE);
    const fresh = lastCode();
    if (old !== fresh) assert.strictEqual((await cc.check(A, PHONE, old)).ok, false);
    assert.strictEqual((await cc.check(A, PHONE, fresh)).ok, true);
  });

  await test("another account cannot use A's code, nor for another number", async () => {
    await db.run("DELETE FROM phone_call_codes WHERE user_id = ANY($1::int[])", [[A, B]]);
    await cc.start(A, PHONE);
    const code = lastCode();
    assert.strictEqual((await cc.check(B, PHONE, code)).ok, false);
    assert.strictEqual((await cc.check(A, "+919845099999", code)).ok, false);
  });

  await test("five wrong codes kill it, even the right one after", async () => {
    await db.run("DELETE FROM phone_call_codes WHERE user_id = $1", [A]);
    await cc.start(A, PHONE);
    const good = lastCode();
    const bad = good === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await cc.check(A, PHONE, bad);
    assert.strictEqual((await cc.check(A, PHONE, good)).ok, false);
  });

  await test("an expired code is refused", async () => {
    await db.run("DELETE FROM phone_call_codes WHERE user_id = $1", [A]);
    const t0 = Date.now();
    await cc.start(A, PHONE, { now: t0 });
    const r = await cc.check(A, PHONE, lastCode(), { now: t0 + cc.TTL_MS + 1000 });
    assert.strictEqual(r.ok, false);
    assert.ok(/expired/.test(r.error));
  });

  await test("rate limits: per account per hour, per number per day", async () => {
    await db.run("DELETE FROM phone_call_codes WHERE user_id = ANY($1::int[])", [[A, B]]);
    for (let i = 0; i < cc.LIMITS.perUserHour; i++) await cc.start(B, "+919845000001");
    await assert.rejects(cc.start(B, "+919845000002"), /Too many calls/);
    await db.run("DELETE FROM phone_call_codes WHERE user_id = ANY($1::int[])", [[A, B]]);
    const t = Date.now();
    await cc.start(A, PHONE, { now: t - 3 * 3600e3 });
    await cc.start(B, PHONE, { now: t - 2 * 3600e3 });
    await cc.start(A, PHONE, { now: t - 1 * 3600e3 });
    await assert.rejects(cc.start(B, PHONE, { now: t }), /too many calls today/);
  });

  await test("a failed call still counts and leaves no live code", async () => {
    await db.run("DELETE FROM phone_call_codes WHERE user_id = $1", [A]);
    cc._setDial(async () => { throw new Error("provider down"); });
    await assert.rejects(cc.start(A, PHONE), /Unable to place the call/);
    const r = await db.one("SELECT COUNT(*)::int AS n FROM phone_call_codes WHERE user_id = $1", [A]);
    assert.strictEqual(r.n, 1);
    assert.strictEqual((await cc.check(A, PHONE, "123456")).ok, false);
    cc._setDial(async (c) => { calls.push(c); return `exec-${calls.length}`; });
  });

  console.log("\nthe routes");
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/phone", (req, _res, next) => { req.user = { sub: Number(req.get("X-Test-User")) }; next(); }, require("../src/routes/phone"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, user, body) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": String(user) }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  try {
    await test("/phone/methods offers the call", async () => {
      const r = await fetch(`${base}/phone/methods`, { headers: { "X-Test-User": String(A) } });
      assert.strictEqual((await r.json()).call, true);
    });

    await test("the number is assigned only after the right code", async () => {
      await db.run("DELETE FROM phone_call_codes WHERE user_id = ANY($1::int[])", [[A, B]]);
      await db.run("UPDATE users SET phone_number = NULL, phone_verified_at = NULL WHERE id = ANY($1::int[])", [[A, B]]);
      const s = await post("/phone/call-code", A, { phone: "98450 12345" });
      assert.strictEqual(s.status, 200, JSON.stringify(s.json));
      assert.strictEqual(s.json.phone, PHONE);
      const bad = await post("/phone/call-verify", A, { phone: PHONE, code: lastCode() === "000000" ? "111111" : "000000" });
      assert.strictEqual(bad.status, 400);
      let u = await db.findById(A);
      assert.ok(!u.phone_verified_at);
      const ok = await post("/phone/call-verify", A, { phone: PHONE, code: lastCode() });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
      u = await db.findById(A);
      assert.strictEqual(u.phone_number, PHONE);
      assert.ok(u.phone_verified_at);
    });

    await test("a number another account owns is never rung", async () => {
      const before = calls.length;
      const r = await post("/phone/call-code", B, { phone: PHONE });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(calls.length, before);
    });
  } finally {
    server.close();
    await db.run("DELETE FROM phone_call_codes WHERE user_id = ANY($1::int[])", [[A, B]]).catch(() => {});
    await db.run("DELETE FROM users WHERE id = ANY($1::int[])", [[A, B]]).catch(() => {});
  }
  console.log(`\n${passed} passed`);
  process.exit(process.exitCode || 0);
})();
