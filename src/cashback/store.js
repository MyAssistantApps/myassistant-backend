/**
 * ─────────────────────────────────────────────────────────────────────────
 *  CASHBACK — THE LEDGER (owner, 2026-11-27: "the commission which we earn,
 *  we want to give that back to the user as a cashback").
 *
 *  How money reaches a user, end to end:
 *
 *   1. The user opens a partner from the app. GET /go/:id records the click
 *      with a CLICK ID and puts that id on the affiliate link as its sub-id
 *      (affiliate/merchants.js). The click id is how a purchase reported
 *      weeks later is matched back to the person who made it.
 *   2. The affiliate network reports the purchase to
 *      /cashback/:network/hook/:secret (routes.js) with the sub-id, its own
 *      transaction id, the order value and OUR commission. It becomes one
 *      row in cashback_txns: `pending`.
 *   3. The network later validates it (the return window passed) or cancels
 *      it (returned, refused): the same transaction id arrives again and
 *      the row becomes `confirmed` or `rejected`.
 *   4. Confirmed cashback is the user's AVAILABLE balance. They ask for it
 *      to be paid to their UPI ID (cashback_payouts, `requested`); the
 *      owner pays it and marks it `paid`, or rejects it with a reason.
 *
 *  MONEY IS IN PAISE, as integers, everywhere. Rupees are for people.
 *
 *  A row is never deleted to undo it: a cancelled purchase is `rejected`,
 *  a refused payout is `rejected`. The balance is always a sum over rows,
 *  never a number kept on the side that could drift from them.
 *
 *  Privacy: cashback_txns is in USER_TABLES (routes/privacy.js) — erased
 *  with the account, unpaid cashback included. cashback_payouts is a record
 *  of money paid and is kept for accounting, like `payments` (NOT_PERSONAL).
 * ─────────────────────────────────────────────────────────────────────────
 */
const crypto = require("crypto");
const { query, one, run, tx } = require("../db");

const TXN_STATUSES = new Set(["pending", "confirmed", "rejected"]);
const PAYOUT_STATUSES = new Set(["requested", "paid", "rejected"]);

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = (async () => {
      // The click table is routes/go.js's; the click id is added to it.
      await require("../routes/go").migrate();
      await run(`
        ALTER TABLE affiliate_clicks ADD COLUMN IF NOT EXISTS click_id TEXT;
        ALTER TABLE affiliate_clicks ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT '';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_affclick_click ON affiliate_clicks(click_id) WHERE click_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_affclick_user ON affiliate_clicks(user_id, id DESC);

        CREATE TABLE IF NOT EXISTS cashback_txns (
          id               BIGSERIAL PRIMARY KEY,
          user_id          INTEGER,
          click_id         TEXT NOT NULL DEFAULT '',
          merchant         TEXT NOT NULL DEFAULT '',
          network          TEXT NOT NULL,
          network_txn_id   TEXT NOT NULL,
          sale_paise       BIGINT NOT NULL DEFAULT 0,
          commission_paise BIGINT NOT NULL DEFAULT 0,
          share_pct        INTEGER NOT NULL DEFAULT 100,
          cashback_paise   BIGINT NOT NULL DEFAULT 0,
          status           TEXT NOT NULL DEFAULT 'pending',
          review           INTEGER NOT NULL DEFAULT 0,
          note             TEXT NOT NULL DEFAULT '',
          occurred_at      BIGINT NOT NULL,
          confirmed_at     BIGINT NOT NULL DEFAULT 0,
          created_at       BIGINT NOT NULL,
          updated_at       BIGINT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cb_txn_net ON cashback_txns(network, network_txn_id);
        CREATE INDEX IF NOT EXISTS idx_cb_txn_user ON cashback_txns(user_id, id DESC);

        CREATE TABLE IF NOT EXISTS cashback_payouts (
          id           BIGSERIAL PRIMARY KEY,
          user_id      INTEGER NOT NULL,
          amount_paise BIGINT NOT NULL,
          upi_id       TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'requested',
          reference    TEXT NOT NULL DEFAULT '',
          note         TEXT NOT NULL DEFAULT '',
          requested_at BIGINT NOT NULL,
          decided_at   BIGINT NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_cb_payout_user ON cashback_payouts(user_id, id DESC);
        -- One open request per person: a second tap is not a second payout.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cb_payout_open ON cashback_payouts(user_id) WHERE status = 'requested';

        CREATE TABLE IF NOT EXISTS cashback_rules (
          merchant   TEXT PRIMARY KEY,
          enabled    INTEGER NOT NULL DEFAULT 1,
          rate_text  TEXT NOT NULL DEFAULT '',
          share_pct  INTEGER,
          updated_at BIGINT NOT NULL
        );
      `);
    })().catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

/* ------------------------------------------------------------------ *
 * Clicks
 * ------------------------------------------------------------------ */

/** 20 hex characters: unguessable, and short enough for any sub-id field. */
function newClickId() {
  return crypto.randomBytes(10).toString("hex");
}

async function recordClick({ userId, merchant, tracked, network = "", clickId = null }) {
  await migrate();
  await run(
    `INSERT INTO affiliate_clicks (user_id, merchant, tracked, created_at, click_id, network)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId || null, merchant, Boolean(tracked), Date.now(), clickId, network]);
}

async function clickById(clickId) {
  await migrate();
  if (!clickId) return null;
  return one("SELECT * FROM affiliate_clicks WHERE click_id = $1", [String(clickId)]);
}

/* ------------------------------------------------------------------ *
 * Transactions
 * ------------------------------------------------------------------ */

const txnShape = (r) => r && ({
  id: Number(r.id),
  userId: r.user_id == null ? null : Number(r.user_id),
  clickId: r.click_id,
  merchant: r.merchant,
  network: r.network,
  networkTxnId: r.network_txn_id,
  salePaise: Number(r.sale_paise),
  commissionPaise: Number(r.commission_paise),
  sharePct: Number(r.share_pct),
  cashbackPaise: Number(r.cashback_paise),
  status: r.status,
  review: Number(r.review) === 1,
  note: r.note,
  occurredAt: Number(r.occurred_at),
  confirmedAt: Number(r.confirmed_at),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

/**
 * One purchase, as the network reports it — the first time, or again with
 * news. Keyed by (network, network_txn_id): a report sent twice is one row.
 *
 * Returns { txn, created, changed, from } so the caller can tell the user
 * exactly once per real change.
 */
async function upsertTxn(t) {
  await migrate();
  if (!TXN_STATUSES.has(t.status)) throw new Error(`bad status ${t.status}`);
  const now = Date.now();
  return tx(async (c) => {
    const find = async () => (await c.query(
      "SELECT * FROM cashback_txns WHERE network = $1 AND network_txn_id = $2 FOR UPDATE",
      [t.network, t.networkTxnId])).rows[0];
    let found = await find();
    if (!found) {
      const made = (await c.query(
        `INSERT INTO cashback_txns
           (user_id, click_id, merchant, network, network_txn_id, sale_paise, commission_paise,
            share_pct, cashback_paise, status, review, note, occurred_at, confirmed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
         ON CONFLICT (network, network_txn_id) DO NOTHING RETURNING *`,
        [t.userId ?? null, t.clickId || "", t.merchant || "", t.network, t.networkTxnId,
          t.salePaise || 0, t.commissionPaise || 0, t.sharePct, t.cashbackPaise || 0,
          t.status, t.review ? 1 : 0, t.note || "", t.occurredAt || now,
          t.status === "confirmed" ? now : 0, now])).rows[0];
      if (made) return { txn: txnShape(made), created: true, changed: true, from: null };
      // The same purchase arrived twice at the same moment and the other
      // report made the row: this one is applied to it like any later
      // report, so its news (a validation, say) is not dropped.
      found = await find();
    }

    // AN EXISTING ROW. What a REPORT may do to it (security review,
    // 2026-11-27 — each of these was a way to be paid for nothing):
    //
    //   pending   → confirmed | rejected
    //   confirmed → rejected            (a return after validation)
    //
    // and nothing else. A cancelled purchase is not brought back by a late
    // or replayed "approved", and a row a PERSON must look at (review) is
    // confirmed only by that person (setTxnStatus). A report that asks for
    // anything else changes nothing and puts the row in front of a person.
    const from = found.status;
    let to = t.status;
    let review = Number(found.review);
    let note = t.note || "";
    const allowed = (from === "pending" && (to === "confirmed" || to === "rejected"))
      || (from === "confirmed" && to === "rejected");
    if (to !== from && !allowed) {
      // A stale "pending" after a decision is only an old report arriving
      // late: ignored quietly. Asking to confirm what was cancelled is not.
      if (to !== "pending") {
        note = `a report asked for "${to}" after "${from}": not applied`;
        review = 1;
      }
      to = from;
    }
    if (review === 1 && from === "pending" && to === "confirmed") to = "pending";

    // A still-pending amount may be corrected (a partly returned order). A
    // confirmed amount is what the user was told they have; a report may
    // reject it, never resize it.
    const amounts = { sale: found.sale_paise, commission: found.commission_paise, cashback: found.cashback_paise };
    if (from === "pending" && t.commissionPaise != null
        && Number(t.commissionPaise) !== Number(found.commission_paise)) {
      // The share and the eligibility are the ones the purchase was first
      // tracked with: a partner switched off since, or a changed share,
      // does not reach back into a purchase already made. Only a row that
      // had no commission yet is judged by today's rules.
      const wasEarning = Number(found.cashback_paise) > 0;
      const firstAmount = Number(found.commission_paise) === 0;
      const pct = wasEarning ? Number(found.share_pct) : t.sharePct;
      amounts.commission = t.commissionPaise;
      amounts.sale = t.salePaise ?? found.sale_paise;
      amounts.cashback = wasEarning || (firstAmount && t.earns)
        ? Math.floor((Number(t.commissionPaise) * pct) / 100) : 0;
      if (t.review) {
        review = 1;
        if (to === "confirmed") to = "pending";
      }
    }

    // `changed` is what the USER is told about: the state or the amount.
    const changed = from !== to || Number(amounts.cashback) !== Number(found.cashback_paise);
    const dirty = changed || review !== Number(found.review) || (note && note !== found.note);
    if (!dirty) return { txn: txnShape(found), created: false, changed: false, from };
    const row = (await c.query(
      `UPDATE cashback_txns
          SET status = $2, sale_paise = $3, commission_paise = $4, cashback_paise = $5, review = $6,
              confirmed_at = CASE WHEN $2 = 'confirmed' AND confirmed_at = 0 THEN $7 ELSE confirmed_at END,
              note = CASE WHEN $8 <> '' THEN $8 ELSE note END, updated_at = $7
        WHERE id = $1 RETURNING *`,
      [found.id, to, amounts.sale, amounts.commission, amounts.cashback, review, now, note])).rows[0];
    return { txn: txnShape(row), created: false, changed, from };
  });
}

async function txnById(id) {
  await migrate();
  return txnShape(await one("SELECT * FROM cashback_txns WHERE id = $1", [Number(id)]));
}

/** A person's decision on one row (the admin panel). */
async function setTxnStatus(id, status, { note = "", userId, cashbackPaise } = {}) {
  await migrate();
  if (!TXN_STATUSES.has(status)) throw new Error(`bad status ${status}`);
  const now = Date.now();
  const row = await one(
    `UPDATE cashback_txns
        SET status = $2, review = 0,
            user_id = COALESCE($5, user_id),
            cashback_paise = COALESCE($6, cashback_paise),
            confirmed_at = CASE WHEN $2 = 'confirmed' AND confirmed_at = 0 THEN $3 ELSE confirmed_at END,
            note = CASE WHEN $4 <> '' THEN $4 ELSE note END, updated_at = $3
      WHERE id = $1 RETURNING *`,
    [Number(id), status, now, String(note || "").slice(0, 300), userId ?? null,
      cashbackPaise == null ? null : Math.max(0, Math.round(Number(cashbackPaise)))]);
  return txnShape(row);
}

async function listTxns({ userId, status, review, limit = 50, before } = {}) {
  await migrate();
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (userId != null) add("user_id = ?", Number(userId));
  if (status) add("status = ?", String(status));
  if (review) where.push("review = 1");
  if (before) add("id < ?", Number(before));
  params.push(Math.max(1, Math.min(200, Number(limit) || 50)));
  const rows = await query(
    `SELECT * FROM cashback_txns ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY id DESC LIMIT $${params.length}`, params);
  return rows.map(txnShape);
}

/* ------------------------------------------------------------------ *
 * Balance and payouts
 * ------------------------------------------------------------------ */

/**
 * What a person has, by reading the rows:
 *   pending    tracked, waiting for the store to validate it
 *   confirmed  validated, all time
 *   paid       sent to their UPI ID
 *   held       asked for, not yet paid
 *   available  confirmed − paid − held (never shown below zero; a clawback
 *              after a payout simply blocks the next one until it is covered)
 */
async function balance(userId, db = { one }) {
  await migrate();
  const uid = Number(userId);
  const t = await db.one(
    `SELECT COALESCE(SUM(cashback_paise) FILTER (WHERE status = 'pending'), 0)::bigint   AS pending,
            COALESCE(SUM(cashback_paise) FILTER (WHERE status = 'confirmed'), 0)::bigint AS confirmed
       FROM cashback_txns WHERE user_id = $1`, [uid]);
  const p = await db.one(
    `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE status = 'paid'), 0)::bigint      AS paid,
            COALESCE(SUM(amount_paise) FILTER (WHERE status = 'requested'), 0)::bigint AS held
       FROM cashback_payouts WHERE user_id = $1`, [uid]);
  const confirmed = Number(t.confirmed), paid = Number(p.paid), held = Number(p.held);
  return {
    pendingPaise: Number(t.pending),
    confirmedPaise: confirmed,
    paidPaise: paid,
    heldPaise: held,
    availablePaise: Math.max(0, confirmed - paid - held),
  };
}

const payoutShape = (r) => r && ({
  id: Number(r.id),
  userId: Number(r.user_id),
  amountPaise: Number(r.amount_paise),
  upiId: r.upi_id,
  status: r.status,
  reference: r.reference,
  note: r.note,
  requestedAt: Number(r.requested_at),
  decidedAt: Number(r.decided_at),
});

class PayoutError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Asks for the whole available balance. The balance is read and the request
 * written under one lock on the user's row, so two taps — or two phones —
 * cannot each take the same money.
 */
async function requestPayout(userId, { upiId, minPaise }) {
  await migrate();
  const uid = Number(userId);
  return tx(async (c) => {
    await c.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [uid]);
    const open = (await c.query(
      "SELECT id FROM cashback_payouts WHERE user_id = $1 AND status = 'requested'", [uid])).rows[0];
    if (open) throw new PayoutError("open", "A withdrawal is already being processed.");
    const b = await balance(uid, { one: async (sql, p) => (await c.query(sql, p)).rows[0] });
    if (b.availablePaise < minPaise) {
      throw new PayoutError("below_min", "Your available cashback is below the minimum for a withdrawal.");
    }
    const row = (await c.query(
      `INSERT INTO cashback_payouts (user_id, amount_paise, upi_id, status, requested_at)
       VALUES ($1,$2,$3,'requested',$4) RETURNING *`,
      [uid, b.availablePaise, upiId, Date.now()])).rows[0];
    return payoutShape(row);
  });
}

/**
 * The owner's decision: paid (with the bank's reference) or rejected. Once.
 *
 * PAID ONLY WHILE THE MONEY IS STILL THERE (security review, 2026-11-27).
 * The amount was fixed when the user asked. A purchase cancelled between
 * the request and the payment used to be paid anyway; now marking it paid
 * re-reads the balance under the same lock a request takes, and refuses
 * (PayoutError "short") when confirmed cashback no longer covers it. The
 * owner then refuses the withdrawal and the user asks again for what is left.
 */
async function decidePayout(id, { status, reference = "", note = "" }) {
  await migrate();
  if (status !== "paid" && status !== "rejected") throw new Error(`bad status ${status}`);
  const peek = await one("SELECT user_id FROM cashback_payouts WHERE id = $1", [Number(id)]);
  if (!peek) return null;
  return tx(async (c) => {
    // The user's row first, then the payout: the same order a request uses.
    await c.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [Number(peek.user_id)]);
    const p = (await c.query(
      "SELECT * FROM cashback_payouts WHERE id = $1 AND status = 'requested' FOR UPDATE", [Number(id)])).rows[0];
    if (!p) return null;
    if (status === "paid") {
      const b = await balance(p.user_id, { one: async (sql, params) => (await c.query(sql, params)).rows[0] });
      if (b.confirmedPaise - b.paidPaise < Number(p.amount_paise)) {
        throw new PayoutError("short",
          "A purchase was cancelled after this withdrawal was requested, so the confirmed cashback no longer covers it. Refuse it; the user can ask again for what is left.");
      }
    }
    const row = (await c.query(
      `UPDATE cashback_payouts SET status = $2, reference = $3, note = $4, decided_at = $5
        WHERE id = $1 AND status = 'requested' RETURNING *`,
      [Number(id), status, String(reference).slice(0, 80), String(note).slice(0, 300), Date.now()])).rows[0];
    return payoutShape(row);
  });
}

/**
 * The account is being erased (routes/privacy.js). cashback_payouts is kept
 * as a record of money PAID; what was never paid has no reason to keep a
 * person's UPI ID: an open request is closed and unpaid rows lose the ID.
 */
async function onAccountErased(userId) {
  await migrate();
  const uid = Number(userId);
  await run(
    `UPDATE cashback_payouts SET status = 'rejected', note = 'account deleted', decided_at = $2
      WHERE user_id = $1 AND status = 'requested'`, [uid, Date.now()]);
  await run("UPDATE cashback_payouts SET upi_id = '' WHERE user_id = $1 AND status <> 'paid'", [uid]);
}

async function listPayouts({ userId, status, limit = 50 } = {}) {
  await migrate();
  const where = [];
  const params = [];
  if (userId != null) { params.push(Number(userId)); where.push(`user_id = $${params.length}`); }
  if (status) { params.push(String(status)); where.push(`status = $${params.length}`); }
  params.push(Math.max(1, Math.min(200, Number(limit) || 50)));
  const rows = await query(
    `SELECT * FROM cashback_payouts ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY id DESC LIMIT $${params.length}`, params);
  return rows.map(payoutShape);
}

/* ------------------------------------------------------------------ *
 * Rules: what the owner set for one partner
 * ------------------------------------------------------------------ */

async function rules() {
  await migrate();
  const rows = await query("SELECT * FROM cashback_rules");
  return new Map(rows.map((r) => [r.merchant, {
    enabled: Number(r.enabled) === 1,
    rateText: r.rate_text,
    sharePct: r.share_pct == null ? null : Number(r.share_pct),
  }]));
}

async function setRule(merchant, { enabled, rateText, sharePct }) {
  await migrate();
  await run(
    `INSERT INTO cashback_rules (merchant, enabled, rate_text, share_pct, updated_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (merchant) DO UPDATE
       SET enabled = EXCLUDED.enabled, rate_text = EXCLUDED.rate_text,
           share_pct = EXCLUDED.share_pct, updated_at = EXCLUDED.updated_at`,
    [String(merchant), enabled === false ? 0 : 1, String(rateText || "").slice(0, 60),
      sharePct == null ? null : Math.max(0, Math.min(100, Math.round(Number(sharePct)))), Date.now()]);
}

/** Totals for the owner's overview. */
async function totals() {
  await migrate();
  const t = await one(
    `SELECT COUNT(*)::int AS txns,
            COALESCE(SUM(commission_paise) FILTER (WHERE status <> 'rejected'), 0)::bigint AS commission,
            COALESCE(SUM(cashback_paise) FILTER (WHERE status = 'pending'), 0)::bigint   AS pending,
            COALESCE(SUM(cashback_paise) FILTER (WHERE status = 'confirmed'), 0)::bigint AS confirmed,
            COUNT(*) FILTER (WHERE review = 1 AND status = 'pending')::int AS review,
            COUNT(*) FILTER (WHERE user_id IS NULL)::int AS unmatched
       FROM cashback_txns`);
  const p = await one(
    `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE status = 'paid'), 0)::bigint      AS paid,
            COALESCE(SUM(amount_paise) FILTER (WHERE status = 'requested'), 0)::bigint AS requested,
            COUNT(*) FILTER (WHERE status = 'requested')::int AS open
       FROM cashback_payouts`);
  const c = await one(
    `SELECT COUNT(*)::int AS clicks, COUNT(*) FILTER (WHERE tracked)::int AS tracked
       FROM affiliate_clicks WHERE created_at > $1`, [Date.now() - 30 * 86_400_000]);
  return {
    txns: t.txns, commissionPaise: Number(t.commission), pendingPaise: Number(t.pending),
    confirmedPaise: Number(t.confirmed), needReview: t.review, unmatched: t.unmatched,
    paidPaise: Number(p.paid), requestedPaise: Number(p.requested), openPayouts: p.open,
    clicks30d: c.clicks, trackedClicks30d: c.tracked,
  };
}

module.exports = {
  migrate, newClickId, recordClick, clickById,
  upsertTxn, txnById, setTxnStatus, listTxns,
  balance, requestPayout, decidePayout, listPayouts, PayoutError, onAccountErased,
  rules, setRule, totals,
  TXN_STATUSES, PAYOUT_STATUSES,
};
