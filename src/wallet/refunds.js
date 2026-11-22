/**
 * REFUNDS OF UNSPENT CASH (Phase 2) — back to the payment it came from.
 *
 * Only topped-up CASH can be refunded (never bonus), only up to what is
 * still in the wallet, and only to the original payment, through
 * Razorpay. A request is split over the user's recent top-ups, newest
 * first (Razorpay refunds a payment, not a person), each part:
 *
 *   1. ledger HOLD at once:  cash −x, sys_refunds +x   (key refund:<id>)
 *   2. Razorpay refund for x on that top-up's payment
 *   3. refund.processed → done;  refund.failed (or step 2 erroring) →
 *      the hold is REVERSED back to the wallet  (key refund-reverse:<id>)
 *
 * A refund needs a fresh PIN (step-up). Topped-up money refunded this way
 * also cancels a referral reward it earned (referrals.onTopupRefunded).
 */
const store = require("./store");
const razorpay = require("./razorpay");
const security = require("./security");
const { WalletError, rupees } = require("./service");
const { query, one, tx } = require("../db");

const DAY = 24 * 3600_000;
/** Razorpay refunds payments up to about six months old. */
const REFUND_WINDOW_MS = 180 * DAY;

/** What can go back now: { refundable_paise, parts:[{topup, amount}] }. */
async function refundable(userId, client = null, t = Date.now()) {
  const q = (sql, p) => (client ? client.query(sql, p).then((r) => r.rows) : query(sql, p));
  const cash = Number((await q(
    `SELECT balance_paise FROM wallet_accounts WHERE user_id = $1 AND kind = 'cash'`, [Number(userId)]))[0]?.balance_paise || 0);
  const topups = await q(
    `SELECT * FROM wallet_topups
      WHERE user_id = $1 AND status = 'credited' AND razorpay_payment_id IS NOT NULL
        AND credited_at > $2 AND refunded_paise < amount_paise
      ORDER BY credited_at DESC`, [Number(userId), t - REFUND_WINDOW_MS]);
  return allocate(cash, topups);
}

/** Splits a refundable total over top-ups, newest first. Pure, unit-tested. */
function allocate(cash, topups, want = Infinity) {
  let left = Math.min(Math.max(0, cash), want);
  const parts = [];
  for (const t of topups) {
    if (left <= 0) break;
    const room = Number(t.amount_paise) - Number(t.refunded_paise || 0);
    const take = Math.min(room, left);
    if (take > 0) {
      parts.push({ topup: t, amount: take });
      left -= take;
    }
  }
  return { refundable_paise: parts.reduce((s, p) => s + p.amount, 0), parts };
}

/**
 * Asks for [amountPaise] back. Needs a step-up token unless [system] (the
 * account-erase path). The same Idempotency-Key returns the first request.
 */
async function requestRefund(user, amountPaise, { stepUpToken = "", key = "", system = false, reason = "" } = {}) {
  const uid = Number(user?.sub);
  if (!system && !/^[A-Za-z0-9_-]{8,80}$/.test(String(key || ""))) {
    throw new WalletError("idempotency_key_required", "Please update the app and try again.");
  }
  if (!system && !security.stepUpValid(uid, stepUpToken)) {
    throw new WalletError("step_up_required", "Please enter your wallet PIN to request a refund.", 403);
  }
  const amount = Number(amountPaise);
  if (!Number.isSafeInteger(amount) || amount < 100) {
    throw new WalletError("amount_out_of_range", "Please enter at least ₹1.");
  }
  const reqKey = system ? `system:${Date.now()}` : String(key);

  const parts = await tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('wallet_refund'), $1)`, [uid]);
    if (!system) {
      const seen = (await c.query(`SELECT * FROM wallet_refunds WHERE user_id = $1 AND request_key = $2`, [uid, reqKey])).rows;
      if (seen.length) return { seen };
    }
    const cashAcct = await store.userAccount(c, uid, "cash");
    if (cashAcct.status !== "active" && !system) {
      throw new WalletError("wallet_frozen", "Your wallet is on hold. Please contact support.", 423);
    }
    const plan = await refundable(uid, c);
    if (amount > plan.refundable_paise) {
      throw new WalletError("exceeds_refundable",
        plan.refundable_paise > 0
          ? `You can get up to ${rupees(plan.refundable_paise)} back.`
          : "There is no money that can be refunded.", 409, { refundable_paise: plan.refundable_paise });
    }
    const { parts: chosen } = allocate(plan.refundable_paise, plan.parts.map((p) => p.topup), amount);
    const refundsAcct = await store.systemAccount(c, "sys_refunds");
    const rows = [];
    for (const p of chosen) {
      const id = store.newId();
      const t = Date.now();
      await c.query(
        `INSERT INTO wallet_refunds (id, user_id, topup_id, amount_paise, status, reason, request_key, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'requested', $5, $6, $7, $7)`,
        [id, uid, p.topup.id, p.amount, String(reason).slice(0, 200), reqKey, t]);
      const posted = await store.post(c, {
        userId: uid, type: "refund", key: `refund:${id}`, amount: p.amount,
        title: "Refund to your payment method", referenceType: "refund", referenceId: id,
        meta: { topup_id: p.topup.id, razorpay_payment_id: p.topup.razorpay_payment_id },
        legs: [{ accountId: cashAcct.id, amount: -p.amount }, { accountId: refundsAcct.id, amount: p.amount }],
      });
      await c.query(`UPDATE wallet_topups SET refunded_paise = refunded_paise + $2, updated_at = $3 WHERE id = $1`,
        [p.topup.id, p.amount, t]);
      await c.query(`UPDATE wallet_refunds SET hold_txn_id = $2 WHERE id = $1`, [id, posted.transaction.id]);
      rows.push({ id, amount: p.amount, topup: p.topup });
    }
    return { rows };
  });

  if (parts.seen) return { refunds: parts.seen.map(view), total_paise: parts.seen.reduce((s, r) => s + Number(r.amount_paise), 0) };

  for (const r of parts.rows) {
    await require("./referrals").onTopupRefunded(r.topup.id).catch((e) =>
      console.warn(`wallet: referral clawback for ${r.topup.id} failed — ${e.message}`));
    await sendToRazorpay(r.id);
  }
  require("../audit/log").record(uid, "wallet.refund.requested",
    `${rupees(amount)} refund requested to the original payment method`).catch(() => {});
  const fresh = await query(`SELECT * FROM wallet_refunds WHERE id = ANY($1::text[]) ORDER BY created_at`, [parts.rows.map((r) => r.id)]);
  return { refunds: fresh.map(view), total_paise: amount };
}

/** Step 2: asks Razorpay to refund one part; a refusal reverses the hold. */
async function sendToRazorpay(refundId) {
  const r = await one(
    `SELECT r.*, t.razorpay_payment_id FROM wallet_refunds r JOIN wallet_topups t ON t.id = r.topup_id WHERE r.id = $1`, [refundId]);
  if (!r || r.status !== "requested") return;
  try {
    const out = await razorpay.createRefund(r.razorpay_payment_id, {
      amountPaise: Number(r.amount_paise), notes: { wallet_refund_id: r.id },
    });
    const status = out?.status === "processed" ? "processed" : "processing";
    await query(`UPDATE wallet_refunds SET razorpay_refund_id = $2, status = $3, updated_at = $4
                  WHERE id = $1 AND status = 'requested'`, [r.id, out?.id || null, status, Date.now()]);
  } catch (e) {
    if (e.code === "payments_unavailable") return; // tried again by the reconcile job
    await failRefund(r.id, String(e.message || e));
  }
}

/** Step 3 (failure): the money goes back into the wallet, once. */
async function failRefund(refundId, why) {
  await tx(async (c) => {
    const r = (await c.query(`SELECT * FROM wallet_refunds WHERE id = $1 FOR UPDATE`, [refundId])).rows[0];
    if (!r || r.status === "processed" || r.status === "failed") return;
    const cash = r.user_id ? await store.userAccount(c, r.user_id, "cash") : null;
    const refundsAcct = await store.systemAccount(c, "sys_refunds");
    // An erased account has no wallet to return to: the money stays with
    // the service for support to resolve, and the developer is told.
    if (!cash) {
      await c.query(`UPDATE wallet_refunds SET status = 'failed', failure_reason = $2, updated_at = $3 WHERE id = $1`,
        [r.id, `${why} (account erased)`.slice(0, 200), Date.now()]);
      return;
    }
    const posted = await store.post(c, {
      userId: r.user_id, type: "reversal", key: `refund-reverse:${r.id}`, amount: Number(r.amount_paise),
      title: "Refund could not be completed: money returned to your wallet",
      referenceType: "refund", referenceId: r.id, reversesId: r.hold_txn_id,
      legs: [{ accountId: refundsAcct.id, amount: -Number(r.amount_paise) }, { accountId: cash.id, amount: Number(r.amount_paise) }],
    });
    await c.query(`UPDATE wallet_topups SET refunded_paise = refunded_paise - $2, updated_at = $3 WHERE id = $1`,
      [r.topup_id, Number(r.amount_paise), Date.now()]);
    await c.query(`UPDATE wallet_refunds SET status = 'failed', failure_reason = $2, reverse_txn_id = $3, updated_at = $4 WHERE id = $1`,
      [r.id, String(why).slice(0, 200), posted.transaction.id, Date.now()]);
  });
}

/** A verified refund.* webhook. Returns the result word. */
async function handleRefundEvent(event, refund) {
  if (!refund) return "ignored";
  const r = await one(
    `SELECT * FROM wallet_refunds WHERE razorpay_refund_id = $1 OR id = $2 LIMIT 1`,
    [refund.id || "", refund.notes?.wallet_refund_id || ""]);
  if (!r) return "not_wallet";
  if (event === "refund.processed") {
    await query(`UPDATE wallet_refunds SET status = 'processed', razorpay_refund_id = COALESCE(razorpay_refund_id, $2), updated_at = $3
                  WHERE id = $1 AND status IN ('requested', 'processing')`, [r.id, refund.id || null, Date.now()]);
    return "refund_processed";
  }
  if (event === "refund.failed") {
    await failRefund(r.id, "Razorpay could not complete the refund");
    return "refund_failed";
  }
  return "ignored";
}

/** Refunds still open: resend ones never sent, ask Razorpay about old ones. */
async function reconcile({ now = Date.now() } = {}) {
  const report = { resent: 0, settled: 0, failed: 0 };
  if (!razorpay.enabled()) return report;
  for (const r of await query(
    `SELECT id FROM wallet_refunds WHERE status = 'requested' AND created_at < $1 LIMIT 50`, [now - 10 * 60_000])) {
    await sendToRazorpay(r.id);
    report.resent++;
  }
  for (const r of await query(
    `SELECT id, razorpay_refund_id FROM wallet_refunds WHERE status = 'processing' AND razorpay_refund_id IS NOT NULL
        AND updated_at < $1 LIMIT 50`, [now - DAY])) {
    try {
      const rf = await razorpay.fetchRefund(r.razorpay_refund_id);
      if (rf.status === "processed") {
        await handleRefundEvent("refund.processed", rf);
        report.settled++;
      } else if (rf.status === "failed") {
        await handleRefundEvent("refund.failed", rf);
        report.failed++;
      }
    } catch (e) {
      console.warn(`wallet: refund ${r.id} check failed — ${e.message}`);
    }
  }
  return report;
}

/**
 * Before an account is erased: everything refundable goes back to its
 * payment methods (no PIN — the account owner asked to leave). Best effort;
 * whatever cannot be refunded stays in the closed ledger for support.
 */
async function refundAllOnErase(userId) {
  const plan = await refundable(userId);
  if (plan.refundable_paise <= 0 || !razorpay.enabled()) return { refunded_paise: 0 };
  await requestRefund({ sub: userId }, plan.refundable_paise, { system: true, reason: "account deleted" });
  return { refunded_paise: plan.refundable_paise };
}

function view(r) {
  return {
    refund_id: r.id, amount_paise: Number(r.amount_paise), status: r.status,
    created_at: Number(r.created_at), failure_reason: r.failure_reason || "",
  };
}

async function list(userId) {
  return (await query(`SELECT * FROM wallet_refunds WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [Number(userId)])).map(view);
}

module.exports = {
  refundable, allocate, requestRefund, sendToRazorpay, failRefund, handleRefundEvent, reconcile, refundAllOnErase, list,
};
