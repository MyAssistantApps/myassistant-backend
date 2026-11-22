/**
 * WALLET LEDGER (2026-11-22, Phase 1 of the wallet plan — see the design
 * doc "MyAssistant Wallet, Referrals & Razorpay — Design Plan").
 *
 * A closed-loop rupee wallet kept as a DOUBLE-ENTRY LEDGER:
 *
 *   wallet_accounts      one row per user per balance kind (cash, bonus),
 *                        plus the service's own system accounts (sys_*)
 *   wallet_transactions  one business event (a top-up, a spend, a refund…)
 *   wallet_entries       its lines: two or more, summing to ZERO
 *
 * Every rupee that moves is one transaction whose entries balance; a
 * balance is never written on its own — the cached balance_paise on an
 * account changes only inside post(), in the same database transaction as
 * the entries that justify it. A nightly check (jobs.js) rebuilds every
 * balance from the entries and alerts on any difference.
 *
 * The database enforces what the code promises:
 *   • amounts are integer PAISE (BIGINT) — never floats;
 *   • a user account can never go below zero (CHECK);
 *   • a transaction whose entries do not sum to zero cannot commit
 *     (deferred constraint trigger);
 *   • entries can never be updated or deleted, and a transaction's money
 *     fields can never change (triggers) — a correction is a NEW reversal
 *     transaction, never an edit;
 *   • the same idempotency key can post only once (UNIQUE), so a retried
 *     request or a webhook delivered twice moves money exactly once.
 *
 * ERASURE: wallet rows are financial records, so an account delete does
 * not remove them; it clears user_id (privacy.js SHARED_TABLES), which
 * leaves the amounts — and the ledger's balance — intact but no longer
 * pointing at the person.
 */
const crypto = require("crypto");
const { query, one, tx } = require("../db");

/** Balance kinds a user can hold. */
const USER_KINDS = ["cash", "bonus"];

/** The service's own accounts. They may go negative (money owed / spent). */
const SYSTEM_KINDS = [
  // Money Razorpay has taken from a payer and owes us: debited when a
  // top-up credits a wallet, so it runs negative until settlement.
  "sys_razorpay_clearing",
  // Promotional money given away (referral rewards — Phase 3).
  "sys_referral_expense",
  // Money spent inside the app (Phase 2).
  "sys_revenue",
  // Money on its way back to a payer (Phase 2).
  "sys_refunds",
];

const now = () => Date.now();
const newId = () => crypto.randomUUID();

async function migrate(exec = (sql) => query(sql)) {
  await exec(`
    CREATE TABLE IF NOT EXISTS wallet_accounts (
      id            BIGSERIAL PRIMARY KEY,
      -- NULL for system accounts, and for a user account after erasure.
      user_id       INTEGER,
      kind          TEXT NOT NULL,
      balance_paise BIGINT NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'active', -- active | frozen | closed
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL,
      CONSTRAINT wallet_accounts_kind_ok CHECK (kind IN
        ('cash', 'bonus', 'sys_razorpay_clearing', 'sys_referral_expense', 'sys_revenue', 'sys_refunds')),
      -- A person's money never goes below zero; system accounts may.
      CONSTRAINT wallet_accounts_user_nonneg CHECK (kind LIKE 'sys\\_%' OR balance_paise >= 0)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_accounts_user_kind
      ON wallet_accounts (user_id, kind) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_accounts_system
      ON wallet_accounts (kind) WHERE user_id IS NULL AND kind LIKE 'sys\\_%';

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id              TEXT PRIMARY KEY,
      user_id         INTEGER,
      -- topup | spend | refund | referral_reward | bonus_expiry | reversal | adjustment
      type            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'posted', -- posted | reversed
      amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
      currency        TEXT NOT NULL DEFAULT 'INR',
      -- The same key can post only once: a retry returns the first result.
      idempotency_key TEXT NOT NULL UNIQUE,
      reference_type  TEXT NOT NULL DEFAULT '',
      reference_id    TEXT NOT NULL DEFAULT '',
      reverses_id     TEXT,
      title           TEXT NOT NULL DEFAULT '',
      meta            JSONB NOT NULL DEFAULT '{}',
      created_at      BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_txn_user ON wallet_transactions (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS wallet_entries (
      id                  BIGSERIAL PRIMARY KEY,
      transaction_id      TEXT NOT NULL REFERENCES wallet_transactions(id),
      account_id          BIGINT NOT NULL REFERENCES wallet_accounts(id),
      -- + credit to the account, − debit from it.
      amount_paise        BIGINT NOT NULL CHECK (amount_paise <> 0),
      balance_after_paise BIGINT NOT NULL,
      created_at          BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_entries_txn ON wallet_entries (transaction_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_entries_account ON wallet_entries (account_id, id);
  `);

  // The database refuses what the code must never do. CREATE OR REPLACE
  // + DROP/CREATE TRIGGER keep this idempotent across boots.
  await exec(`
    CREATE OR REPLACE FUNCTION wallet_txn_balanced() RETURNS trigger AS $$
    DECLARE total BIGINT; n INTEGER;
    BEGIN
      SELECT COALESCE(SUM(amount_paise), 0), COUNT(*) INTO total, n
        FROM wallet_entries WHERE transaction_id = NEW.transaction_id;
      IF total <> 0 OR n < 2 THEN
        RAISE EXCEPTION 'wallet: transaction % does not balance (sum %, % entries)',
          NEW.transaction_id, total, n;
      END IF;
      RETURN NULL;
    END $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION wallet_entries_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'wallet: ledger entries are append-only';
    END $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION wallet_txn_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'wallet: transactions cannot be deleted';
      END IF;
      IF NEW.id <> OLD.id OR NEW.type <> OLD.type OR NEW.amount_paise <> OLD.amount_paise
         OR NEW.currency <> OLD.currency OR NEW.idempotency_key <> OLD.idempotency_key
         OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'wallet: a transaction''s money fields cannot change';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS wallet_entries_balanced ON wallet_entries;
    CREATE CONSTRAINT TRIGGER wallet_entries_balanced
      AFTER INSERT ON wallet_entries DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION wallet_txn_balanced();

    DROP TRIGGER IF EXISTS wallet_entries_no_change ON wallet_entries;
    CREATE TRIGGER wallet_entries_no_change
      BEFORE UPDATE OR DELETE ON wallet_entries
      FOR EACH ROW EXECUTE FUNCTION wallet_entries_append_only();

    DROP TRIGGER IF EXISTS wallet_transactions_guard ON wallet_transactions;
    CREATE TRIGGER wallet_transactions_guard
      BEFORE UPDATE OR DELETE ON wallet_transactions
      FOR EACH ROW EXECUTE FUNCTION wallet_txn_guard();
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS wallet_topups (
      id                  TEXT PRIMARY KEY,
      user_id             INTEGER,
      -- The app's Idempotency-Key: the same tap never makes two orders.
      idempotency_key     TEXT NOT NULL,
      amount_paise        BIGINT NOT NULL CHECK (amount_paise > 0),
      currency            TEXT NOT NULL DEFAULT 'INR',
      razorpay_order_id   TEXT UNIQUE,
      razorpay_payment_id TEXT UNIQUE,
      -- creating | created | credited | failed | expired | flagged
      status              TEXT NOT NULL DEFAULT 'creating',
      method              TEXT NOT NULL DEFAULT '',
      failure_reason      TEXT NOT NULL DEFAULT '',
      credited_txn_id     TEXT,
      created_at          BIGINT NOT NULL,
      updated_at          BIGINT NOT NULL,
      paid_at             BIGINT,
      credited_at         BIGINT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_topups_idem ON wallet_topups (user_id, idempotency_key)
      WHERE user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_wallet_topups_user ON wallet_topups (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_topups_open ON wallet_topups (status, created_at)
      WHERE status IN ('creating', 'created');

    -- Every Razorpay webhook received: a delivery seen before is not
    -- processed again, and the payload is kept for replay and audit.
    CREATE TABLE IF NOT EXISTS razorpay_events (
      event_id     TEXT PRIMARY KEY,
      event        TEXT NOT NULL,
      payload      JSONB NOT NULL,
      received_at  BIGINT NOT NULL,
      processed_at BIGINT,
      result       TEXT NOT NULL DEFAULT ''
    );
  `);
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */

/** A user's account of [kind], made on first use. Inside a transaction. */
async function userAccount(client, userId, kind) {
  if (!USER_KINDS.includes(kind)) throw new Error(`wallet: unknown user account kind ${kind}`);
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error("wallet: a user id is required");
  const t = now();
  await client.query(
    `INSERT INTO wallet_accounts (user_id, kind, created_at, updated_at) VALUES ($1, $2, $3, $3)
     ON CONFLICT (user_id, kind) WHERE user_id IS NOT NULL DO NOTHING`, [uid, kind, t]);
  const r = await client.query(
    `SELECT * FROM wallet_accounts WHERE user_id = $1 AND kind = $2`, [uid, kind]);
  return r.rows[0];
}

/** One of the service's own accounts, made on first use. Inside a transaction. */
async function systemAccount(client, kind) {
  if (!SYSTEM_KINDS.includes(kind)) throw new Error(`wallet: unknown system account ${kind}`);
  const t = now();
  await client.query(
    `INSERT INTO wallet_accounts (user_id, kind, created_at, updated_at) VALUES (NULL, $1, $2, $2)
     ON CONFLICT (kind) WHERE user_id IS NULL AND kind LIKE 'sys\\_%' DO NOTHING`, [kind, t]);
  const r = await client.query(
    `SELECT * FROM wallet_accounts WHERE user_id IS NULL AND kind = $1`, [kind]);
  return r.rows[0];
}

/* ------------------------------------------------------------------ */
/* Posting                                                             */

/**
 * Checks a set of legs before anything touches the database: integers,
 * none zero, at least two, summing to zero. Pure, so it is unit-tested.
 */
function validateLegs(legs) {
  if (!Array.isArray(legs) || legs.length < 2) return "a transaction needs at least two entries";
  let sum = 0n;
  for (const l of legs) {
    if (!l || !Number.isSafeInteger(l.amount) || l.amount === 0) return "every entry needs a non-zero whole-paise amount";
    if (!l.accountId) return "every entry needs an account";
    sum += BigInt(l.amount);
  }
  if (sum !== 0n) return "entries must sum to zero";
  const ids = legs.map((l) => String(l.accountId));
  if (new Set(ids).size !== ids.length) return "an account may appear only once in a transaction";
  return null;
}

/**
 * Posts one balanced transaction INSIDE the caller's database transaction
 * ([client] from db.tx). Returns { transaction, duplicate }:
 *   duplicate = true → this idempotency key was posted before; nothing
 *   moved now, and `transaction` is the first posting.
 *
 * legs: [{ accountId, amount }] with + = credit, − = debit, summing to 0.
 * Accounts are locked in ascending id order so two postings that touch the
 * same accounts queue instead of deadlocking; a user account going below
 * zero is refused by the CHECK and rolls the whole transaction back.
 */
async function post(client, { userId = null, type, key, amount, legs, title = "", referenceType = "", referenceId = "", reversesId = null, meta = {} }) {
  if (!type) throw new Error("wallet: a transaction type is required");
  if (!key) throw new Error("wallet: an idempotency key is required");
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("wallet: amount must be a positive whole number of paise");
  const bad = validateLegs(legs);
  if (bad) throw new Error(`wallet: ${bad}`);

  const t = now();
  const id = newId();
  const ins = await client.query(
    `INSERT INTO wallet_transactions
       (id, user_id, type, amount_paise, idempotency_key, reference_type, reference_id, reverses_id, title, meta, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [id, userId, type, amount, key, referenceType, referenceId, reversesId, title, JSON.stringify(meta), t]);
  if (!ins.rows[0]) {
    const first = await client.query(`SELECT * FROM wallet_transactions WHERE idempotency_key = $1`, [key]);
    return { transaction: first.rows[0], duplicate: true };
  }

  const ordered = [...legs].sort((a, b) => Number(a.accountId) - Number(b.accountId));
  const locked = await client.query(
    `SELECT id, kind, balance_paise, status FROM wallet_accounts
      WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
    [ordered.map((l) => l.accountId)]);
  if (locked.rows.length !== ordered.length) throw new Error("wallet: an account does not exist");
  const byId = new Map(locked.rows.map((r) => [String(r.id), r]));

  for (const leg of ordered) {
    const acct = byId.get(String(leg.accountId));
    // A frozen wallet can still RECEIVE (money Razorpay already captured
    // must land somewhere); it cannot be spent from.
    if (acct.status !== "active" && !acct.kind.startsWith("sys_") && leg.amount < 0) {
      const e = new Error("wallet: this wallet is not active");
      e.code = "wallet_frozen";
      throw e;
    }
    const after = BigInt(acct.balance_paise) + BigInt(leg.amount);
    if (!acct.kind.startsWith("sys_") && after < 0n) {
      const e = new Error("wallet: insufficient balance");
      e.code = "insufficient_balance";
      throw e;
    }
    await client.query(
      `INSERT INTO wallet_entries (transaction_id, account_id, amount_paise, balance_after_paise, created_at)
       VALUES ($1, $2, $3, $4, $5)`, [id, acct.id, leg.amount, after.toString(), t]);
    await client.query(
      `UPDATE wallet_accounts SET balance_paise = $2, updated_at = $3 WHERE id = $1`,
      [acct.id, after.toString(), t]);
    acct.balance_paise = after.toString();
  }
  return { transaction: ins.rows[0], duplicate: false };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */

/** { cash, bonus, status } in paise; zero for an account not made yet. */
async function balances(userId) {
  const rows = await query(
    `SELECT kind, balance_paise, status FROM wallet_accounts WHERE user_id = $1 AND kind = ANY($2::text[])`,
    [Number(userId), USER_KINDS]);
  const out = { cash: 0, bonus: 0, status: "active" };
  for (const r of rows) {
    out[r.kind] = Number(r.balance_paise);
    if (r.status !== "active") out.status = r.status;
  }
  return out;
}

/**
 * A user's transactions, newest first, as the app lists them: the amount
 * signed by what it did to their cash + bonus, and the balance after.
 * Cursor = the created_at|id of the last row seen.
 */
async function history(userId, { cursor = "", limit = 20 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const [cAt, cId] = String(cursor || "").split("|");
  const params = [Number(userId), USER_KINDS, lim + 1];
  let where = "";
  if (cAt && cId) {
    params.push(Number(cAt), cId);
    where = "AND (t.created_at, t.id) < ($4, $5)";
  }
  const rows = await query(
    `SELECT t.id, t.type, t.status, t.amount_paise, t.title, t.reference_type, t.reference_id, t.created_at,
            COALESCE(SUM(e.amount_paise), 0) AS net_paise,
            MAX(CASE WHEN a.kind = 'cash' THEN e.balance_after_paise END) AS cash_after,
            MAX(CASE WHEN a.kind = 'bonus' THEN e.balance_after_paise END) AS bonus_after
       FROM wallet_transactions t
       JOIN wallet_entries e ON e.transaction_id = t.id
       JOIN wallet_accounts a ON a.id = e.account_id AND a.user_id = $1 AND a.kind = ANY($2::text[])
      WHERE t.user_id = $1 ${where}
      GROUP BY t.id
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $3`, params);
  const page = rows.slice(0, lim).map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    title: r.title,
    amount_paise: Math.abs(Number(r.net_paise)),
    direction: Number(r.net_paise) >= 0 ? "in" : "out",
    cash_after_paise: r.cash_after == null ? null : Number(r.cash_after),
    bonus_after_paise: r.bonus_after == null ? null : Number(r.bonus_after),
    reference_type: r.reference_type,
    reference_id: r.reference_id,
    created_at: Number(r.created_at),
  }));
  const last = rows.length > lim ? page[page.length - 1] : null;
  return { items: page, next_cursor: last ? `${last.created_at}|${last.id}` : null };
}

/* ------------------------------------------------------------------ */
/* Integrity                                                           */

/**
 * The ledger's own audit, run nightly: every cached balance must equal
 * the sum of its entries, and every transaction must balance. Returns the
 * rows that do not (empty arrays = healthy).
 */
async function integrity() {
  const drift = await query(
    `SELECT a.id, a.kind, a.user_id, a.balance_paise, COALESCE(SUM(e.amount_paise), 0) AS entries_paise
       FROM wallet_accounts a LEFT JOIN wallet_entries e ON e.account_id = a.id
      GROUP BY a.id
     HAVING a.balance_paise <> COALESCE(SUM(e.amount_paise), 0)`);
  const unbalanced = await query(
    `SELECT t.id, COALESCE(SUM(e.amount_paise), 0) AS sum_paise, COUNT(e.id) AS n
       FROM wallet_transactions t LEFT JOIN wallet_entries e ON e.transaction_id = t.id
      GROUP BY t.id
     HAVING COALESCE(SUM(e.amount_paise), 0) <> 0 OR COUNT(e.id) < 2`);
  return { drift, unbalanced };
}

module.exports = {
  migrate, userAccount, systemAccount, validateLegs, post, balances, history, integrity,
  USER_KINDS, SYSTEM_KINDS, newId, tx, one, query,
};
