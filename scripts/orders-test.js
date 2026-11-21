/**
 * ORDER BY VOICE (2026-11-21) — `npm run test:orders`.
 *
 * Food, groceries, medicines and parcels on the TEST provider (nothing
 * real is ordered): placed and confirmed, each step pushed once with the
 * delivery partner and OTP, status and cancel by voice, a high total waits
 * for a yes, and without a provider every tool still opens the right app.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "orders-test-secret-orders-test-secret-orders-1";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.ORDERS_TEST_STEP_MS = "30";

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
  const orders = require("../src/orders/service");
  await orders.migrate();
  const pushes = [];
  require("../src/services/push").sendNotification = async (_t, title, body, data) => { pushes.push({ title, body, data }); return true; };
  const u = await db.one(
    `INSERT INTO users (name, email, password_hash, fcm_token, created_at) VALUES ('Order Tester', $1, 'x', 'tok', $2) RETURNING id`,
    [`orders-${Date.now()}@test.local`, Date.now()]);
  const me = Number(u.id);
  const ctx = { userId: me, lat: 12.97, lng: 77.59 };
  const stamp = Date.now() % 100000; // unique words: the repeat guard is per target

  console.log("\nwithout a provider: the right app opens, as before");
  delete process.env.ORDERS_TEST_PROVIDER;
  await test("groceries → Blinkit search, medicines → 1mg search, parcel → Porter", async () => {
    const g = await registry.execute("order_groceries", { items: [`milk ${stamp}`] }, ctx);
    assert.match(g.deviceAction.url, /blinkit/);
    const m = await registry.execute("order_medicines", { items: [`Dolo 650 ${stamp}`] }, ctx);
    assert.match(m.deviceAction.url, /1mg\.com\/search/);
    const p = await registry.execute("send_parcel", { pickup: `Indiranagar ${stamp}`, drop: "Jayanagar" }, ctx);
    assert.match(p.deviceAction.url, /porter/);
  });

  console.log("\nordering by voice (test provider)");
  process.env.ORDERS_TEST_PROVIDER = "on";
  let food;
  await test("'order chicken biryani': ordered and confirmed, no app named", async () => {
    const r = await registry.execute("order_food", { dish: `chicken biryani ${stamp}` }, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    food = r.data.order;
    assert.strictEqual(food.kind, "food");
    assert.match(r.speak, /^Ordered\. chicken biryani/);
    assert.match(r.speak, /TEST order/);
    assert.strictEqual(r.deviceAction.type, "order_placed");
  });
  await test("groceries and medicines are ordered; medicines mention the prescription", async () => {
    const g = await registry.execute("order_groceries", { items: [`1 litre milk ${stamp}`, "6 eggs"] }, ctx);
    assert.strictEqual(g.data.order.kind, "grocery");
    const m = await registry.execute("order_medicines", { items: [`Dolo 650 strip ${stamp}`] }, ctx);
    assert.strictEqual(m.data.order.kind, "medicine");
    assert.match(m.speak, /prescription/);
  });
  await test("a parcel needs both ends, then is booked", async () => {
    const r = await registry.execute("send_parcel", { pickup: `Indiranagar office ${stamp}`, drop: "Jayanagar home", item: "documents" }, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.match(r.speak, /^Booked\. A Test Store pickup for documents from Indiranagar office/);
    const bad = await orders.place({ userId: me, kind: "parcel", items: ["x"], pickup: "A" });
    assert.strictEqual(bad.needs, "drop");
  });
  await test("each step is pushed once; the delivery partner and OTP come with 'out for delivery'", async () => {
    for (let i = 0; i < 6; i++) {
      await sleep(40);
      await orders.onJob({ id: food.id });
    }
    const mine = pushes.filter((p) => p.data.orderId === String(food.id));
    const titles = mine.map((p) => p.title.replace(" (Test)", ""));
    assert.deepStrictEqual(titles, ["Food Order Confirmed", "Your Food Is Being Prepared", "Out for Delivery", "Delivered"]);
    assert.match(mine[2].body, /Your OTP is \d{4}/);
    assert.strictEqual((await db.one(`SELECT status FROM order_bookings WHERE id = $1`, [food.id])).status, "delivered");
  });
  await test("'where is my order?' lists what is in progress", async () => {
    const r = await registry.execute("order_status", {}, ctx);
    assert.ok(r.data.orders.length >= 1);
    assert.match(r.speak, /Test Store/);
  });
  await test("cancel by voice; an order already out for delivery cannot be cancelled", async () => {
    const r = await registry.execute("cancel_order", {}, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.match(r.speak, /cancelled/);
    const o = await orders.place({ userId: me, kind: "grocery", items: [`bread ${stamp}`] });
    const t = require("../src/orders/providers")._testOrders.get(
      (await db.one(`SELECT external_id FROM order_bookings WHERE id = $1`, [o.order.id])).external_id);
    t.step = 3; // out for delivery
    const late = await orders.cancel(me, o.order.id);
    assert.strictEqual(late.error, "too_late");
  });
  await test("a total above the limit waits for a yes", async () => {
    delete require.cache[require.resolve("../src/orders/service")];
    process.env.ORDERS_MAX_TOTAL = "50";
    const svc = require("../src/orders/service");
    try {
      const r = await svc.place({ userId: me, kind: "food", items: ["thali"] });
      assert.strictEqual(r.needs, "total_confirmation");
      assert.match(r.speak, /Shall I place it\?/);
      const yes = await svc.place({ userId: me, kind: "food", items: ["thali"], confirmTotal: true });
      assert.strictEqual(yes.ok, true);
    } finally {
      delete process.env.ORDERS_MAX_TOTAL;
      delete require.cache[require.resolve("../src/orders/service")];
    }
  });
  await test("Swiggy, Porter and Tata 1mg stay off until their credentials are set", () => {
    const p = require("../src/orders/providers").ALL;
    assert.strictEqual(p.swiggy.available(), false);
    assert.strictEqual(p.porter.available(), false);
    assert.strictEqual(p.tata1mg.available(), false);
    delete process.env.ORDERS_TEST_PROVIDER;
    assert.strictEqual(require("../src/orders/service").canOrder("food"), false);
  });

  await db.run(`DELETE FROM order_bookings WHERE user_id = $1`, [me]);
  await db.run(`DELETE FROM users WHERE id = $1`, [me]);
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
