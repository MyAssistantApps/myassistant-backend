/**
 * PAYING FROM THE WALLET (Phase 2).
 *
 * The app never says how much to take. It names WHAT it is paying for —
 * { reference_type, reference_id } — and the feature that owns that thing
 * prices it on the server through a PAYABLE registered here:
 *
 *   registerPayable("ondc_order", {
 *     resolve: async (userId, refId) => ({ amount, title }),   // or throws
 *     onPaid:  async (client, { userId, refId, txnId, amount }) => …,
 *   });
 *
 * onPaid runs inside the SAME database transaction as the ledger posting:
 * either the money moves and the order is marked paid, or neither happens.
 * Each reference can be paid once (idempotency key spend:<user>:<type>:<id>).
 *
 * Bonus is spent before cash, soonest-expiring lot first, so promotional
 * money can never turn into refundable cash.
 */
const store = require("./store");
const security = require("./security");
const { WalletError, rupees } = require("./service");
const { tx } = require("../db");

const PAYABLES = new Map();

function registerPayable(type, { resolve, onPaid }) {
  if (!/^[a-z_]{2,40}$/.test(type)) throw new Error(`wallet: bad payable type ${type}`);
  PAYABLES.set(type, { resolve, onPaid });
}

/** How a spend splits: bonus first, then cash. Pure, unit-tested. */
function split(amount, { cash, bonus }) {
  const fromBonus = Math.min(amount, Math.max(0, bonus));
  const fromCash = amount - fromBonus;
  return { fromBonus, fromCash, enough: fromCash <= Math.max(0, cash) };
}

/**
 * Pays for one thing. Returns { transaction_id, amount_paise, paid_bonus_paise,
 * paid_cash_paise, cash_paise, bonus_paise }.
 */
async function spend(user, { reference_type: type, reference_id: refIdRaw } = {}, stepUpToken = "") {
  const uid = Number(user?.sub);
  const refId = String(refIdRaw || "").slice(0, 80);
  const payable = PAYABLES.get(String(type || ""));
  if (!payable || !refId) throw new WalletError("unknown_reference", "This item cannot be paid from the wallet.", 404);

  const item = await payable.resolve(uid, refId);
  const amount = Number(item?.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new WalletError("unknown_reference", "This item cannot be paid from the wallet.", 404);
  }
  if (amount > security.stepUpThreshold() && !security.stepUpValid(uid, stepUpToken)) {
    throw new WalletError("step_up_required", `Please enter your wallet PIN to pay ${rupees(amount)}.`, 403);
  }

  // One payment per thing per person (ownership is checked by resolve()).
  const key = `spend:${uid}:${type}:${refId}`;
  const out = await tx(async (c) => {
    // Both of the user's accounts, locked, so the split is computed on the
    // balances that will actually be debited.
    const cashAcct = await store.userAccount(c, uid, "cash");
    const bonusAcct = await store.userAccount(c, uid, "bonus");
    const locked = (await c.query(
      `SELECT id, kind, balance_paise, status FROM wallet_accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [[cashAcct.id, bonusAcct.id]])).rows;
    const bal = Object.fromEntries(locked.map((r) => [r.kind, Number(r.balance_paise)]));
    if (locked.some((r) => r.status !== "active")) {
      throw new WalletError("wallet_frozen", "Your wallet is on hold. Please contact support.", 423);
    }
    const already = (await c.query(`SELECT * FROM wallet_transactions WHERE idempotency_key = $1`, [key])).rows[0];
    if (already) throw new WalletError("already_paid", "This has already been paid.", 409, { transaction_id: already.id });

    const s = split(amount, { cash: bal.cash || 0, bonus: bal.bonus || 0 });
    if (!s.enough) {
      throw new WalletError("insufficient_balance",
        `Not enough money in your wallet: ${rupees(amount)} is needed, you have ${rupees((bal.cash || 0) + (bal.bonus || 0))}.`,
        402, { needed_paise: amount - (bal.cash || 0) - (bal.bonus || 0) });
    }
    const revenue = await store.systemAccount(c, "sys_revenue");
    const legs = [{ accountId: revenue.id, amount }];
    if (s.fromBonus) legs.push({ accountId: bonusAcct.id, amount: -s.fromBonus });
    if (s.fromCash) legs.push({ accountId: cashAcct.id, amount: -s.fromCash });
    const posted = await store.post(c, {
      userId: uid, type: "spend", key, amount, title: String(item.title || "Payment").slice(0, 120),
      referenceType: type, referenceId: refId,
      meta: { paid_bonus_paise: s.fromBonus, paid_cash_paise: s.fromCash },
      legs,
    });
    if (s.fromBonus) await store.consumeBonus(c, uid, s.fromBonus);
    await payable.onPaid(c, { userId: uid, refId, txnId: posted.transaction.id, amount });
    return { txn: posted.transaction, s };
  });

  require("../audit/log").record(uid, "wallet.spent",
    `${rupees(amount)} paid from the wallet: ${String(item.title || type).slice(0, 80)}`).catch(() => {});
  const b = await store.balances(uid);
  return {
    transaction_id: out.txn.id,
    amount_paise: amount,
    paid_bonus_paise: out.s.fromBonus,
    paid_cash_paise: out.s.fromCash,
    cash_paise: b.cash,
    bonus_paise: b.bonus,
  };
}

module.exports = { registerPayable, split, spend, PAYABLES };
