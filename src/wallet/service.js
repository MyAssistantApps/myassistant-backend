/**
 * WALLET TOP-UPS (Phase 1) — order → Checkout → verify → credit, once.
 *
 *   1. POST /wallet/topups            the server checks limits, creates a
 *                                     Razorpay ORDER for that amount
 *   2. (app) Razorpay Checkout        the user pays
 *   3. POST /wallet/topups/:id/verify Checkout's signature is checked, then
 *                                     the payment is FETCHED from Razorpay
 *   4. POST /payments/webhook         Razorpay's signed payment.captured /
 *                                     order.paid arrives on its own
 *
 * Steps 3 and 4 both end in creditFromPayment(), which posts ONE ledger
 * transaction keyed `topup:<payment id>`: whichever arrives second finds
 * the key taken and changes nothing. If both are lost, the reconcile job
 * asks Razorpay about every open order. The app's word is never enough:
 * money is credited only for a payment Razorpay itself says is captured,
 * for exactly the order's amount, in INR.
 */
const store = require("./store");
const razorpay = require("./razorpay");
const { query, one, tx } = require("../db");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Limits in paise, overridable per environment. */
function limits() {
  const n = (name, d) => {
    const v = Number(process.env[name]);
    return Number.isSafeInteger(v) && v > 0 ? v : d;
  };
  return {
    minTopup: n("WALLET_MIN_TOPUP_PAISE", 1_000), //        ₹10
    maxTopup: n("WALLET_MAX_TOPUP_PAISE", 1_000_000), //    ₹10,000
    daily: n("WALLET_DAILY_TOPUP_PAISE", 2_000_000), //     ₹20,000 a rolling day
    cap: n("WALLET_CAP_PAISE", 5_000_000), //               ₹50,000 held at once
  };
}

/** Human rupees for messages: 150000 → "₹1,500". */
function rupees(paise) {
  const r = Number(paise) / 100;
  return `₹${r.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

class WalletError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * Pure check of a top-up amount against the limits; null when it may go
 * ahead, else a WalletError the app shows as is.
 */
function checkTopupAmount(amount, { dailyUsed = 0, cash = 0 } = {}, l = limits()) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return new WalletError("amount_out_of_range", "Please enter a valid amount.");
  }
  if (amount < l.minTopup || amount > l.maxTopup) {
    return new WalletError("amount_out_of_range",
      `You can add between ${rupees(l.minTopup)} and ${rupees(l.maxTopup)} at a time.`);
  }
  const dailyLeft = Math.max(0, l.daily - dailyUsed);
  if (amount > dailyLeft) {
    return new WalletError("daily_limit",
      dailyLeft > 0
        ? `Daily limit reached: you can add ${rupees(dailyLeft)} more today.`
        : "Daily limit reached. You can add more money tomorrow.", 409, { daily_left_paise: dailyLeft });
  }
  const capLeft = Math.max(0, l.cap - cash);
  if (amount > capLeft) {
    return new WalletError("wallet_cap",
      capLeft > 0
        ? `Your wallet can hold up to ${rupees(l.cap)}: you can add ${rupees(capLeft)} more.`
        : `Your wallet is full (up to ${rupees(l.cap)}).`, 409, { cap_left_paise: capLeft });
  }
  return null;
}

/** What the user has added in the rolling day, counting orders still open. */
async function dailyUsed(userId, client = null, t = Date.now()) {
  const sql = `SELECT COALESCE(SUM(amount_paise), 0) AS used FROM wallet_topups
                WHERE user_id = $1
                  AND ((status = 'credited' AND credited_at > $2)
                    OR (status IN ('creating', 'created') AND created_at > $3))`;
  const params = [Number(userId), t - DAY, t - 30 * MIN];
  const r = client ? (await client.query(sql, params)).rows[0] : await one(sql, params);
  return Number(r?.used || 0);
}

/** The wallet as GET /wallet shows it. */
async function summary(userId) {
  const b = await store.balances(userId);
  const l = limits();
  const used = await dailyUsed(userId);
  return {
    cash_paise: b.cash,
    bonus_paise: b.bonus,
    status: b.status,
    currency: "INR",
    limits: {
      min_topup_paise: l.minTopup,
      max_topup_paise: l.maxTopup,
      daily_left_paise: Math.max(0, l.daily - used),
      cap_left_paise: Math.max(0, l.cap - b.cash),
    },
    payments_ready: razorpay.enabled(),
  };
}

const IDEM = /^[A-Za-z0-9_-]{8,80}$/;

function topupView(row) {
  return {
    topup_id: row.id,
    status: row.status,
    amount_paise: Number(row.amount_paise),
    currency: row.currency,
    razorpay_order_id: row.razorpay_order_id,
    method: row.method,
    credited_at: row.credited_at == null ? null : Number(row.credited_at),
  };
}

/**
 * Starts a top-up: limits, then a Razorpay order for exactly that amount.
 * The same Idempotency-Key returns the same order (a double tap, a retry
 * after a dropped connection) instead of making a second one.
 */
async function createTopup(user, amountPaise, idempotencyKey) {
  const uid = Number(user?.sub);
  if (!Number.isInteger(uid) || uid <= 0) throw new WalletError("unauthorized", "Please sign in again.", 401);
  if (!IDEM.test(String(idempotencyKey || ""))) {
    throw new WalletError("idempotency_key_required", "Please update the app and try again.");
  }
  if (!razorpay.enabled()) {
    throw new WalletError("payments_unavailable", "Adding money is not available right now. Please try again later.", 503);
  }
  const amount = Number(amountPaise);

  // One top-up decision at a time per user, so two taps on two phones
  // cannot both pass the daily limit.
  const row = await tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('wallet_topup'), $1)`, [uid]);
    const seen = (await c.query(
      `SELECT * FROM wallet_topups WHERE user_id = $1 AND idempotency_key = $2`, [uid, idempotencyKey])).rows[0];
    if (seen) {
      if (Number(seen.amount_paise) !== amount) {
        throw new WalletError("idempotency_key_reused", "Please try again.", 409);
      }
      // The first request with this key is still creating its order: a
      // second order must not be made for the same tap.
      if (seen.status === "creating") {
        throw new WalletError("topup_in_progress", "Please wait a moment.", 409);
      }
      return seen;
    }
    const cash = (await store.balances(uid)).cash;
    const bad = checkTopupAmount(amount, { dailyUsed: await dailyUsed(uid, c), cash });
    if (bad) throw bad;
    const t = Date.now();
    return (await c.query(
      `INSERT INTO wallet_topups (id, user_id, idempotency_key, amount_paise, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'creating', $5, $5) RETURNING *`,
      [store.newId(), uid, idempotencyKey, amount, t])).rows[0];
  });

  if (row.status === "creating" && !row.razorpay_order_id) {
    let order;
    try {
      order = await razorpay.createOrder({
        amountPaise: amount,
        receipt: row.id,
        notes: { purpose: "wallet_topup", topup_id: row.id, user_id: String(uid) },
      });
    } catch (e) {
      await query(`UPDATE wallet_topups SET status = 'failed', failure_reason = $2, updated_at = $3 WHERE id = $1`,
        [row.id, String(e.message || e).slice(0, 200), Date.now()]);
      throw new WalletError("payments_unavailable", "Could not start the payment. Please try again.", 503);
    }
    if (!order?.id || Number(order.amount) !== amount || order.currency !== "INR") {
      await query(`UPDATE wallet_topups SET status = 'failed', failure_reason = 'order mismatch', updated_at = $2 WHERE id = $1`,
        [row.id, Date.now()]);
      throw new WalletError("payments_unavailable", "Could not start the payment. Please try again.", 503);
    }
    const upd = await one(
      `UPDATE wallet_topups SET razorpay_order_id = $2, status = 'created', updated_at = $3
        WHERE id = $1 AND status = 'creating' RETURNING *`, [row.id, order.id, Date.now()]);
    Object.assign(row, upd || {});
  }
  if (row.status !== "created" || !row.razorpay_order_id) {
    if (row.status === "credited") return { ...topupView(row), key_id: razorpay.keyId() };
    throw new WalletError("topup_closed", "This payment can no longer be completed. Please start again.", 409);
  }
  return {
    ...topupView(row),
    key_id: razorpay.keyId(),
    test_mode: razorpay.testMode(),
    prefill: { name: user.name || "", email: user.email || "" },
  };
}

/** A user's own top-up, or a 404. */
async function getTopup(userId, topupId) {
  const row = await one(`SELECT * FROM wallet_topups WHERE id = $1 AND user_id = $2`, [String(topupId), Number(userId)]);
  if (!row) throw new WalletError("not_found", "This payment was not found.", 404);
  return row;
}

/**
 * Checkout said it succeeded. Check its signature, then ask Razorpay what
 * was paid, then credit. Returns { status, cash_paise }.
 */
async function verifyTopup(userId, topupId, { razorpay_payment_id: paymentId, razorpay_order_id: orderId, razorpay_signature: signature } = {}) {
  const row = await getTopup(userId, topupId);
  if (row.status === "credited") {
    return { status: "credited", cash_paise: (await store.balances(userId)).cash };
  }
  if (!orderId || orderId !== row.razorpay_order_id) {
    throw new WalletError("order_mismatch", "This payment does not match the order.", 409);
  }
  if (!razorpay.verifyCheckoutSignature(orderId, paymentId, signature)) {
    console.warn(`wallet: bad Checkout signature for top-up ${row.id}`);
    throw new WalletError("bad_signature", "The payment could not be verified.", 400);
  }
  let payment;
  try {
    payment = await razorpay.fetchPayment(paymentId);
  } catch (e) {
    // The webhook or the reconcile job will still credit it.
    return { status: "pending", cash_paise: (await store.balances(userId)).cash };
  }
  const r = await creditFromPayment(payment, "verify");
  const status = r.result === "credited" || r.result === "already_credited" ? "credited"
    : r.result === "failed" ? "failed" : "pending";
  return { status, cash_paise: (await store.balances(userId)).cash };
}

/**
 * THE credit step. Given a payment as Razorpay reports it (from a fetch or
 * a signed webhook), credits the top-up it belongs to — once.
 * Returns { result, topup } where result is one of:
 *   credited | already_credited | not_wallet | pending | failed |
 *   mismatch | duplicate_payment | orphan
 */
async function creditFromPayment(payment, source) {
  const orderId = payment?.order_id;
  if (!orderId) return { result: "not_wallet" };
  const out = await tx(async (c) => {
    const topup = (await c.query(
      `SELECT * FROM wallet_topups WHERE razorpay_order_id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!topup) return { result: "not_wallet" };
    const t = Date.now();

    if (topup.status === "credited") {
      if (topup.razorpay_payment_id === payment.id) return { result: "already_credited", topup };
      // A second payment on an order already paid (paid twice). Refunded
      // in Phase 2; for now it is flagged for the developer, never lost.
      return { result: "duplicate_payment", topup };
    }
    if (payment.status === "failed") {
      if (["creating", "created"].includes(topup.status)) {
        await c.query(`UPDATE wallet_topups SET status = 'failed', failure_reason = $2, updated_at = $3 WHERE id = $1`,
          [topup.id, String(payment.error_description || "payment failed").slice(0, 200), t]);
      }
      return { result: "failed", topup };
    }
    if (payment.status !== "captured") return { result: "pending", topup };

    if (Number(payment.amount) !== Number(topup.amount_paise) || payment.currency !== "INR") {
      await c.query(`UPDATE wallet_topups SET status = 'flagged', failure_reason = $2, razorpay_payment_id = $3, updated_at = $4 WHERE id = $1`,
        [topup.id, `amount ${payment.amount} ${payment.currency} vs order ${topup.amount_paise} INR`, payment.id, t]);
      return { result: "mismatch", topup };
    }
    if (!topup.user_id) {
      // The account was erased between order and payment.
      await c.query(`UPDATE wallet_topups SET status = 'flagged', failure_reason = 'account erased', razorpay_payment_id = $2, updated_at = $3 WHERE id = $1`,
        [topup.id, payment.id, t]);
      return { result: "orphan", topup };
    }

    const cash = await store.userAccount(c, topup.user_id, "cash");
    const clearing = await store.systemAccount(c, "sys_razorpay_clearing");
    const amount = Number(topup.amount_paise);
    const posted = await store.post(c, {
      userId: topup.user_id,
      type: "topup",
      key: `topup:${payment.id}`,
      amount,
      title: "Added money",
      referenceType: "topup",
      referenceId: topup.id,
      meta: { razorpay_payment_id: payment.id, razorpay_order_id: orderId, method: payment.method || "", source },
      legs: [
        { accountId: clearing.id, amount: -amount },
        { accountId: cash.id, amount },
      ],
    });
    const upd = (await c.query(
      `UPDATE wallet_topups
          SET status = 'credited', razorpay_payment_id = $2, method = $3, paid_at = $4,
              credited_at = $5, credited_txn_id = $6, updated_at = $5, payer_fingerprint = $7
        WHERE id = $1 RETURNING *`,
      [topup.id, payment.id, String(payment.method || "").slice(0, 40),
        payment.created_at ? Number(payment.created_at) * 1000 : t, t, posted.transaction.id,
        payerFingerprint(payment)])).rows[0];
    return { result: posted.duplicate ? "already_credited" : "credited", topup: upd };
  });

  if (out.result === "credited") {
    require("../audit/log").record(out.topup.user_id, "wallet.topup.credited",
      `${rupees(out.topup.amount_paise)} added to the wallet`).catch(() => {});
    // A friend's first qualifying top-up starts their referral's hold.
    await require("./referrals").onTopupCredited(out.topup).catch((e) =>
      console.warn(`wallet: referral hook for ${out.topup.id} failed — ${e.message}`));
  }
  if (["mismatch", "duplicate_payment", "orphan"].includes(out.result)) {
    alert(`Wallet top-up needs a look: ${out.result}`,
      `top-up ${out.topup?.id}, order ${orderId}, payment ${payment.id} (${payment.amount} ${payment.currency}), via ${source}`);
  }
  return out;
}

/**
 * Who paid, as a one-way hash (method + UPI id / card id / wallet / bank):
 * enough to tell that two top-ups came from the same payer, never enough
 * to recover the UPI id or card. Keyed with the server secret.
 */
function payerFingerprint(p) {
  const who = p?.vpa || p?.card_id || p?.wallet || p?.bank || "";
  if (!who) return "";
  return require("crypto").createHmac("sha256", process.env.JWT_SECRET || "wallet")
    .update(`${p.method || ""}:${String(who).toLowerCase()}`).digest("hex").slice(0, 32);
}

function alert(title, details) {
  console.error(`wallet: ${title} — ${details}`);
  require("../feedback/store").alert(title, { details: String(details).slice(0, 500), windowMs: HOUR }).catch(() => {});
}

/**
 * A VERIFIED webhook (payments/routes.js checked its signature). Each
 * delivery is recorded by Razorpay's event id; one already processed is
 * not processed again. Returns the result word stored with the event.
 */
async function handleEvent(body, eventId) {
  const event = String(body?.event || "");
  const id = String(eventId || "").slice(0, 120);
  if (!id || !event) return "ignored";
  const t = Date.now();
  const fresh = await one(
    `INSERT INTO razorpay_events (event_id, event, payload, received_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, [id, event, JSON.stringify(body), t]);
  if (!fresh) {
    const seen = await one(`SELECT processed_at FROM razorpay_events WHERE event_id = $1`, [id]);
    if (seen?.processed_at) return "duplicate";
  }
  let result = "ignored";
  try {
    if (event === "payment.captured" || event === "order.paid" || event === "payment.failed") {
      const payment = body?.payload?.payment?.entity;
      if (payment) result = (await creditFromPayment(payment, `webhook:${event}`)).result;
    } else if (event === "refund.processed" || event === "refund.failed") {
      result = await require("./refunds").handleRefundEvent(event, body?.payload?.refund?.entity);
    }
    await query(`UPDATE razorpay_events SET processed_at = $2, result = $3 WHERE event_id = $1`, [id, Date.now(), result]);
  } catch (e) {
    await query(`UPDATE razorpay_events SET result = $2 WHERE event_id = $1`, [id, `error: ${String(e.message || e).slice(0, 200)}`])
      .catch(() => {});
    throw e;
  }
  return result;
}

/**
 * THE SAFETY NET, every 10 minutes: a top-up still open 15 minutes after
 * its order was made is asked about at Razorpay — a captured payment is
 * credited (a lost webhook and a closed app cannot lose money); an order
 * nobody paid for a day expires.
 */
async function reconcileOpen({ now = Date.now(), limit = 50 } = {}) {
  const report = { checked: 0, credited: 0, expired: 0, failed: 0, errors: 0 };
  await query(
    `UPDATE wallet_topups SET status = 'failed', failure_reason = 'order was never created', updated_at = $2
      WHERE status = 'creating' AND created_at < $1`, [now - 5 * MIN, now]);
  if (!razorpay.enabled()) return report;
  const open = await query(
    `SELECT * FROM wallet_topups
      WHERE status = 'created' AND razorpay_order_id IS NOT NULL
        AND created_at < $1 AND created_at > $2
      ORDER BY created_at LIMIT $3`, [now - 15 * MIN, now - 3 * DAY, limit]);
  for (const t of open) {
    report.checked++;
    try {
      const pays = await razorpay.orderPayments(t.razorpay_order_id);
      const captured = pays.find((p) => p.status === "captured");
      if (captured) {
        const r = await creditFromPayment(captured, "reconcile");
        if (r.result === "credited") report.credited++;
        continue;
      }
      if (t.created_at < now - DAY && !pays.some((p) => p.status === "authorized")) {
        await query(`UPDATE wallet_topups SET status = 'expired', updated_at = $2 WHERE id = $1 AND status = 'created'`, [t.id, now]);
        report.expired++;
      }
    } catch (e) {
      report.errors++;
      console.warn(`wallet: reconcile ${t.id} failed — ${e.message}`);
    }
  }
  return report;
}

/**
 * THE DAILY CHECK: (1) the ledger audits itself — every balance equals its
 * entries, every transaction balances; (2) every payment Razorpay captured
 * for a wallet order in the last day was credited. Anything wrong is an
 * ops alert in the developer's inbox.
 */
async function dailyCheck({ now = Date.now() } = {}) {
  const report = { drift: 0, unbalanced: 0, missed: 0, credited: 0 };
  const { drift, unbalanced } = await store.integrity();
  report.drift = drift.length;
  report.unbalanced = unbalanced.length;
  if (drift.length || unbalanced.length) {
    alert("Wallet ledger does not add up — check before anything else",
      `drift: ${JSON.stringify(drift.slice(0, 5))}; unbalanced: ${JSON.stringify(unbalanced.slice(0, 5))}`);
  }
  if (razorpay.enabled()) {
    const from = (now - DAY - HOUR) / 1000, to = now / 1000;
    for (let skip = 0; skip < 2000; skip += 100) {
      const items = await razorpay.listPayments({ from, to, skip });
      for (const p of items) {
        if (p.status !== "captured" || p.notes?.purpose !== "wallet_topup") continue;
        const t = await one(`SELECT status, razorpay_payment_id FROM wallet_topups WHERE razorpay_order_id = $1`, [p.order_id]);
        if (t && t.status === "credited" && t.razorpay_payment_id === p.id) continue;
        report.missed++;
        const r = await creditFromPayment(p, "daily");
        if (r.result === "credited") report.credited++;
      }
      if (items.length < 100) break;
    }
    if (report.missed) {
      alert("Wallet: captured payments were not credited on time",
        `${report.missed} found by the daily check, ${report.credited} credited now`);
    }
  }
  return report;
}

module.exports = {
  limits, rupees, WalletError, checkTopupAmount, summary, createTopup, getTopup, topupView,
  verifyTopup, creditFromPayment, handleEvent, reconcileOpen, dailyCheck, dailyUsed, payerFingerprint, alert,
};
