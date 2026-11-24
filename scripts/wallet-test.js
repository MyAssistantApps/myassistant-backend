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
process.env.WALLET_ENABLED = "1";
process.env.JWT_SECRET = process.env.JWT_SECRET || "wallet_suite_jwt_secret_long_enough";

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

  await test("spend splits bonus first, then cash", () => {
    const { split } = require("../src/wallet/spend");
    assert.deepStrictEqual(split(5000, { cash: 10000, bonus: 2000 }), { fromBonus: 2000, fromCash: 3000, enough: true });
    assert.deepStrictEqual(split(5000, { cash: 1000, bonus: 2000 }), { fromBonus: 2000, fromCash: 3000, enough: false });
    assert.deepStrictEqual(split(1500, { cash: 0, bonus: 2000 }), { fromBonus: 1500, fromCash: 0, enough: true });
  });

  await test("refunds go to the newest top-ups first, never above cash", () => {
    const { allocate } = require("../src/wallet/refunds");
    const tops = [{ id: "b", amount_paise: 5000, refunded_paise: 1000 }, { id: "a", amount_paise: 10000, refunded_paise: 0 }];
    let r = allocate(20000, tops);
    assert.strictEqual(r.refundable_paise, 14000);
    assert.deepStrictEqual(r.parts.map((x) => [x.topup.id, x.amount]), [["b", 4000], ["a", 10000]]);
    r = allocate(6000, tops);
    assert.deepStrictEqual(r.parts.map((x) => [x.topup.id, x.amount]), [["b", 4000], ["a", 2000]]);
    r = allocate(20000, tops, 3000);
    assert.deepStrictEqual(r.parts.map((x) => [x.topup.id, x.amount]), [["b", 3000]]);
  });

  await test("PIN rules: 4–6 digits, not repeated, not a run", () => {
    const sec = require("../src/wallet/security");
    assert.strictEqual(sec.pinProblem("4829"), null);
    assert.strictEqual(sec.pinProblem("905172"), null);
    assert.ok(sec.pinProblem("123"));
    assert.ok(sec.pinProblem("1111"));
    assert.ok(sec.pinProblem("1234"));
    assert.ok(sec.pinProblem("98765"));
    assert.ok(sec.pinProblem("12a4"));
    const h = sec.hashPin("4829");
    assert.ok(sec.pinMatches("4829", h));
    assert.ok(!sec.pinMatches("4830", h));
    assert.notStrictEqual(sec.hashPin("4829"), h, "salted");
  });

  await test("referral helpers: codes, one mailbox, initials, device hash", () => {
    const r = require("../src/wallet/referrals");
    for (let i = 0; i < 50; i++) assert.ok(r.normalizeCode(r.newCode()));
    assert.strictEqual(r.normalizeCode(" ab3d-ef7h "), "AB3DEF7H");
    assert.strictEqual(r.normalizeCode("ABCD0FGH"), null); // 0 is not in the alphabet
    assert.strictEqual(r.normalizeCode("x"), null);
    assert.strictEqual(r.emailKey("A.Sha+promo@Gmail.com"), "asha@gmail.com");
    assert.strictEqual(r.emailKey("ravi+x@example.in"), "ravi@example.in");
    assert.strictEqual(r.initials("Asha Rao"), "A.R.");
    assert.strictEqual(r.initials(""), "A friend");
    assert.strictEqual(r.deviceHash("short"), "");
    assert.strictEqual(r.deviceHash("install-1234567890"), r.deviceHash("install-1234567890"));
    assert.notStrictEqual(r.deviceHash("install-1234567890"), r.deviceHash("install-1234567891"));
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
  const fake = { orders: new Map(), payments: new Map(), refunds: new Map(), n: 0, down: false, refundFail: false };
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
    if (opts.method === "POST" && (m = p.match(/^\/payments\/(pay_\w+)\/refund$/))) {
      if (fake.refundFail) return respond(400, { error: { description: "refund not allowed" } });
      const b = JSON.parse(opts.body);
      const id = `rfnd_T${run}${++fake.n}`;
      const rf = { id, payment_id: m[1], amount: b.amount, status: "processing", notes: b.notes };
      fake.refunds.set(id, rf);
      return respond(200, rf);
    }
    if ((m = p.match(/^\/refunds\/(rfnd_\w+)$/))) {
      const rf = fake.refunds.get(m[1]);
      return rf ? respond(200, rf) : respond(400, { error: { description: "not found" } });
    }
    return respond(404, { error: { description: "no route" } });
  });
  const pay = (orderId, { amount, status = "captured", currency = "INR", vpa } = {}) => {
    const o = fake.orders.get(orderId);
    const id = `pay_T${run}${++fake.n}`;
    const p = { id, order_id: orderId, amount: amount ?? o.amount, currency, status, method: "upi",
      vpa: vpa || `payer${run}${fake.n}@upi`, notes: o.notes, created_at: Math.floor(Date.now() / 1000) };
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
  app.use("/referrals", require("../src/wallet/referrals").router);
  process.env.ADMIN_KEY = "wallet-suite-admin-key-0123456789";
  app.use("/admin/wallet", require("../src/wallet/admin"));
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

  /* ------------------------- Phase 2 ------------------------- */
  const admin = (method, path, body) => http(0, method, `/admin/wallet${path}`, body, { "X-Admin-Key": process.env.ADMIN_KEY });
  const topUp = async (uid, amount, opts = {}) => {
    const t = await http(uid, "POST", "/wallet/topups", { amount_paise: amount }, { "Idempotency-Key": key() });
    assert.strictEqual(t.status, 201, JSON.stringify(t.body));
    const p = pay(t.body.razorpay_order_id, opts);
    const r = await service.handleEvent({ event: "payment.captured", payload: { payment: { entity: p } } }, `evt_${p.id}`);
    assert.strictEqual(r, "credited");
    return { topup: t.body, payment: p };
  };
  const spendLib = require("../src/wallet/spend");
  const paidItems = new Map();
  spendLib.registerPayable("test_item", {
    async resolve(_uid, refId) {
      const price = Number(String(refId).split("-")[1]);
      if (!price) throw new service.WalletError("unknown_reference", "no such item", 404);
      return { amount: price, title: `Test item ${refId}` };
    },
    async onPaid(_c, { refId, txnId }) {
      if (refId.startsWith("boom")) throw new Error("the item could not be delivered");
      paidItems.set(refId, txnId);
    },
  });

  await test("the staged launch: off → hidden and refused; a list → only those accounts", async () => {
    process.env.WALLET_ENABLED = "0";
    let r = await http(u1, "GET", "/wallet");
    assert.deepStrictEqual(r.body, { available: false });
    r = await http(u1, "POST", "/wallet/topups", { amount_paise: 10_000 }, { "Idempotency-Key": key() });
    assert.strictEqual(r.status, 403);
    process.env.WALLET_ENABLED = "1";
    process.env.WALLET_ALLOW_USERS = String(u1);
    assert.strictEqual((await http(u1, "GET", "/wallet")).body.available, true);
    assert.strictEqual((await http(u3x(), "GET", "/wallet")).body.available, false);
    delete process.env.WALLET_ALLOW_USERS;
  });
  function u3x() { return 987654321; }

  const u4 = await mkUser("four");
  let stepUp;
  await test("PIN: weak ones refused; changing needs the old one; 5 wrong tries lock it", async () => {
    let r = await http(u4, "POST", "/wallet/pin", { pin: "1234" });
    assert.strictEqual(r.status, 400);
    r = await http(u4, "POST", "/wallet/pin", { pin: "4829" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await http(u4, "GET", "/wallet")).body.has_pin, true);
    r = await http(u4, "POST", "/wallet/pin", { pin: "7351" });
    assert.strictEqual(r.status, 400, "a stolen session cannot replace the PIN");
    r = await http(u4, "POST", "/wallet/pin", { pin: "7351", current_pin: "4829" });
    assert.strictEqual(r.status, 200);
    for (let i = 0; i < 4; i++) assert.strictEqual((await http(u4, "POST", "/wallet/step-up", { pin: "0000" })).status, 401);
    r = await http(u4, "POST", "/wallet/step-up", { pin: "0000" });
    assert.strictEqual(r.status, 429);
    r = await http(u4, "POST", "/wallet/step-up", { pin: "7351" });
    assert.strictEqual(r.status, 429, "locked even for the right PIN");
    await db.query(`UPDATE wallet_pins SET locked_until = 0, failed = 0 WHERE user_id = $1`, [u4]);
    r = await http(u4, "POST", "/wallet/step-up", { pin: "7351" });
    assert.strictEqual(r.status, 200);
    stepUp = r.body.step_up_token;
    const sec = require("../src/wallet/security");
    assert.ok(sec.stepUpValid(u4, stepUp));
    assert.ok(!sec.stepUpValid(u1, stepUp), "another user's token is useless");
  });

  await test("spend: priced on the server, paid once, all-or-nothing with the item", async () => {
    await topUp(u4, 100_000);
    let r = await http(u4, "POST", "/wallet/spend", { reference_type: "test_item", reference_id: `a${run}-30000` });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.amount_paise, 30_000);
    assert.strictEqual(r.body.cash_paise, 70_000);
    assert.ok(paidItems.has(`a${run}-30000`));
    r = await http(u4, "POST", "/wallet/spend", { reference_type: "test_item", reference_id: `a${run}-30000` });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, "already_paid");
    r = await http(u4, "POST", "/wallet/spend", { reference_type: "test_item", reference_id: `boom${run}-1000` });
    assert.strictEqual(r.status, 500);
    assert.strictEqual((await store.balances(u4)).cash, 70_000, "the failed item took no money");
    r = await http(u4, "POST", "/wallet/spend", { reference_type: "nope", reference_id: "x" });
    assert.strictEqual(r.status, 404);
    r = await http(u4, "POST", "/wallet/spend", { reference_type: "test_item", reference_id: `b${run}-90000` });
    assert.strictEqual(r.status, 402);
  });

  await test("a large spend needs the PIN step-up", async () => {
    let r = await http(u4, "POST", "/wallet/spend", { reference_type: "test_item", reference_id: `big${run}-250000` });
    assert.strictEqual(r.status, 403);
    await topUp(u4, 200_000);
    r = await http(u4, "POST", "/wallet/spend", { reference_type: "test_item", reference_id: `big${run}-250000` },
      { "X-Wallet-Step-Up": stepUp });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.cash_paise, 20_000);
  });

  await test("two phones spending at once never overdraw", async () => {
    const rs = await Promise.all([1, 2, 3, 4, 5].map((i) =>
      http(u4, "POST", "/wallet/spend", { reference_type: "test_item", reference_id: `race${run}${i}-8000` })));
    assert.strictEqual(rs.filter((r) => r.status === 200).length, 2, JSON.stringify(rs.map((r) => r.body.error)));
    assert.strictEqual((await store.balances(u4)).cash, 4_000);
  });

  await test("bonus (from support) is spent before cash, and its lots follow", async () => {
    let r = await admin("POST", "/adjust", { user_id: u4, kind: "bonus", amount_paise: 3_000, reason: "goodwill test", key: key() });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await http(u4, "POST", "/wallet/spend", { reference_type: "test_item", reference_id: `mix${run}-5000` });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.paid_bonus_paise, 3_000);
    assert.strictEqual(r.body.paid_cash_paise, 2_000);
    assert.deepStrictEqual(await store.lotDrift(), []);
  });

  await test("admin: a wrong key is a 404; freeze stops spending; reverse returns the money", async () => {
    assert.strictEqual((await http(0, "GET", "/admin/wallet/health", null, { "X-Admin-Key": "wrong-key-wrong-key-123" })).status, 404);
    let r = await admin("POST", `/users/${u4}/freeze`, { reason: "suspicious test" });
    assert.strictEqual(r.status, 200);
    r = await http(u4, "POST", "/wallet/spend", { reference_type: "test_item", reference_id: `frz${run}-100` });
    assert.strictEqual(r.status, 423);
    await admin("POST", `/users/${u4}/unfreeze`, { reason: "checked, fine" });
    const spentTxn = paidItems.get(`a${run}-30000`);
    r = await admin("POST", "/reverse", { transaction_id: spentTxn, reason: "order never arrived" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await store.balances(u4)).cash, 32_000);
    r = await admin("POST", "/reverse", { transaction_id: spentTxn, reason: "again" });
    assert.strictEqual(r.status, 409);
    r = await admin("POST", "/adjust", { user_id: u4, kind: "cash", amount_paise: 100, reason: "x", key: key() });
    assert.strictEqual(r.status, 400, "a reason is required");
    const h = await admin("GET", "/health");
    assert.deepStrictEqual(h.body.drift, []);
    assert.deepStrictEqual(h.body.unbalanced, []);
  });

  await test("refunds: PIN needed; held at once; processed by webhook; a refused one comes back", async () => {
    const before = (await store.balances(u4)).cash;
    let r = await http(u4, "POST", "/wallet/refunds", { amount_paise: 5_000 }, { "Idempotency-Key": key() });
    assert.strictEqual(r.status, 403);
    const k = key();
    r = await http(u4, "POST", "/wallet/refunds", { amount_paise: 5_000 }, { "Idempotency-Key": k, "X-Wallet-Step-Up": stepUp });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.refunds[0].status, "processing");
    assert.strictEqual((await store.balances(u4)).cash, before - 5_000);
    const again = await http(u4, "POST", "/wallet/refunds", { amount_paise: 5_000 }, { "Idempotency-Key": k, "X-Wallet-Step-Up": stepUp });
    assert.strictEqual(again.body.refunds[0].refund_id, r.body.refunds[0].refund_id, "same key, same refund");
    assert.strictEqual((await store.balances(u4)).cash, before - 5_000);
    const rfRow = await db.one(`SELECT razorpay_refund_id FROM wallet_refunds WHERE id = $1`, [r.body.refunds[0].refund_id]);
    const w = await service.handleEvent({ event: "refund.processed", payload: { refund: { entity: { id: rfRow.razorpay_refund_id, status: "processed" } } } }, `evt_${rfRow.razorpay_refund_id}`);
    assert.strictEqual(w, "refund_processed");
    fake.refundFail = true;
    r = await http(u4, "POST", "/wallet/refunds", { amount_paise: 2_000 }, { "Idempotency-Key": key(), "X-Wallet-Step-Up": stepUp });
    fake.refundFail = false;
    assert.strictEqual(r.body.refunds[0].status, "failed");
    assert.strictEqual((await store.balances(u4)).cash, before - 5_000, "the refused refund went back to the wallet");
    r = await http(u4, "POST", "/wallet/refunds", { amount_paise: 99_999_999 }, { "Idempotency-Key": key(), "X-Wallet-Step-Up": stepUp });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, "exceeds_refundable");
    assert.deepStrictEqual(await store.integrity(), { drift: [], unbalanced: [] });
  });

  await test("a refund.failed webhook returns a processing refund to the wallet", async () => {
    const before = (await store.balances(u4)).cash;
    const r = await http(u4, "POST", "/wallet/refunds", { amount_paise: 1_000 }, { "Idempotency-Key": key(), "X-Wallet-Step-Up": stepUp });
    const row = await db.one(`SELECT razorpay_refund_id FROM wallet_refunds WHERE id = $1`, [r.body.refunds[0].refund_id]);
    assert.strictEqual((await store.balances(u4)).cash, before - 1_000);
    const w = await service.handleEvent({ event: "refund.failed", payload: { refund: { entity: { id: row.razorpay_refund_id } } } }, `evt_f_${row.razorpay_refund_id}`);
    assert.strictEqual(w, "refund_failed");
    assert.strictEqual((await store.balances(u4)).cash, before);
  });

  await test("an ONDC order is a wallet payable; an unknown one is refused", async () => {
    require("../src/routes/shop");
    const r = await http(u4, "POST", "/wallet/spend", { reference_type: "ondc_order", reference_id: "999999999" });
    assert.strictEqual(r.status, 404);
  });

  /* ------------------------- Phase 3 ------------------------- */
  const ref = require("../src/wallet/referrals");
  const u5 = await mkUser("five");
  const u6 = await mkUser("six");
  let code1;
  await test("each user gets one code and a share link", async () => {
    const a = await http(u1, "GET", "/referrals/me");
    const b = await http(u1, "GET", "/referrals/me");
    assert.ok(ref.normalizeCode(a.body.code));
    assert.strictEqual(a.body.code, b.body.code);
    assert.match(a.body.share_url, /\/r\/[A-Z2-9]{8}$/);
    code1 = a.body.code;
  });

  await test("applying: bad code generic; own code refused; once only", async () => {
    let r = await http(u5, "POST", "/referrals/apply", { code: "ZZZZZZZZ" });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.message, "This code cannot be used.");
    r = await http(u1, "POST", "/referrals/apply", { code: code1 });
    assert.strictEqual(r.status, 409);
    r = await http(u5, "POST", "/referrals/apply", { code: code1 }, { "X-Device-Id": `device-five-${run}` });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await http(u5, "POST", "/referrals/apply", { code: code1 });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, "already_referred");
  });

  await test("the same phone install cannot be referred twice", async () => {
    const r = await http(u6, "POST", "/referrals/apply", { code: code1 }, { "X-Device-Id": `device-five-${run}` });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, "not_eligible");
  });

  await test("qualify → 7-day hold → wait for a verified phone → rewarded, both sides", async () => {
    const { topup } = await topUp(u5, 10_000);
    let row = await db.one(`SELECT * FROM referrals WHERE referee_user_id = $1`, [u5]);
    assert.strictEqual(row.status, "held");
    assert.strictEqual(row.qualifying_topup_id, topup.topup_id);
    let p = await ref.payout();
    assert.strictEqual(p.rewarded, 0, "nothing before the hold ends");
    const later = Date.now() + 8 * 86_400_000;
    p = await ref.payout({ now: later });
    assert.strictEqual(p.waiting, 1, "the friend's phone is not verified yet");
    await db.query(`UPDATE users SET phone_verified_at = $2 WHERE id = $1`, [u5, Date.now()]);
    p = await ref.payout({ now: later });
    assert.strictEqual(p.rewarded, 1);
    assert.strictEqual((await store.balances(u5)).bonus, 2_500);
    assert.strictEqual((await store.balances(u1)).bonus, 5_000);
    row = await db.one(`SELECT * FROM referrals WHERE referee_user_id = $1`, [u5]);
    assert.strictEqual(row.status, "rewarded");
    p = await ref.payout({ now: later });
    assert.strictEqual(p.rewarded, 0, "paid once");
    const h = await http(u1, "GET", "/referrals/history");
    const rewarded = h.body.items.find((x) => x.status === "rewarded");
    assert.strictEqual(rewarded.friend, "W.F.");
    assert.strictEqual(rewarded.reward_paise, 5_000);
    assert.ok(h.body.items.every((x) => !("name" in x) && !("email" in x)), "no names or contacts");
    assert.deepStrictEqual(await store.lotDrift(), []);
  });

  await test("paying with the referrer's own UPI id is caught at payout", async () => {
    const u7 = await mkUser("seven");
    await http(u7, "POST", "/referrals/apply", { code: code1 }, { "X-Device-Id": `device-seven-${run}` });
    const mine = await topUp(u1, 10_000, { vpa: `shared${run}@upi` });
    assert.ok(mine);
    await topUp(u7, 10_000, { vpa: `shared${run}@upi` });
    await db.query(`UPDATE users SET phone_verified_at = $2 WHERE id = $1`, [u7, Date.now()]);
    await ref.payout({ now: Date.now() + 8 * 86_400_000 });
    const row = await db.one(`SELECT status, reject_reason FROM referrals WHERE referee_user_id = $1`, [u7]);
    assert.strictEqual(row.status, "rejected");
    assert.match(row.reject_reason, /same payment method/);
  });

  await test("refunding the qualifying top-up takes the friend's bonus back", async () => {
    const r = await http(u5, "POST", "/wallet/pin", { pin: "5820" });
    assert.strictEqual(r.status, 200);
    const su = (await http(u5, "POST", "/wallet/step-up", { pin: "5820" })).body.step_up_token;
    const rf = await http(u5, "POST", "/wallet/refunds", { amount_paise: 10_000 }, { "Idempotency-Key": key(), "X-Wallet-Step-Up": su });
    assert.strictEqual(rf.status, 201, JSON.stringify(rf.body));
    assert.strictEqual((await store.balances(u5)).bonus, 0);
    const row = await db.one(`SELECT status FROM referrals WHERE referee_user_id = $1`, [u5]);
    assert.strictEqual(row.status, "clawed_back");
    assert.deepStrictEqual(await store.integrity(), { drift: [], unbalanced: [] });
  });

  await test("bonus expires after its days, and only what is left", async () => {
    // The clawback above took the referrer's bonus back too: give some now.
    await admin("POST", "/adjust", { user_id: u1, kind: "bonus", amount_paise: 1_500, reason: "expiry test", key: key() });
    const before = (await store.balances(u1)).bonus;
    assert.ok(before > 0);
    const r = await ref.expireBonuses({ now: Date.now() + 91 * 86_400_000 });
    assert.ok(r.expired >= 1);
    assert.strictEqual((await store.balances(u1)).bonus, 0);
    assert.deepStrictEqual(await store.lotDrift(), []);
  });

  await test("the share link always lands on the Play Store, carrying only a well-formed code", async () => {
    const pr = express();
    pr.use("/r", ref.publicRouter);
    const s2 = await new Promise((res) => { const s = pr.listen(0, () => res(s)); });
    const at = (c) => fetch(`http://127.0.0.1:${s2.address().port}/r/${c}`, { redirect: "manual" });
    let r = await at(code1);
    assert.strictEqual(r.status, 302);
    assert.match(r.headers.get("location"), new RegExp(`referrer=code%3D${code1}$`));
    r = await at("notacode");
    assert.strictEqual(r.status, 302);
    assert.ok(!r.headers.get("location").includes("referrer"));
    s2.close();
  });

  await test("erasing an account refunds its cash first and keeps every ledger whole", async () => {
    const privacy = require("../src/routes/privacy");
    const cashBefore = (await store.balances(u4)).cash;
    assert.ok(cashBefore > 0);
    await privacy.deleteUserEverywhere(u4, { reason: "wallet suite" });
    const refunds = await db.query(`SELECT r.amount_paise FROM wallet_refunds r JOIN wallet_topups t ON t.id = r.topup_id
      WHERE r.reason = 'account deleted' AND r.user_id IS NULL`);
    assert.ok(refunds.length >= 1, "a refund was requested before the account closed");
    const left = await db.one(`SELECT COUNT(*)::int AS n FROM wallet_accounts WHERE user_id = $1`, [u4]);
    assert.strictEqual(left.n, 0);
    assert.deepStrictEqual(await store.integrity(), { drift: [], unbalanced: [] });
  });

  server.close();
  await db.close();
  console.log(`\n${passed} passed`);
})();
