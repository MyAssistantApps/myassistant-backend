/**
 * WALLET ACCESS + STEP-UP (Phase 2).
 *
 * ACCESS — the staged launch (plan, Phase 4): the wallet answers only when
 * WALLET_ENABLED is on, and, while WALLET_ALLOW_USERS lists ids, only for
 * those accounts (the team first, then everyone by clearing the list).
 *
 * STEP-UP — a stolen session token alone must not empty a wallet. A spend
 * above WALLET_STEPUP_PAISE (₹2,000) and every refund need a fresh wallet
 * PIN: POST /wallet/step-up checks it (scrypt hash, 5 wrong tries lock it
 * for 15 minutes) and returns a token good for 5 minutes, sent back in the
 * X-Wallet-Step-Up header.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { one, query } = require("../db");

const STEP_UP_SECONDS = 300;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

function enabled() {
  return ["1", "on", "true", "yes"].includes(String(process.env.WALLET_ENABLED || "").toLowerCase());
}

/** Can this user use the wallet now? */
function allowed(userId) {
  if (!enabled()) return false;
  const list = String(process.env.WALLET_ALLOW_USERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(String(userId));
}

/** Spends above this (paise) need a step-up. */
function stepUpThreshold() {
  const v = Number(process.env.WALLET_STEPUP_PAISE);
  return Number.isSafeInteger(v) && v > 0 ? v : 200_000;
}

/** Four to six digits, not all one digit, not a straight run (1234, 9876). */
function pinProblem(pin) {
  const p = String(pin || "");
  if (!/^\d{4,6}$/.test(p)) return "The PIN must be 4 to 6 digits.";
  if (/^(\d)\1+$/.test(p)) return "Please choose a PIN that is not one digit repeated.";
  const d = [...p].map(Number);
  const up = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const down = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
  if (up || down) return "Please choose a PIN that is not a simple sequence.";
  return null;
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function pinMatches(pin, stored) {
  const [alg, saltHex, hashHex] = String(stored || "").split("$");
  if (alg !== "scrypt" || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, "hex");
  const got = crypto.scryptSync(String(pin), Buffer.from(saltHex, "hex"), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}

async function hasPin(userId) {
  return Boolean(await one(`SELECT 1 FROM wallet_pins WHERE user_id = $1`, [Number(userId)]));
}

/**
 * Sets the PIN. Changing one needs the current PIN (a stolen session cannot
 * replace it); a forgotten PIN is reset by support (admin).
 * Returns null on success, else a message.
 */
async function setPin(userId, pin, currentPin) {
  const bad = pinProblem(pin);
  if (bad) return bad;
  const uid = Number(userId);
  const row = await one(`SELECT * FROM wallet_pins WHERE user_id = $1`, [uid]);
  if (row) {
    const check = await verifyPin(uid, currentPin);
    if (!check.ok) return check.message;
  }
  await query(
    `INSERT INTO wallet_pins (user_id, pin_hash, failed, locked_until, updated_at) VALUES ($1, $2, 0, 0, $3)
     ON CONFLICT (user_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, failed = 0, locked_until = 0, updated_at = EXCLUDED.updated_at`,
    [uid, hashPin(pin), Date.now()]);
  return null;
}

/** Checks a PIN with the lockout. { ok, message }. */
async function verifyPin(userId, pin) {
  const uid = Number(userId);
  const row = await one(`SELECT * FROM wallet_pins WHERE user_id = $1`, [uid]);
  if (!row) return { ok: false, code: "pin_not_set", message: "Please set a wallet PIN first." };
  const t = Date.now();
  if (Number(row.locked_until) > t) {
    const mins = Math.ceil((Number(row.locked_until) - t) / 60_000);
    return { ok: false, code: "pin_locked", message: `Too many wrong PINs. Please try again in ${mins} minute${mins === 1 ? "" : "s"}.` };
  }
  if (/^\d{4,6}$/.test(String(pin || "")) && pinMatches(pin, row.pin_hash)) {
    await query(`UPDATE wallet_pins SET failed = 0, locked_until = 0 WHERE user_id = $1`, [uid]);
    return { ok: true };
  }
  const failed = Number(row.failed) + 1;
  const lock = failed >= MAX_FAILS ? t + LOCK_MS : 0;
  await query(`UPDATE wallet_pins SET failed = $2, locked_until = $3 WHERE user_id = $1`,
    [uid, lock ? 0 : failed, lock]);
  return lock
    ? { ok: false, code: "pin_locked", message: "Too many wrong PINs. Please try again in 15 minutes." }
    : { ok: false, code: "pin_wrong", message: `Wrong PIN. ${MAX_FAILS - failed} attempt${MAX_FAILS - failed === 1 ? "" : "s"} left.` };
}

/** A step-up token for [userId], valid for 5 minutes. */
function issueStepUp(userId) {
  return jwt.sign({ sub: String(userId), scope: "wallet_stepup" }, process.env.JWT_SECRET, {
    algorithm: "HS256", expiresIn: STEP_UP_SECONDS,
  });
}

/** True when [token] is this user's unexpired step-up token. */
function stepUpValid(userId, token) {
  if (!token || !process.env.JWT_SECRET) return false;
  try {
    const p = jwt.verify(String(token), process.env.JWT_SECRET, { algorithms: ["HS256"] });
    return p.scope === "wallet_stepup" && String(p.sub) === String(userId);
  } catch (_) {
    return false;
  }
}

module.exports = {
  enabled, allowed, stepUpThreshold, pinProblem, hashPin, pinMatches, hasPin, setPin, verifyPin,
  issueStepUp, stepUpValid, STEP_UP_SECONDS,
};
