/**
 * REFERRALS (Phase 3) — invite a friend, both get bonus credit once the
 * friend has really paid.
 *
 *   signed_up  the friend entered a code (at sign-up, or within 7 days)
 *   held       their first top-up of ≥ ₹100 was credited; 7-day hold
 *              (refunds and chargebacks land inside it)
 *   rewarded   bonus posted: ₹25 to the friend, ₹50 to the referrer
 *              (the referrer's within 10 a month / 50 ever)
 *   rejected   with a reason (self-referral, same device or payment
 *              method, top-up refunded, phone never verified, …)
 *   review     too many sign-ups on one code at once: the developer looks
 *   clawed_back  the qualifying top-up was refunded after the reward
 *
 * Every amount is a server setting (REFERRAL_*), so the owner can change
 * them without a release. Bonus never becomes cash: it is spent first,
 * never refunded, and expires (BONUS_EXPIRY_DAYS, 90).
 */
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const store = require("./store");
const { WalletError, rupees, alert } = require("./service");
const { query, one, tx } = require("../db");

const DAY = 24 * 3600_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const PLAY_PACKAGE = "com.myassistant.myassistant";

function settings() {
  const n = (name, d) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    referrerPaise: n("REFERRAL_REFERRER_PAISE", 5_000),
    refereePaise: n("REFERRAL_REFEREE_PAISE", 2_500),
    minTopupPaise: n("REFERRAL_MIN_TOPUP_PAISE", 10_000),
    holdDays: n("REFERRAL_HOLD_DAYS", 7),
    applyDays: n("REFERRAL_APPLY_DAYS", 7),
    phoneWaitDays: n("REFERRAL_PHONE_WAIT_DAYS", 30),
    monthlyCap: n("REFERRAL_MONTHLY_CAP", 10),
    lifetimeCap: n("REFERRAL_LIFETIME_CAP", 50),
    bonusExpiryDays: n("BONUS_EXPIRY_DAYS", 90),
    velocityPerHour: n("REFERRAL_VELOCITY_PER_HOUR", 3),
  };
}

async function migrate(exec = (sql) => query(sql)) {
  await exec(`
    CREATE TABLE IF NOT EXISTS referral_codes (
      user_id     INTEGER PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      created_at  BIGINT NOT NULL,
      disabled_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS referrals (
      id                  BIGSERIAL PRIMARY KEY,
      referrer_user_id    INTEGER,
      -- One referral per person, ever.
      referee_user_id     INTEGER UNIQUE,
      code                TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'signed_up',
      reject_reason       TEXT NOT NULL DEFAULT '',
      -- A keyed hash of the friend's install id; the raw id is never kept.
      device_hash         TEXT NOT NULL DEFAULT '',
      qualifying_topup_id TEXT,
      hold_until          BIGINT,
      referrer_txn_id     TEXT,
      referee_txn_id      TEXT,
      referrer_reward_paise BIGINT NOT NULL DEFAULT 0,
      referee_reward_paise  BIGINT NOT NULL DEFAULT 0,
      rewarded_at         BIGINT,
      created_at          BIGINT NOT NULL,
      updated_at          BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_referrals_held ON referrals (status, hold_until) WHERE status = 'held';
    CREATE INDEX IF NOT EXISTS idx_referrals_device ON referrals (device_hash) WHERE device_hash <> '';
  `);
}

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested)                                          */

function newCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

function normalizeCode(code) {
  const c = String(code || "").trim().toUpperCase().replace(/[\s-]/g, "");
  return /^[A-HJ-NP-Z2-9]{8}$/.test(c) ? c : null;
}

/** One mailbox, however it is spelled (Gmail dots, +tags, case). */
function emailKey(email) {
  const e = String(email || "").trim().toLowerCase();
  const [local, domain] = e.split("@");
  if (!local || !domain) return "";
  let l = local.split("+")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") return `${l.replace(/\./g, "")}@gmail.com`;
  return `${l}@${domain}`;
}

function deviceHash(raw) {
  const id = String(raw || "").trim();
  if (id.length < 8 || id.length > 200) return "";
  return crypto.createHmac("sha256", process.env.JWT_SECRET || "wallet").update(`device:${id}`).digest("hex").slice(0, 32);
}

/** "Asha Rao" → "A.R."; nothing personal beyond the initials. */
function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.length ? parts.map((p) => `${p[0].toUpperCase()}.`).join("") : "A friend";
}

function shareUrl(code) {
  const base = String(process.env.PUBLIC_BASE_URL || "https://backend.envisionsit.in").replace(/\/+$/, "");
  return `${base}/r/${code}`;
}

/* ------------------------------------------------------------------ */
/* Codes and applying them                                             */

/** The user's own code, made on first ask. */
async function codeFor(userId) {
  const uid = Number(userId);
  const have = await one(`SELECT code, disabled_at FROM referral_codes WHERE user_id = $1`, [uid]);
  if (have) return have.disabled_at ? null : have.code;
  for (let i = 0; i < 5; i++) {
    const row = await one(
      `INSERT INTO referral_codes (user_id, code, created_at) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING code`, [uid, newCode(), Date.now()]);
    if (row) return row.code;
    const again = await one(`SELECT code FROM referral_codes WHERE user_id = $1`, [uid]);
    if (again) return again.code;
  }
  throw new Error("could not make a referral code");
}

/**
 * The friend enters a code. Every refusal that could reveal something
 * about another account says the same thing: "This code cannot be used."
 */
async function apply(user, rawCode, rawDeviceId) {
  const uid = Number(user.sub);
  const s = settings();
  const code = normalizeCode(rawCode);
  const generic = () => new WalletError("invalid_code", "This code cannot be used.", 400);
  if (!code) throw generic();
  const me = await one(`SELECT id, email, created_at, phone_number, phone_verified_at FROM users WHERE id = $1`, [uid]);
  if (!me) throw generic();
  if (Date.now() - Number(me.created_at) > s.applyDays * DAY) {
    throw new WalletError("window_closed", `A referral code can only be added within ${s.applyDays} days of joining.`, 409);
  }
  if (await one(`SELECT 1 FROM referrals WHERE referee_user_id = $1`, [uid])) {
    throw new WalletError("already_referred", "You have already used a referral code.", 409);
  }
  const owner = await one(
    `SELECT c.user_id, u.email, u.phone_number, u.phone_verified_at FROM referral_codes c
       JOIN users u ON u.id = c.user_id WHERE c.code = $1 AND c.disabled_at IS NULL`, [code]);
  if (!owner) throw generic();
  const samePhone = me.phone_verified_at && owner.phone_verified_at && me.phone_number && me.phone_number === owner.phone_number;
  if (owner.user_id === uid || samePhone || (emailKey(me.email) && emailKey(me.email) === emailKey(owner.email))) {
    throw new WalletError("self_referral", "You cannot use your own code.", 409);
  }

  const device = deviceHash(rawDeviceId);
  let status = "signed_up";
  let reason = "";
  if (device && await one(`SELECT 1 FROM referrals WHERE device_hash = $1`, [device])) {
    status = "rejected";
    reason = "device already used for a referral";
  } else {
    const recent = await one(
      `SELECT COUNT(*)::int AS n FROM referrals WHERE code = $1 AND created_at > $2`, [code, Date.now() - 3600_000]);
    if (recent.n >= s.velocityPerHour) {
      status = "review";
      reason = `${recent.n + 1} sign-ups on one code within an hour`;
      alert("Referral code used unusually often — review it", `code ${code}, referrer ${owner.user_id}: ${reason}`);
    }
  }
  const t = Date.now();
  const row = await one(
    `INSERT INTO referrals (referrer_user_id, referee_user_id, code, status, reject_reason, device_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (referee_user_id) DO NOTHING RETURNING *`,
    [owner.user_id, uid, code, status, reason, device, t]);
  if (!row) throw new WalletError("already_referred", "You have already used a referral code.", 409);
  if (status === "rejected") throw new WalletError("not_eligible", "This code cannot be used on this device.", 409);
  return {
    status: "signed_up",
    reward_on_qualify_paise: s.refereePaise,
    message: `Code added. Add ${rupees(s.minTopupPaise)} or more to your wallet and you will get ${rupees(s.refereePaise)} bonus.`,
  };
}

/* ------------------------------------------------------------------ */
/* Hooks from the wallet                                               */

/** A top-up was credited: the friend's first qualifying one starts the hold. */
async function onTopupCredited(topup) {
  const s = settings();
  if (!topup?.user_id || Number(topup.amount_paise) < s.minTopupPaise) return;
  await query(
    `UPDATE referrals SET status = 'held', qualifying_topup_id = $2, hold_until = $3, updated_at = $4
      WHERE referee_user_id = $1 AND status = 'signed_up'`,
    [topup.user_id, topup.id, Date.now() + s.holdDays * DAY, Date.now()]);
}

/** A top-up was refunded: its referral is rejected, or its reward taken back. */
async function onTopupRefunded(topupId) {
  const r = await one(`SELECT * FROM referrals WHERE qualifying_topup_id = $1`, [topupId]);
  if (!r) return;
  if (r.status === "held") {
    await query(`UPDATE referrals SET status = 'rejected', reject_reason = 'qualifying top-up refunded', updated_at = $2
                  WHERE id = $1 AND status = 'held'`, [r.id, Date.now()]);
    return;
  }
  if (r.status !== "rewarded") return;
  await tx(async (c) => {
    const row = (await c.query(`SELECT * FROM referrals WHERE id = $1 FOR UPDATE`, [r.id])).rows[0];
    if (!row || row.status !== "rewarded") return;
    const expense = await store.systemAccount(c, "sys_referral_expense");
    for (const [role, uid, paid] of [["referee", row.referee_user_id, row.referee_reward_paise],
      ["referrer", row.referrer_user_id, row.referrer_reward_paise]]) {
      if (!uid || !Number(paid)) continue;
      const bonus = await store.userAccount(c, uid, "bonus");
      const locked = (await c.query(`SELECT balance_paise FROM wallet_accounts WHERE id = $1 FOR UPDATE`, [bonus.id])).rows[0];
      // Take back what is still there, never more: bonus already spent stays spent.
      const take = Math.min(Number(paid), Number(locked.balance_paise));
      if (take <= 0) continue;
      await store.post(c, {
        userId: uid, type: "referral_clawback", key: `referral:${row.id}:clawback:${role}`, amount: take,
        title: "Referral bonus withdrawn (the qualifying payment was refunded)",
        referenceType: "referral", referenceId: String(row.id),
        legs: [{ accountId: bonus.id, amount: -take }, { accountId: expense.id, amount: take }],
      });
      await store.consumeBonus(c, uid, take);
    }
    await c.query(`UPDATE referrals SET status = 'clawed_back', updated_at = $2 WHERE id = $1`, [row.id, Date.now()]);
  });
}

/* ------------------------------------------------------------------ */
/* The payout job                                                      */

async function rewardedCounts(c, referrerId, t) {
  const d = new Date(t);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const r = (await c.query(
    `SELECT COUNT(*) FILTER (WHERE rewarded_at >= $2)::int AS month, COUNT(*)::int AS ever
       FROM referrals WHERE referrer_user_id = $1 AND referrer_reward_paise > 0`, [referrerId, monthStart])).rows[0];
  return { month: r.month, ever: r.ever };
}

/**
 * Pays every referral whose hold has ended, after checking it again:
 * the top-up still stands, the friend's phone is verified, the payer is
 * not the referrer, and the referrer is within the caps (the friend is
 * rewarded even when the referrer is capped).
 */
async function payout({ now = Date.now(), limit = 100 } = {}) {
  const s = settings();
  const report = { rewarded: 0, rejected: 0, waiting: 0 };
  const due = await query(
    `SELECT id FROM referrals WHERE status = 'held' AND hold_until <= $1 ORDER BY hold_until LIMIT $2`, [now, limit]);
  for (const { id } of due) {
    const outcome = await tx(async (c) => {
      const r = (await c.query(`SELECT * FROM referrals WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!r || r.status !== "held") return "skip";
      const reject = async (why) => {
        await c.query(`UPDATE referrals SET status = 'rejected', reject_reason = $2, updated_at = $3 WHERE id = $1`, [id, why, now]);
        return "rejected";
      };
      if (!r.referee_user_id) return reject("account deleted");
      const topup = (await c.query(`SELECT * FROM wallet_topups WHERE id = $1`, [r.qualifying_topup_id])).rows[0];
      if (!topup || topup.status !== "credited" || Number(topup.refunded_paise) > 0) return reject("qualifying top-up refunded");
      const friend = (await c.query(`SELECT phone_verified_at FROM users WHERE id = $1`, [r.referee_user_id])).rows[0];
      if (!friend?.phone_verified_at) {
        if (now - Number(r.hold_until) > s.phoneWaitDays * DAY) return reject("phone never verified");
        return "waiting";
      }
      if (topup.payer_fingerprint && r.referrer_user_id) {
        const same = (await c.query(
          `SELECT 1 FROM wallet_topups WHERE user_id = $1 AND payer_fingerprint = $2 LIMIT 1`,
          [r.referrer_user_id, topup.payer_fingerprint])).rows[0];
        if (same) return reject("same payment method as the referrer");
      }

      const expense = await store.systemAccount(c, "sys_referral_expense");
      const expires = now + s.bonusExpiryDays * DAY;
      const give = async (uid, amount, role, title) => {
        const bonus = await store.userAccount(c, uid, "bonus");
        const posted = await store.post(c, {
          userId: uid, type: "referral_reward", key: `referral:${id}:${role}`, amount, title,
          referenceType: "referral", referenceId: String(id),
          legs: [{ accountId: expense.id, amount: -amount }, { accountId: bonus.id, amount }],
        });
        if (!posted.duplicate) await store.addBonusLot(c, { userId: uid, txnId: posted.transaction.id, amount, expiresAt: expires });
        return posted.transaction.id;
      };
      let refereeTxn = null, referrerTxn = null, referrerPaid = 0;
      if (s.refereePaise > 0) refereeTxn = await give(r.referee_user_id, s.refereePaise, "referee", "Welcome bonus for joining with a referral");
      if (r.referrer_user_id && s.referrerPaise > 0) {
        const n = await rewardedCounts(c, r.referrer_user_id, now);
        if (n.month < s.monthlyCap && n.ever < s.lifetimeCap) {
          referrerTxn = await give(r.referrer_user_id, s.referrerPaise, "referrer", "Referral bonus: your friend joined");
          referrerPaid = s.referrerPaise;
        }
      }
      await c.query(
        `UPDATE referrals SET status = 'rewarded', rewarded_at = $2, referee_txn_id = $3, referrer_txn_id = $4,
                referee_reward_paise = $5, referrer_reward_paise = $6, updated_at = $2 WHERE id = $1`,
        [id, now, refereeTxn, referrerTxn, refereeTxn ? s.refereePaise : 0, referrerPaid]);
      return "rewarded";
    }).catch((e) => {
      console.warn(`referrals: payout ${id} failed — ${e.message}`);
      return "error";
    });
    if (outcome === "rewarded") report.rewarded++;
    if (outcome === "rejected") report.rejected++;
    if (outcome === "waiting") report.waiting++;
  }
  return report;
}

/** Takes back whatever is left of bonus lots past their date. */
async function expireBonuses({ now = Date.now() } = {}) {
  let expired = 0;
  for (const lot of await store.expiredLots(now)) {
    await tx(async (c) => {
      const l = (await c.query(`SELECT * FROM wallet_bonus_lots WHERE id = $1 FOR UPDATE`, [lot.id])).rows[0];
      const left = Number(l?.remaining_paise || 0);
      if (!l || left <= 0 || !l.user_id) return;
      const bonus = await store.userAccount(c, l.user_id, "bonus");
      const expense = await store.systemAccount(c, "sys_referral_expense");
      await store.post(c, {
        userId: l.user_id, type: "bonus_expiry", key: `bonus-expiry:${l.id}`, amount: left,
        title: "Bonus expired", referenceType: "bonus_lot", referenceId: String(l.id),
        legs: [{ accountId: bonus.id, amount: -left }, { accountId: expense.id, amount: left }],
      });
      await c.query(`UPDATE wallet_bonus_lots SET remaining_paise = 0 WHERE id = $1`, [l.id]);
      expired++;
    }).catch((e) => console.warn(`referrals: bonus lot ${lot.id} expiry failed — ${e.message}`));
  }
  return { expired };
}

/* ------------------------------------------------------------------ */
/* What the app shows                                                  */

const STATUS_WORDS = {
  signed_up: "Joined: waiting for their first top-up",
  held: "Topped up: bonus on its way",
  review: "Being checked",
  rewarded: "Bonus received",
  rejected: "Not eligible",
  clawed_back: "Bonus withdrawn",
};

async function summary(userId) {
  const s = settings();
  const code = await codeFor(userId);
  const r = await one(
    `SELECT COUNT(*) FILTER (WHERE status IN ('signed_up', 'held', 'review'))::int AS pending,
            COUNT(*) FILTER (WHERE status = 'rewarded')::int AS rewarded,
            COALESCE(SUM(referrer_reward_paise) FILTER (WHERE status = 'rewarded'), 0) AS earned
       FROM referrals WHERE referrer_user_id = $1`, [Number(userId)]);
  const mine = await one(`SELECT status FROM referrals WHERE referee_user_id = $1`, [Number(userId)]);
  const me = await one(`SELECT created_at FROM users WHERE id = $1`, [Number(userId)]);
  return {
    code,
    share_url: code ? shareUrl(code) : null,
    referrer_reward_paise: s.referrerPaise,
    referee_reward_paise: s.refereePaise,
    min_topup_paise: s.minTopupPaise,
    rewards_earned_paise: Number(r?.earned || 0),
    pending: r?.pending || 0,
    rewarded: r?.rewarded || 0,
    can_apply_code: !mine && me && Date.now() - Number(me.created_at) <= s.applyDays * DAY,
  };
}

async function history(userId) {
  const rows = await query(
    `SELECT r.status, r.referrer_reward_paise, r.created_at, r.rewarded_at, u.name
       FROM referrals r LEFT JOIN users u ON u.id = r.referee_user_id
      WHERE r.referrer_user_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [Number(userId)]);
  return {
    items: rows.map((r) => ({
      friend: initials(r.name),
      status: r.status,
      status_text: STATUS_WORDS[r.status] || r.status,
      reward_paise: Number(r.referrer_reward_paise || 0),
      date: Number(r.rewarded_at || r.created_at),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */

const byUser = (req) => String(req.user?.sub || req.ip);
const router = express.Router();
const applyLimit = rateLimit({
  windowMs: 60_000, max: 10, standardHeaders: true, keyGenerator: byUser,
  message: { error: "too_many_requests", message: "Too many attempts. Please wait a minute." },
});

function fail(res, e, where) {
  if (e instanceof WalletError) return res.status(e.status || 400).json({ error: e.code, message: e.message });
  console.error(`referrals ${where} error:`, e.message || e);
  return res.status(500).json({ error: "server_error", message: "Something went wrong. Please try again." });
}

router.get("/me", async (req, res) => {
  try { res.json(await summary(req.user.sub)); } catch (e) { fail(res, e, "me"); }
});
router.post("/apply", applyLimit, async (req, res) => {
  try { res.json(await apply(req.user, req.body?.code, req.get("X-Device-Id"))); } catch (e) { fail(res, e, "apply"); }
});
router.get("/history", async (req, res) => {
  try { res.json(await history(req.user.sub)); } catch (e) { fail(res, e, "history"); }
});

/**
 * GET /r/:code — the share link. Always the same answer: the Play Store,
 * carrying the code as written (only its shape is checked), so the link
 * cannot be used to find out which codes exist.
 */
const publicRouter = express.Router();
publicRouter.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true }));
publicRouter.get("/:code", (req, res) => {
  const code = normalizeCode(req.params.code);
  const referrer = code ? `&referrer=${encodeURIComponent(`code=${code}`)}` : "";
  res.redirect(302, `https://play.google.com/store/apps/details?id=${PLAY_PACKAGE}${referrer}`);
});

module.exports = {
  migrate, settings, newCode, normalizeCode, emailKey, deviceHash, initials, shareUrl, codeFor, apply,
  onTopupCredited, onTopupRefunded, payout, expireBonuses, summary, history, router, publicRouter,
};
