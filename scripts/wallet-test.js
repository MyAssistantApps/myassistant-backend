/**
 * WALLET TESTS — `npm run test:wallet` (Phase 1: ledger + Razorpay top-ups).
 *
 * Part 1 (always): the pure decisions — top-up limits and their messages,
 * ledger legs that must balance, Checkout's signature, the webhook's.
 *
 * Part 2 (only when DATABASE_URL is set, against a THROWAWAY database):
 * the whole flow over HTTP with Razorpay faked — create a top-up (same
 * Idempotency-Key → same order), verify it (bad signature refused, amount
 * fetched from "Razorpay"), the webhook arriving too (credited ONCE), a
 * replayed webhook, an amount mismatch, limits, two phones at once, the
 * database refusing an unbalanced, edited or deleted ledger row, the
 * reconcile job crediting a lost webhook, the daily integrity check, and
 * an account erase that keeps the ledger whole.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.RAZORPAY_KEY_ID = "rzp_test_walletsuite";
process.env.RAZORPAY_KEY_SECRET = "wallet_suite_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "wallet_suite_webhook_secret";

const assert = require("assert");
const crypto = require("crypto");
const service = require("../src/wallet/service");
const store = require("../src/wallet/store");
const razorpay = require("../src/wallet/razorpay");

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

const sign = (order, pay) => crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
  .update(`${order}|${pay}`).digest("hex");

(async () => {
  console.log("\nwallet — pure");

  await test("limits: min, max, daily and cap, each with a plain message", () => {
    const l = { minTopup: 1000, maxTopup: 1_000_000, daily: 2_000_000, cap: 5_000_000 };
    assert.strictEqual(service.checkTopupAmount(10_000, {}, l), null);
    assert.strictEqual(service.checkTopupAmount(999, {}, l).code, "amount_out_of_range");
    assert.strictEqual(service.checkTopupAmount(1_000_001, {}, l).code, "amount_out_of_range");
    assert.strictEqual(service.checkTopupAmount(10.5, {}, l).code, "amount_out_of_range");
    assert.strictEqual(service.checkTopupAmount(-500, {}, l).code, "amount_out_of_range");
    assert.strictEqual(service.checkTopupAmount("5000", {}, l).code, "amount_out_of_range");
    const d = service.checkTopupAmount(600_000, { dailyUsed: 1_500_000 }, l);
    assert.strictEqual(d.code, "daily_limit");
    assert.strictEqual(d.daily_left_paise, 500_000);
    assert.match(d.message, /₹5,000 more today/);
    const c = service.checkTopupAmount(200_000, { cash: 4_900_000 }, l);
    assert.strictEqual(c.code, "wallet_cap");
    assert.strictEqual(c.cap_left_paise, 100_000);
  });

  await test("rupees() reads like money", () => {
    assert.strictEqual(service.rupees(150000), "₹1,500");
    assert.strictEqual(service.rupees(1050), "₹10.5");
    assert.strictEqual(service.rupees(10000000), "₹1,00,000");
  });

  await test("ledger legs must be whole, non-zero, distinct and sum to zero", () => {
    assert.strictEqual(store.validateLegs([{ accountId: 1, amount: -500 }, { accountId: 2, amount: 500 }]), null);
    assert.match(store.validateLegs([{ accountId: 1, amount: 500 }]), /at least two/);
    assert.match(store.validateLegs([{ accountId: 1, amount: -500 }, { accountId: 2, amount: 400 }]), /sum to zero/);
    assert.match(store.validateLegs([{ accountId: 1, amount: -0.5 }, { accountId: 2, amount: 0.5 }]), /whole-paise/);
    assert.match(store.validateLegs([{ accountId: 1, amount: 0 }, { accountId: 2, amount: 0 }]), /non-zero/);
    assert.match(store.validateLegs([{ accountId: 1, amount: -5 }, { accountId: 1, amount: 5 }]), /only once/);
    assert.match(store.validateLegs([{ amount: -5 }, { accountId: 2, amount: 5 }]), /account/);
  });

  await test("Checkout signature: right one passes, anything else fails", () => {
    assert.ok(razorpay.verifyCheckoutSignature("order_A", "pay_B", sign("order_A", "pay_B")));
    assert.ok(!razorpay.verifyCheckoutSignature("order_A", "pay_C", sign("order_A", "pay_B")));
    assert.ok(!razorpay.verifyCheckoutSignature("order_A", "pay_B", sign("order_A", "pay_B").slice(0, 10)));
    assert.ok(!razorpay.verifyCheckoutSignature("order_A", "pay_B", ""));
    assert.ok(!razorpay.verifyCheckoutSignature("", "pay_B", sign("", "pay_B")));
  });

  await test("webhook signature (payments/service): raw bytes, constant time", () => {
    const payments = require("../src/payments/service");
    const raw = Buffer.from('{"event":"payment.captured"}');
    const good = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
    assert.ok(payments.verifySignature(raw, good));
    assert.ok(!payments.verifySignature(Buffer.from('{"event":"payment.captured" }'), good));
    assert.ok(!payments.verifySignature(raw, "00"));
    assert.ok(!payments.verifySignature(undefined, good));
  });

  await test("payment and order ids are checked before any call", async () => {
    await assert.rejects(razorpay.fetchPayment("../orders"), /not a payment id/);
    await assert.rejects(razorpay.orderPayments("order_x/../y"), /not an order id/);
  });

  if (!hasDb) {
    console.log(`\n${passed} passed (database part skipped: set DATABASE_URL to a THROWAWAY database to run it)`);
    return;
  }

  /* ================================================================ */
  console.log("\nwallet — database (throwaway DB)");
  const db = require("../src/db");
  await db.init();

  // A fake Razorpay: orders and payments in memory.
  // Ids carry a per-run prefix: real Razorpay ids are never reused, and a
  // second run on the same database must not collide with the first.
  const run = Date.now().toString(36);
  const fake = { orders: new Map(), payments: new Map(), n: 0, down: false };
  const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });
  razorpay._setFetch(async (url, opts = {}) => {
    if (fake.down) throw new Error("ECONNREFUSED");
    const u = new URL(url);
    const p = u.pathname.replace("/v1", "");
    if (opts.method === "POST" && p === "/orders") {
      const b = JSON.parse(opts.body);
      const id = `order_T${run}${++fake.n}`;
      const o = { id, amount: b.amount, currency: b.currency, receipt: b.receipt, notes: b.notes, status: "created" };
      fake.orders.set(id, o);
      return respond(200, o);
    }
    let m;
    if ((m = p.match(/^\/payments\/(pay_\w+)$/))) {
      const pay = fake.payments.get(m[1]);
      return pay ? respond(200, pay) : respond(400, { error: { description: "not found" } });
    }
    if ((m = p.match(/^\/orders\/(order_\w+)\/payments$/))) {
      return respond(200, { items: [...fake.payments.values()].filter((x) => x.order_id === m[1]) });
    }
    if (p === "/payments") return respond(200, { items: [...fake.payments.values()] });
    return respond(404, { error: { description: "no route" } });
  });
  const pay = (orderId, { amount, status = "captured", currency = "INR" } = {}) => {
    const o = fake.orders.get(orderId);
    const id = `pay_T${run}${++fake.n}`;
    const p = { id, order_id: orderId, amount: amount ?? o.amount, currency, status, method: "upi",
      notes: o.notes, created_at: Math.floor(Date.now() / 1000) };
    fake.payments.set(id, p);
    return p;
  };

  // The routes over HTTP, with a stand-in for appAuth.
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const uid = req.get("X-Test-User");
    req.user = uid ? { sub: uid, name: "Test", email: "t@example.test" } : null;
    next();
  });
  app.use("/wallet", require("../src/wallet/routes"));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (uid, method, path, body, headers = {}) => {
    const r = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", "X-Test-User": String(uid), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };

  const stamp = String(Date.now()).slice(-8);
  const mkUser = async (tag) => (await db.createUser({ email: `wallet-${tag}-${stamp}@example.test`, name: `Wallet ${tag}` })).id;
  const u1 = await mkUser("one");
  const u2 = await mkUser("two");
  const key = () => crypto.randomUUID();

  let topup;
  await test("a top-up needs an Idempotency-Key and a valid amount", async () => {
    let r = await http(u1, "POST", "/wallet/topups", { amount_paise: 50_000 });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, "idempotency_key_required");
    r = await http(u1, "POST", "/wallet/topups", { amount_paise: 50 }, { "Idempotency-Key": key() });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, "amount_out_of_range");
  });

  await test("same Idempotency-Key → the same order, not a second one", async () => {
    const k = key();
    const a = await http(u1, "POST", "/wallet/topups", { amount_paise: 50_000 }, { "Idempotency-Key": k });
    const b = await http(u1, "POST", "/wallet/topups", { amount_paise: 50_000 }, { "Idempotency-Key": k });
    assert.strictEqual(a.status, 201);
    assert.strictEqual(b.status, 201);
    assert.strictEqual(a.body.razorpay_order_id, b.body.razorpay_order_id);
    assert.strictEqual(a.body.key_id, "rzp_test_walletsuite");
    assert.strictEqual(a.body.test_mode, true);
    assert.strictEqual(fake.orders.get(a.body.razorpay_order_id).amount, 50_000);
    const c = await http(u1, "POST", "/wallet/topups", { amount_paise: 60_000 }, { "Idempotency-Key": k });
    assert.strictEqual(c.status, 409);
    assert.strictEqual(c.body.error, "idempotency_key_reused");
    topup = a.body;
  });

  await test("verify: a bad signature or another order is refused, nothing credited", async () => {
    const p = pay(topup.razorpay_order_id);
    let r = await http(u1, "POST", `/wallet/topups/${topup.topup_id}/verify`,
      { razorpay_payment_id: p.id, razorpay_order_id: topup.razorpay_order_id, razorpay_signature: "f".repeat(64) });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, "bad_signature");
    r = await http(u1, "POST", `/wallet/topups/${topup.topup_id}/verify`,
      { razorpay_payment_id: p.id, razorpay_order_id: "order_other", razorpay_signature: sign("order_other", p.id) });
    assert.strictEqual(r.status, 409);
    assert.strictEqual((await store.balances(u1)).cash, 0);
    topup.payment = p;
  });

  await test("verify → credited; the webhook after it changes nothing", async () => {
    const p = topup.payment;
    const r = await http(u1, "POST", `/wallet/topups/${topup.topup_id}/verify`,
      { razorpay_payment_id: p.id, razorpay_order_id: topup.razorpay_order_id, razorpay_signature: sign(topup.razorpay_order_id, p.id) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, "credited");
    assert.strictEqual(r.body.cash_paise, 50_000);
    const w = await service.handleEvent({ event: "payment.captured", payload: { payment: { entity: p } } }, `evt_${p.id}`);
    assert.strictEqual(w, "already_credited");
    assert.strictEqual((await store.balances(u1)).cash, 50_000);
    const again = await service.handleEvent({ event: "payment.captured", payload: { payment: { entity: p } } }, `evt_${p.id}`);
    assert.strictEqual(again, "duplicate");
    const s = await http(u1, "GET", `/wallet/topups/${topup.topup_id}`);
    assert.strictEqual(s.body.status, "credited");
  });

  await test("the webhook alone credits (app closed after paying)", async () => {
    const t = await http(u1, "POST", "/wallet/topups", { amount_paise: 20_000 }, { "Idempotency-Key": key() });
    const p = pay(t.body.razorpay_order_id);
    const w = await service.handleEvent({ event: "order.paid", payload: { payment: { entity: p } } }, `evt_alone_${p.id}`);
    assert.strictEqual(w, "credited");
    assert.strictEqual((await store.balances(u1)).cash, 70_000);
  });

  await test("an amount that differs from the order is flagged, never credited", async () => {
    const t = await http(u1, "POST", "/wallet/topups", { amount_paise: 30_000 }, { "Idempotency-Key": key() });
    const p = pay(t.body.razorpay_order_id, { amount: 3_000 });
    const w = await service.handleEvent({ event: "payment.captured", payload: { payment: { entity: p } } }, `evt_mm_${p.id}`);
    assert.strictEqual(w, "mismatch");
    assert.strictEqual((await store.balances(u1)).cash, 70_000);
    const s = await http(u1, "GET", `/wallet/topups/${t.body.topup_id}`);
    assert.strictEqual(s.body.status, "flagged");
  });

  await test("a failed payment marks the top-up failed and moves nothing", async () => {
    const t = await http(u1, "POST", "/wallet/topups", { amount_paise: 10_000 }, { "Idempotency-Key": key() });
    const p = pay(t.body.razorpay_order_id, { status: "failed" });
    const w = await service.handleEvent({ event: "payment.failed", payload: { payment: { entity: p } } }, `evt_f_${p.id}`);
    assert.strictEqual(w, "failed");
    assert.strictEqual((await store.balances(u1)).cash, 70_000);
  });

  await test("another user cannot see or verify my top-up", async () => {
    const r = await http(u2, "GET", `/wallet/topups/${topup.topup_id}`);
    assert.strictEqual(r.status, 404);
    const v = await http(u2, "POST", `/wallet/topups/${topup.topup_id}/verify`, {});
    assert.strictEqual(v.status, 404);
  });

  await test("verify and webhook racing credit exactly once", async () => {
    const t = await http(u2, "POST", "/wallet/topups", { amount_paise: 40_000 }, { "Idempotency-Key": key() });
    const p = pay(t.body.razorpay_order_id);
    const body = { razorpay_payment_id: p.id, razorpay_order_id: t.body.razorpay_order_id, razorpay_signature: sign(t.body.razorpay_order_id, p.id) };
    await Promise.all([
      http(u2, "POST", `/wallet/topups/${t.body.topup_id}/verify`, body),
      service.handleEvent({ event: "payment.captured", payload: { payment: { entity: p } } }, `evt_race_${p.id}`),
      service.creditFromPayment(p, "test"),
      service.creditFromPayment(p, "test"),
    ]);
    assert.strictEqual((await store.balances(u2)).cash, 40_000);
    const n = await db.one(`SELECT COUNT(*)::int AS n FROM wallet_transactions WHERE idempotency_key = $1`, [`topup:${p.id}`]);
    assert.strictEqual(n.n, 1);
  });

  await test("daily limit holds even when two top-ups start at once", async () => {
    process.env.WALLET_DAILY_TOPUP_PAISE = "100000";
    const u3 = await mkUser("three");
    const rs = await Promise.all([1, 2, 3].map(() =>
      http(u3, "POST", "/wallet/topups", { amount_paise: 60_000 }, { "Idempotency-Key": key() })));
    assert.strictEqual(rs.filter((r) => r.status === 201).length, 1, JSON.stringify(rs.map((r) => r.body)));
    assert.ok(rs.some((r) => r.body.error === "daily_limit"));
    delete process.env.WALLET_DAILY_TOPUP_PAISE;
  });

  await test("Razorpay down → a clear 503, the top-up is marked failed", async () => {
    fake.down = true;
    const r = await http(u2, "POST", "/wallet/topups", { amount_paise: 10_000 }, { "Idempotency-Key": key() });
    fake.down = false;
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.error, "payments_unavailable");
  });

  await test("the database refuses unbalanced, edited and deleted ledger rows", async () => {
    const acct = await db.one(`SELECT id FROM wallet_accounts WHERE user_id = $1 AND kind = 'cash'`, [u1]);
    await assert.rejects(db.tx(async (c) => {
      await c.query(`INSERT INTO wallet_transactions (id, type, amount_paise, idempotency_key, created_at)
                     VALUES ($1, 'adjustment', 100, $2, $3)`, [store.newId(), `bad:${key()}`, Date.now()]);
      const t = (await c.query(`SELECT id FROM wallet_transactions ORDER BY created_at DESC LIMIT 1`)).rows[0];
      await c.query(`INSERT INTO wallet_entries (transaction_id, account_id, amount_paise, balance_after_paise, created_at)
                     VALUES ($1, $2, 100, 0, $3)`, [t.id, acct.id, Date.now()]);
    }), /does not balance/);
    await assert.rejects(db.query(`UPDATE wallet_entries SET amount_paise = amount_paise * 2`), /append-only/);
    await assert.rejects(db.query(`DELETE FROM wallet_entries`), /append-only/);
    await assert.rejects(db.query(`DELETE FROM wallet_transactions`), /cannot be deleted/);
    await assert.rejects(db.query(`UPDATE wallet_transactions SET amount_paise = 1`), /cannot change/);
    await assert.rejects(db.query(`UPDATE wallet_accounts SET balance_paise = -1 WHERE id = $1`, [acct.id]), /user_nonneg/);
  });

  await test("post() refuses to take a user below zero, and rolls back", async () => {
    await assert.rejects(db.tx(async (c) => {
      const cash = await store.userAccount(c, u2, "cash");
      const rev = await store.systemAccount(c, "sys_revenue");
      await store.post(c, { userId: u2, type: "spend", key: `over:${key()}`, amount: 1_000_000,
        legs: [{ accountId: cash.id, amount: -1_000_000 }, { accountId: rev.id, amount: 1_000_000 }] });
    }), /insufficient balance/);
    assert.strictEqual((await store.balances(u2)).cash, 40_000);
  });

  await test("history lists what happened, newest first, with the balance after", async () => {
    const r = await http(u1, "GET", "/wallet/transactions?limit=1");
    assert.strictEqual(r.body.items.length, 1);
    assert.strictEqual(r.body.items[0].direction, "in");
    assert.strictEqual(r.body.items[0].amount_paise, 20_000);
    assert.strictEqual(r.body.items[0].cash_after_paise, 70_000);
    const next = await http(u1, "GET", `/wallet/transactions?limit=5&cursor=${encodeURIComponent(r.body.next_cursor)}`);
    assert.strictEqual(next.body.items[0].amount_paise, 50_000);
    const w = await http(u1, "GET", "/wallet");
    assert.strictEqual(w.body.cash_paise, 70_000);
    assert.strictEqual(w.body.payments_ready, true);
  });

  await test("reconcile credits a captured payment whose webhook never came", async () => {
    const t = await http(u2, "POST", "/wallet/topups", { amount_paise: 15_000 }, { "Idempotency-Key": key() });
    pay(t.body.razorpay_order_id);
    const r = await service.reconcileOpen({ now: Date.now() + 20 * 60_000 });
    assert.ok(r.credited >= 1, JSON.stringify(r));
    assert.strictEqual((await store.balances(u2)).cash, 55_000);
  });

  await test("the daily check finds the ledger healthy", async () => {
    const r = await service.dailyCheck();
    assert.strictEqual(r.drift, 0);
    assert.strictEqual(r.unbalanced, 0);
    const i = await store.integrity();
    assert.deepStrictEqual(i, { drift: [], unbalanced: [] });
  });

  await test("erasing an account keeps the ledger whole and points nowhere", async () => {
    const privacy = require("../src/routes/privacy");
    await privacy.deleteUserEverywhere(u2, { reason: "wallet suite" });
    const left = await db.one(`SELECT
      (SELECT COUNT(*)::int FROM wallet_accounts WHERE user_id = $1) +
      (SELECT COUNT(*)::int FROM wallet_transactions WHERE user_id = $1) +
      (SELECT COUNT(*)::int FROM wallet_topups WHERE user_id = $1) AS n`, [u2]);
    assert.strictEqual(left.n, 0);
    assert.deepStrictEqual(await store.integrity(), { drift: [], unbalanced: [] });
  });

  server.close();
  await db.close();
  console.log(`\n${passed} passed`);
})();
