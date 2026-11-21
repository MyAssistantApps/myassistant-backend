/**
 * ENGINEERING AUDIT TESTS (2026-11-20) — `npm run test:audit`.
 *
 * One test per fix from the 2026-11-20 audit, against a THROWAWAY database
 * (DATABASE_URL), so the races are exercised for real rather than mocked:
 * concurrent bookings, double-accepts, double reminder claims, job leases,
 * the cluster lock and user-scan pagination.
 * Without DATABASE_URL it skips (and says so) instead of failing.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "audit-test-secret-audit-test-secret-audit-01";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");
const express = require("express");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e && (e.stack || e.message)}`);
    process.exitCode = 1;
  }
}

const tag = `audit${Date.now().toString(36)}`;
async function makeUser(db, name, extra = {}) {
  const u = await db.one(
    `INSERT INTO users (email, name, created_at) VALUES ($1,$2,$3) RETURNING id`,
    [`${tag}-${name.replace(/\W/g, "")}-${Math.random().toString(36).slice(2, 8)}@example.test`, name, Date.now()]);
  for (const [k, v] of Object.entries(extra)) {
    await db.run(`UPDATE users SET ${k} = $1 WHERE id = $2`, [v, u.id]);
  }
  return Number(u.id);
}

(async () => {
  if (!hasDb) {
    console.log("audit tests: skipped (set DATABASE_URL to a throwaway database)");
    return;
  }
  const db = require("../src/db");
  await db.init();

  console.log("\nclinic: concurrent bookings (clinic/store.js)");
  const clinic = require("../src/clinic/store");
  await clinic.migrate();

  await test("two simultaneous bookings of one free slot: exactly one wins", async () => {
    const doc = await makeUser(db, "Dr Race");
    const tz = 330;
    // Tomorrow's first free slot in the doctor's default hours.
    // The next day the default hours are open (Sunday is closed).
    let free = [];
    for (let d = 1; d <= 7 && !free.length; d++) {
      free = await clinic.slotsFor(doc, clinic.localMidnight(Date.now() + d * 86400_000, tz), { tzOffsetMin: tz });
    }
    assert.ok(free.length, "default hours should offer a slot this week");
    const startsAt = free[0];
    const book = (n) => clinic.createAppointment(doc, { patientName: n, startsAt, source: "app" },
      { requireFreeSlot: true, tzOffsetMin: tz });
    const results = await Promise.allSettled([book("A"), book("B"), book("C")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const taken = results.filter((r) => r.status === "rejected" && r.reason instanceof clinic.SlotTakenError);
    assert.strictEqual(ok.length, 1, `one booking, got ${ok.length}`);
    assert.strictEqual(taken.length, 2, "the others are told the slot is taken");
  });

  await test("a booking without the free-slot check still succeeds (doctor squeezes one in)", async () => {
    const doc = await makeUser(db, "Dr Squeeze");
    const startsAt = Date.now() + 2 * 86400_000;
    const a = await clinic.createAppointment(doc, { patientName: "X", startsAt });
    const b = await clinic.createAppointment(doc, { patientName: "Y", startsAt });
    assert.ok(a.id && b.id && a.id !== b.id);
  });

  console.log("\nreminder calls are claimed once (clinic, pro)");
  await test("markReminded claims an appointment once; a second claim is refused", async () => {
    const doc = await makeUser(db, "Dr Remind");
    const a = await clinic.createAppointment(doc, { patientName: "Z", startsAt: Date.now() + 5 * 3600_000 });
    const claims = await Promise.all([clinic.markReminded(a.id), clinic.markReminded(a.id)]);
    assert.deepStrictEqual(claims.sort(), [false, true]);
  });

  await test("markHearingReminded claims a hearing once", async () => {
    const pro = require("../src/pro/store");
    await pro.migrate();
    const adv = await makeUser(db, "Adv Remind");
    const h = await db.one(
      `INSERT INTO pro_hearings (user_id, case_id, at, created_at) VALUES ($1,0,$2,$3) RETURNING id`,
      [adv, Date.now() + 5 * 3600_000, Date.now()]);
    const claims = await Promise.all([pro.markHearingReminded(h.id), pro.markHearingReminded(h.id)]);
    assert.deepStrictEqual(claims.sort(), [false, true]);
  });

  console.log("\nlisting requests: accept is claimed (listings)");
  await test("claimRequest moves a request out of 'new' once", async () => {
    const store = require("../src/listings/store");
    await store.migrate();
    const owner = await makeUser(db, "Dr Listing");
    const r = await db.one(
      `INSERT INTO listing_requests (user_id, name, phone, status, created_at, updated_at)
       VALUES ($1,'Pat','+919800000001','new',$2,$2) RETURNING id`, [owner, Date.now()]).catch(() => null);
    if (!r) return console.log("       (listing_requests needs more columns here; covered by test:listings)");
    const claims = await Promise.all([
      store.claimRequest(owner, r.id, "accepted"), store.claimRequest(owner, r.id, "accepted")]);
    assert.strictEqual(claims.filter(Boolean).length, 1);
  });

  console.log("\njob queue leases (infra/jobs.js)");
  const jobs = require("../src/infra/jobs");
  await test("a running job with a fresh heartbeat is left alone; a stale one is failed", async () => {
    const now = Date.now();
    const fresh = await db.one(
      `INSERT INTO jobs (kind, status, run_after, created_at, updated_at) VALUES ('audit.fresh','running',$1,$1,$1) RETURNING id`, [now]);
    const stale = await db.one(
      `INSERT INTO jobs (kind, status, run_after, created_at, updated_at) VALUES ('audit.stale','running',$1,$1,$2) RETURNING id`,
      [now, now - jobs.LEASE_MS - 1000]);
    await jobs.reapStale(now);
    const f = await db.one(`SELECT status FROM jobs WHERE id=$1`, [fresh.id]);
    const s = await db.one(`SELECT status, last_error FROM jobs WHERE id=$1`, [stale.id]);
    assert.strictEqual(f.status, "running", "another replica's live job must survive a boot");
    assert.strictEqual(s.status, "failed");
    assert.match(s.last_error, /interrupted/);
    await db.run(`DELETE FROM jobs WHERE kind LIKE 'audit.%'`);
  });

  console.log("\ncluster lock (infra/leader.js)");
  await test("only one of two concurrent holders runs; the lock is free afterwards", async () => {
    const { exclusive } = require("../src/infra/leader");
    let release;
    const gate = new Promise((r) => { release = r; });
    const first = exclusive("audit.lock", () => gate.then(() => "first"));
    await new Promise((r) => setTimeout(r, 100));
    const second = await exclusive("audit.lock", async () => "second");
    assert.deepStrictEqual(second, { ran: false });
    release();
    assert.deepStrictEqual(await first, { ran: true, value: "first" });
    const third = await exclusive("audit.lock", async () => "third");
    assert.deepStrictEqual(third, { ran: true, value: "third" });
  });

  await test("a throwing holder still releases the lock", async () => {
    const { exclusive } = require("../src/infra/leader");
    await assert.rejects(exclusive("audit.throw", async () => { throw new Error("boom"); }), /boom/);
    assert.deepStrictEqual(await exclusive("audit.throw", async () => 1), { ran: true, value: 1 });
  });

  console.log("\nproactive sweeps see every user (proactive/scheduler.js)");
  await test("everyUser pages past the page size, in id order, without repeats", async () => {
    const { everyUser } = require("../src/proactive/scheduler");
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push(await makeUser(db, `Page ${i}`));
    const rows = await everyUser(`SELECT id FROM users WHERE email LIKE '${tag}-Page%'`, "id", 3);
    assert.deepStrictEqual(rows.map((r) => Number(r.id)), ids);
  });

  console.log("\ngreetings: only the shared openings are stored (ai/liveVoices.js)");
  await test("a made-up greeting line is spoken but never written to disk", async () => {
    const fs = require("fs");
    const path = require("path");
    const openai = require("../src/services/ai/openai");
    const saved = { speak: openai.speak, wavWrap: openai.wavWrap };
    openai.speak = async () => Buffer.alloc(48000);
    openai.wavWrap = (pcm) => Buffer.concat([Buffer.from("RIFF"), pcm]);
    const dir = path.join(require("os").tmpdir(), `${tag}-voices`);
    process.env.VOICE_SAMPLE_DIR = dir; // read when liveVoices loads, just below
    const lv = require("../src/ai/liveVoices");
    const before = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).length : 0;
    try {
      const wav = await lv.greeting(lv.CATALOG[0].id, "Hello Qwertyuiop");
      assert.ok(wav && wav.length > 4);
      const after = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).length : 0;
      assert.strictEqual(after, before, "no new file for an arbitrary line");
      // …while the shared opening is kept (made once for everyone).
      await lv.greeting(lv.CATALOG[0].id, lv.OPENING_LINES[0]);
      assert.ok(fs.readdirSync(dir).length === before + 1, "the opening is stored");
    } finally {
      Object.assign(openai, saved);
    }
  });

  console.log("\nobservability: unmatched paths share one metrics key (infra/observability.js)");
  await test("junk paths do not each create a latency key; bad request ids are replaced", async () => {
    const obs = require("../src/infra/observability");
    const app = express();
    app.use(obs.requestId());
    app.get("/known", (_q, r) => r.json({}));
    app.use((_q, r) => r.status(404).json({}));
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const keysBefore = Object.keys(obs.snapshot().latency || {}).length;
      for (let i = 0; i < 20; i++) await fetch(`${base}/junk${i}-${tag}`);
      await new Promise((r) => setTimeout(r, 50));
      const keys = Object.keys(obs.snapshot().latency || {});
      assert.ok(keys.length - keysBefore <= 1, `grew by ${keys.length - keysBefore}`);
      const res = await fetch(`${base}/known`, { headers: { "x-request-id": "x".repeat(500) } });
      assert.ok(res.headers.get("x-request-id").length <= 64);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100).unref());
