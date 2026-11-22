/**
 * WALLET ADMIN (Phase 2) — behind ADMIN_KEY (X-Admin-Key), mounted at
 * /admin/wallet. Every action needs a written reason and is recorded in the
 * user's audit log; nothing here edits a ledger row — corrections are new
 * transactions (a reversal or an adjustment).
 *
 *   GET  /admin/wallet/users/:id          balances, recent transactions, top-ups, refunds, referral
 *   POST /admin/wallet/users/:id/freeze   { reason }   no spends or refunds until unfrozen
 *   POST /admin/wallet/users/:id/unfreeze { reason }
 *   POST /admin/wallet/users/:id/reset-pin { reason }
 *   POST /admin/wallet/adjust             { user_id, kind: cash|bonus, amount_paise (±), reason, key }
 *   POST /admin/wallet/reverse            { transaction_id, reason }
 *   GET  /admin/wallet/health             ledger integrity + open items
 *   POST /admin/wallet/referrals/:id/approve|reject { reason }
 */
const crypto = require("crypto");
const express = require("express");
const store = require("./store");
const { WalletError } = require("./service");
const { query, one, tx } = require("../db");
const audit = require("../audit/log");

const router = express.Router();

router.use((req, res, next) => {
  const key = process.env.ADMIN_KEY || "";
  const got = req.get("X-Admin-Key") || "";
  const ok = key.length >= 16 && got.length === key.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key));
  if (!ok) return res.status(404).json({ error: "not found" });
  next();
});
router.use(express.json());

const reasonOf = (req) => {
  const r = String(req.body?.reason || "").trim();
  if (r.length < 5) throw new WalletError("reason_required", "A reason of at least 5 characters is required.");
  return r.slice(0, 300);
};

function fail(res, e) {
  if (e instanceof WalletError) return res.status(e.status || 400).json({ error: e.code, message: e.message });
  if (e.code === "insufficient_balance") return res.status(409).json({ error: e.code, message: e.message });
  console.error("wallet admin error:", e.message || e);
  return res.status(500).json({ error: "server_error", message: e.message });
}

router.get("/users/:id", async (req, res) => {
  try {
    const uid = Number(req.params.id);
    res.json({
      balances: await store.balances(uid),
      accounts: await query(`SELECT id, kind, balance_paise, status, updated_at FROM wallet_accounts WHERE user_id = $1`, [uid]),
      transactions: (await store.history(uid, { limit: 50 })).items,
      topups: await query(`SELECT id, amount_paise, status, method, refunded_paise, razorpay_order_id, razorpay_payment_id,
                                  failure_reason, created_at, credited_at FROM wallet_topups WHERE user_id = $1
                            ORDER BY created_at DESC LIMIT 50`, [uid]),
      refunds: await query(`SELECT * FROM wallet_refunds WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [uid]),
      referral_as_friend: await one(`SELECT * FROM referrals WHERE referee_user_id = $1`, [uid]),
      referrals_made: await query(`SELECT id, status, reject_reason, created_at FROM referrals WHERE referrer_user_id = $1
                                    ORDER BY created_at DESC LIMIT 50`, [uid]),
      bonus_lots: await query(`SELECT id, amount_paise, remaining_paise, expires_at FROM wallet_bonus_lots
                                WHERE user_id = $1 AND remaining_paise > 0 ORDER BY expires_at`, [uid]),
    });
  } catch (e) {
    fail(res, e);
  }
});

for (const [path, status] of [["freeze", "frozen"], ["unfreeze", "active"]]) {
  router.post(`/users/:id/${path}`, async (req, res) => {
    try {
      const reason = reasonOf(req);
      const uid = Number(req.params.id);
      const n = await query(`UPDATE wallet_accounts SET status = $2, updated_at = $3
                              WHERE user_id = $1 AND status <> 'closed' RETURNING id`, [uid, status, Date.now()]);
      await audit.record(uid, `wallet.${path === "freeze" ? "frozen" : "unfrozen"}`, `By support: ${reason}`);
      res.json({ ok: true, accounts: n.length, status });
    } catch (e) {
      fail(res, e);
    }
  });
}

router.post("/users/:id/reset-pin", async (req, res) => {
  try {
    const reason = reasonOf(req);
    const uid = Number(req.params.id);
    await query(`DELETE FROM wallet_pins WHERE user_id = $1`, [uid]);
    await audit.record(uid, "wallet.pin.reset", `By support: ${reason}`);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

/** A goodwill credit or a correction: + adds to the user, − takes away. */
router.post("/adjust", async (req, res) => {
  try {
    const reason = reasonOf(req);
    const uid = Number(req.body?.user_id);
    const kind = req.body?.kind === "bonus" ? "bonus" : "cash";
    const amount = Number(req.body?.amount_paise);
    const key = String(req.body?.key || "");
    if (!Number.isInteger(uid) || uid <= 0) throw new WalletError("bad_user", "user_id is required.");
    if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 10_000_000) {
      throw new WalletError("bad_amount", "amount_paise must be a non-zero whole number (at most ₹1,00,000).");
    }
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new WalletError("key_required", "A unique key (8–80 characters) is required.");
    const out = await tx(async (c) => {
      const acct = await store.userAccount(c, uid, kind);
      const sys = await store.systemAccount(c, "sys_adjustments");
      const posted = await store.post(c, {
        userId: uid, type: "adjustment", key: `admin-adjust:${key}`, amount: Math.abs(amount),
        title: amount > 0 ? "Credit from support" : "Correction by support",
        referenceType: "admin", referenceId: key, meta: { reason, kind },
        legs: [{ accountId: acct.id, amount }, { accountId: sys.id, amount: -amount }],
      });
      if (!posted.duplicate && kind === "bonus") {
        if (amount > 0) {
          const days = require("./referrals").settings().bonusExpiryDays;
          await store.addBonusLot(c, { userId: uid, txnId: posted.transaction.id, amount, expiresAt: Date.now() + days * 86_400_000 });
        } else {
          await store.consumeBonus(c, uid, -amount);
        }
      }
      return posted;
    });
    await audit.record(uid, "wallet.adjusted", `${amount > 0 ? "Credit" : "Correction"} of ₹${Math.abs(amount) / 100} by support: ${reason}`);
    res.json({ ok: true, transaction_id: out.transaction.id, duplicate: out.duplicate });
  } catch (e) {
    fail(res, e);
  }
});

/**
 * Reverses a transaction: the exact opposite entries, as a new transaction
 * pointing back at it. Top-ups are reversed through a refund instead (the
 * money must go back to the payer), and bonus spends cannot be reversed
 * here (the bonus lots are gone) — use an adjustment.
 */
router.post("/reverse", async (req, res) => {
  try {
    const reason = reasonOf(req);
    const id = String(req.body?.transaction_id || "");
    const out = await tx(async (c) => {
      const t = (await c.query(`SELECT * FROM wallet_transactions WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!t) throw new WalletError("not_found", "No such transaction.", 404);
      if (t.status === "reversed") throw new WalletError("already_reversed", "Already reversed.", 409);
      if (t.type === "topup" || t.type === "refund" || t.type === "reversal") {
        throw new WalletError("not_reversible", `A ${t.type} cannot be reversed here.`, 409);
      }
      const entries = (await c.query(
        `SELECT e.account_id, e.amount_paise, a.kind FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
          WHERE e.transaction_id = $1`, [id])).rows;
      if (entries.some((e) => e.kind === "bonus")) {
        throw new WalletError("not_reversible", "Bonus movements are corrected with an adjustment.", 409);
      }
      const posted = await store.post(c, {
        userId: t.user_id, type: "reversal", key: `reverse:${id}`, amount: Number(t.amount_paise),
        title: `Reversed: ${t.title || t.type}`, referenceType: t.reference_type, referenceId: t.reference_id,
        reversesId: id, meta: { reason },
        legs: entries.map((e) => ({ accountId: e.account_id, amount: -Number(e.amount_paise) })),
      });
      await c.query(`UPDATE wallet_transactions SET status = 'reversed' WHERE id = $1`, [id]);
      return { posted, userId: t.user_id };
    });
    if (out.userId) await audit.record(out.userId, "wallet.reversed", `A wallet transaction was reversed by support: ${reason}`);
    res.json({ ok: true, transaction_id: out.posted.transaction.id });
  } catch (e) {
    fail(res, e);
  }
});

router.get("/health", async (_req, res) => {
  try {
    const i = await store.integrity();
    res.json({
      drift: i.drift,
      unbalanced: i.unbalanced,
      bonus_lot_drift: await store.lotDrift(),
      open_topups: (await one(`SELECT COUNT(*)::int AS n FROM wallet_topups WHERE status IN ('creating', 'created')`)).n,
      flagged_topups: await query(`SELECT id, user_id, amount_paise, failure_reason, created_at FROM wallet_topups
                                    WHERE status = 'flagged' ORDER BY created_at DESC LIMIT 50`),
      open_refunds: (await one(`SELECT COUNT(*)::int AS n FROM wallet_refunds WHERE status IN ('requested', 'processing')`)).n,
      referrals_in_review: await query(`SELECT id, referrer_user_id, referee_user_id, code, reject_reason, created_at
                                         FROM referrals WHERE status = 'review' ORDER BY created_at LIMIT 50`),
      system_accounts: await query(`SELECT kind, balance_paise FROM wallet_accounts WHERE user_id IS NULL AND kind LIKE 'sys\\_%'`),
    });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/referrals/:id/:verdict(approve|reject)", async (req, res) => {
  try {
    const reason = reasonOf(req);
    const approve = req.params.verdict === "approve";
    const r = await one(
      `UPDATE referrals SET status = $2, reject_reason = $3, updated_at = $4
        WHERE id = $1 AND status IN ('review', 'held', 'signed_up') RETURNING *`,
      // Approving a referral under review puts it back on the normal path:
      // it still needs the friend's qualifying top-up and the hold.
      [Number(req.params.id), approve ? "signed_up" : "rejected", approve ? "" : `support: ${reason}`, Date.now()]);
    if (!r) throw new WalletError("not_found", "No referral in a state that can be changed.", 404);
    if (approve && r.referee_user_id) {
      const t = await one(`SELECT * FROM wallet_topups WHERE user_id = $1 AND status = 'credited' ORDER BY credited_at LIMIT 1`, [r.referee_user_id]);
      if (t) await require("./referrals").onTopupCredited(t);
    }
    res.json({ ok: true, status: approve ? "signed_up" : "rejected" });
  } catch (e) {
    fail(res, e);
  }
});

module.exports = router;
