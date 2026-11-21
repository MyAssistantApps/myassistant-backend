/**
 * BOOK A CAB BY VOICE (2026-11-21) — `npm run test:rides`.
 *
 * The whole flow on the TEST provider (nothing real is booked):
 * "book a cab from Yeshwanthpur to Majestic" with no company named →
 * booked and confirmed → driver, car and OTP pushed → status by voice →
 * cancel. Also: no provider → the deep-link handoff as before; a high fare
 * waits for a yes; one ride at a time. Needs a throwaway DATABASE_URL.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "rides-test-secret-rides-test-secret-rides-01";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.RIDES_TEST_STEP_MS = "40";

const assert = require("assert");
const db = require("../src/db");

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await db.init();
  require("../src/tools/builtins").registerBuiltins();
  const registry = require("../src/tools/registry");
  const rides = require("../src/rides/service");
  await rides.migrate();
  const pushes = [];
  require("../src/services/push").sendNotification = async (_t, title, body, data) => { pushes.push({ title, body, data }); return true; };

  const u = await db.one(
    `INSERT INTO users (name, email, password_hash, fcm_token, created_at) VALUES ('Ride Tester', $1, 'x', 'tok', $2) RETURNING id`,
    [`rides-${Date.now()}@test.local`, Date.now()]);
  const me = Number(u.id);
  const ctx = { userId: me, lat: 13.0285, lng: 77.5409 };

  console.log("\nno booking provider");
  await test("without partner access the tool opens the provider's app with the trip set (as before)", async () => {
    delete process.env.RIDES_TEST_PROVIDER;
    const r = await registry.execute("book_ride", { pickup: "Yeshwanthpur", destination: "Majestic" }, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.deviceAction && /uber\.com|olacabs/.test(r.deviceAction.url), JSON.stringify(r.deviceAction));
    assert.ok(!r.data?.booked);
  });

  console.log("\nbooking by voice (test provider)");
  process.env.RIDES_TEST_PROVIDER = "on";
  let ride;
  await test("'book a cab from Yeshwanthpur to Majestic', no company named: booked and confirmed", async () => {
    const r = await registry.execute("book_ride", { pickup: "Yeshwanthpur", destination: "Majestic" }, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.booked, true);
    ride = r.data.ride;
    assert.strictEqual(ride.pickup, "Yeshwanthpur");
    assert.strictEqual(ride.drop, "Majestic");
    assert.ok(ride.fare > 0);
    assert.match(r.speak, /^Booked\. .* from Yeshwanthpur to Majestic/);
    assert.match(r.speak, /TEST booking/, "a test booking always says so");
    assert.strictEqual(r.deviceAction.type, "ride_booked");
  });
  await test("a second ride while one is active is not booked twice", async () => {
    const r = await registry.execute("book_ride", { destination: "Airport" }, ctx);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "already_active");
  });
  await test("the driver, car and OTP are pushed once a driver accepts", async () => {
    for (let i = 0; i < 4; i++) {
      await sleep(50);
      await rides.onJob({ id: ride.id });
    }
    const assigned = pushes.find((p) => /Driver Assigned/.test(p.title));
    assert.ok(assigned, JSON.stringify(pushes));
    assert.match(assigned.body, /Your OTP is \d{4}/);
    assert.match(assigned.title, /\(Test\)/);
    assert.strictEqual(assigned.data.kind, "ride_update");
  });
  await test("'what is my OTP?' answers from the booked ride", async () => {
    const r = await registry.execute("ride_status", {}, ctx);
    const now = await rides.active(me);
    if (now) {
      assert.match(r.speak, /OTP \d \d \d \d/);
      assert.ok(now.vehicle?.plate);
    } else {
      assert.match(r.speak, /no cab booked/); // the test ride already finished
    }
  });
  await test("each status is pushed once, and the trip ends completed", async () => {
    for (let i = 0; i < 6; i++) {
      await sleep(50);
      await rides.onJob({ id: ride.id });
    }
    const row = await db.one(`SELECT status FROM ride_bookings WHERE id = $1`, [ride.id]);
    assert.strictEqual(row.status, "completed");
    const titles = pushes.map((p) => p.title.replace(" (Test)", ""));
    assert.strictEqual(titles.filter((t) => t === "Driver Assigned: Test Driver").length, 1);
    assert.ok(titles.includes("Trip Completed"));
  });
  await test("cancel by voice", async () => {
    const r1 = await registry.execute("book_ride", { destination: "MG Road" }, ctx);
    assert.strictEqual(r1.ok, true, JSON.stringify(r1));
    assert.strictEqual(r1.data.ride.pickup, "Your current location");
    const c = await registry.execute("cancel_ride", {}, ctx);
    assert.strictEqual(c.ok, true);
    assert.match(c.speak, /cancelled/);
    assert.strictEqual(await rides.active(me), null);
  });
  await test("a fare above the limit waits for a yes", async () => {
    const saved = process.env.RIDES_MAX_FARE;
    delete require.cache[require.resolve("../src/rides/service")];
    process.env.RIDES_MAX_FARE = "10";
    const svc = require("../src/rides/service");
    try {
      const r = await svc.book({ userId: me, from: "Yeshwanthpur", to: "Majestic" });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.needs, "fare_confirmation");
      assert.match(r.speak, /Shall I book it\?/);
      const yes = await svc.book({ userId: me, from: "Yeshwanthpur", to: "Majestic", confirmFare: true });
      assert.strictEqual(yes.ok, true);
      await svc.cancel(me);
    } finally {
      if (saved === undefined) delete process.env.RIDES_MAX_FARE; else process.env.RIDES_MAX_FARE = saved;
      delete require.cache[require.resolve("../src/rides/service")];
    }
  });
  await test("the test provider is never on unless asked for", () => {
    delete process.env.RIDES_TEST_PROVIDER;
    assert.strictEqual(require("../src/rides/service").canBook(), false);
  });

  await require("../src/routes/privacy").deleteAccount?.(me).catch?.(() => {});
  await db.run(`DELETE FROM ride_bookings WHERE user_id = $1`, [me]);
  await db.run(`DELETE FROM users WHERE id = $1`, [me]);
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
