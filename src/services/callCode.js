/**
 * PHONE VERIFICATION BY VOICE CALL (owner, 2026-11-14: "do the phone
 * verification using Bolna").
 *
 * Firebase Phone Number Verification does not work on Indian carriers, so
 * testers registered by TYPING a number (ALLOW_DEV_PHONE_VERIFY) — no proof
 * at all. This proves the number instead: our Bolna caller rings it and
 * reads a 6-digit code; the user types the code back into the app.
 *
 *   start(uid, phone)        → place the call (rate-limited)
 *   check(uid, phone, code)  → true once, for the right code, in time
 *
 * SECURITY — the code must reach ONLY the phone that is called:
 *  - It is never stored in clear: an HMAC of it (keyed by JWT_SECRET).
 *  - It is never written where the requesting account can see it. This
 *    deliberately does NOT go through agents/agentCall.start(), which keeps
 *    the task text in the user's call history and pushes the outcome —
 *    a requester could otherwise ask for a call to SOMEONE ELSE's number
 *    and read that person's code from their own history.
 *  - 6 digits, 10 minutes, 5 wrong tries and the code is dead; a new call
 *    replaces any earlier code.
 *  - Calls are rate-limited per account, per number and per day overall,
 *    so the feature cannot be used to ring strangers repeatedly.
 */
const crypto = require("crypto");
const { query, one, run } = require("../db");

const TTL_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const LIMITS = {
  perUserHour: 3,
  perUserDay: 6,
  perPhoneDay: 3,
  globalDay: Number(process.env.CALL_CODE_DAILY_LIMIT || 300),
};
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS phone_call_codes (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        phone       TEXT NOT NULL,
        code_hash   TEXT NOT NULL,
        tries       INTEGER NOT NULL DEFAULT 0,
        exec_id     TEXT NOT NULL DEFAULT '',
        created_at  BIGINT NOT NULL,
        expires_at  BIGINT NOT NULL,
        used_at     BIGINT NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_call_codes_user ON phone_call_codes(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_call_codes_phone ON phone_call_codes(phone, created_at);
    `).catch((e) => {
      console.error("call-code migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

function bolnaCfg() {
  return {
    key: process.env.BOLNA_API_KEY || "",
    from: process.env.BOLNA_FROM_NUMBER || "",
    agent: process.env.BOLNA_AGENT_ID || "",
  };
}

/** Offered only when Bolna is set up — the app asks /phone/methods. */
function configured() {
  const c = bolnaCfg();
  return Boolean(c.key && c.from && c.agent && process.env.JWT_SECRET);
}

const pepper = () => String(process.env.JWT_SECRET || "");
const hashCode = (code, phone) =>
  crypto.createHmac("sha256", pepper()).update(`call-code:${phone}:${code}`).digest("hex");

function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/** "4 8 2, 9 1 3" — two groups of three, digits apart, for a voice to read. */
function spoken(code) {
  const d = code.split("");
  return `${d.slice(0, 3).join(" ")}, ${d.slice(3).join(" ")}`;
}

/** What the caller is told to say. Exported for the tests. */
function taskFor(code) {
  const s = spoken(code);
  return (
    `Read out their MyAssistant verification code. Say: "Your MyAssistant verification code is ${s}." ` +
    `Then say it once more, slowly: "${s}." ` +
    "Say each digit clearly and separately. If they ask, repeat the code one more time. " +
    "Do not ask them to tell you the code, do not ask anything else, and say a short goodbye after the second reading. " +
    "This is an automatic call they asked for in the MyAssistant app."
  );
}

/** Indian numbers only for now: the caller ID is Indian (+91). */
function callable(phone) {
  return /^\+91[6-9]\d{9}$/.test(String(phone || ""));
}

class CallCodeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function countSince(where, params) {
  const r = await one(`SELECT COUNT(*)::int AS n FROM phone_call_codes WHERE ${where}`, params);
  return r?.n || 0;
}

/** Places the Bolna call. Injectable for tests. */
async function placeBolnaCall({ to, code, userName, honorific }) {
  const c = bolnaCfg();
  const cac = require("../agents/callAgentConfig");
  const r = await fetch("https://api.bolna.ai/call", {
    method: "POST",
    headers: { Authorization: `Bearer ${c.key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      agent_id: c.agent,
      recipient_phone_number: to,
      from_phone_number: c.from,
      user_data: {
        task: taskFor(code),
        mode: "self",
        contact_name: userName,
        user_name: userName,
        honorific,
        tone: "clear, friendly and brief",
        persona: cac.persona("woman"),
        gender_rules: cac.genderRules("woman", userName),
        language: "English",
        call_ref: "verify",
        user_phone: "",
      },
      // The user is waiting on the screen for this call: never postpone it
      // to calling hours.
      bypass_call_guardrails: true,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`bolna ${r.status}: ${body.slice(0, 160)}`);
  }
  const j = await r.json().catch(() => ({}));
  return String(j.execution_id || "");
}

let dial = placeBolnaCall;

/**
 * Rings [phone] with a fresh code. Throws CallCodeError with a message the
 * app can show. Returns {expiresAt}.
 */
async function start(uid, phone, { now = Date.now() } = {}) {
  await migrate();
  if (!configured()) throw new CallCodeError("Verification calls aren't available right now.", 503);
  if (!callable(phone)) throw new CallCodeError("Enter an Indian mobile number (+91).");

  if ((await countSince("user_id = $1 AND created_at > $2", [uid, now - HOUR])) >= LIMITS.perUserHour ||
      (await countSince("user_id = $1 AND created_at > $2", [uid, now - DAY])) >= LIMITS.perUserDay) {
    throw new CallCodeError("Too many calls. Please wait a while and try again.", 429);
  }
  if ((await countSince("phone = $1 AND created_at > $2", [phone, now - DAY])) >= LIMITS.perPhoneDay) {
    throw new CallCodeError("This number has had too many calls today. Please try tomorrow.", 429);
  }
  if ((await countSince("created_at > $1", [now - DAY])) >= LIMITS.globalDay) {
    throw new CallCodeError("Verification calls are busy right now. Please try later.", 503);
  }

  const u = await one("SELECT name, gender FROM users WHERE id = $1", [uid]).catch(() => null);
  const userName = String(u?.name || "").trim().split(/\s+/)[0] || "there";
  const honorific = u?.gender === "female" ? "Ma'am" : u?.gender === "male" ? "Sir" : "there";

  const code = newCode();
  // Count the attempt BEFORE dialling, so a failing provider still uses up
  // the allowance (nobody can loop on errors to ring a number).
  const row = await one(
    `INSERT INTO phone_call_codes (user_id, phone, code_hash, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [uid, phone, hashCode(code, phone), now, now + TTL_MS]
  );
  // Only the newest code counts.
  await run(
    "UPDATE phone_call_codes SET expires_at = LEAST(expires_at, $3) WHERE user_id = $1 AND id <> $2 AND used_at = 0",
    [uid, row.id, now]
  );
  try {
    const exec = await dial({ to: phone, code, userName, honorific });
    await run("UPDATE phone_call_codes SET exec_id = $2 WHERE id = $1", [row.id, exec]);
  } catch (e) {
    console.warn(`call-code: call failed for user ${uid}:`, e.message);
    await run("UPDATE phone_call_codes SET expires_at = $2 WHERE id = $1", [row.id, now]);
    throw new CallCodeError("Couldn't place the call. Please try again in a minute.", 502);
  }
  return { expiresAt: now + TTL_MS };
}

/** True exactly once for the right code on the newest live call. */
async function check(uid, phone, code, { now = Date.now() } = {}) {
  await migrate();
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== 6) return { ok: false, error: "Enter the 6-digit code." };
  const row = await one(
    `SELECT * FROM phone_call_codes
      WHERE user_id = $1 AND phone = $2 AND used_at = 0 AND expires_at > $3
      ORDER BY id DESC LIMIT 1`,
    [uid, phone, now]
  );
  if (!row) return { ok: false, error: "That code has expired. Ask for a new call." };
  if (Number(row.tries) >= MAX_TRIES) return { ok: false, error: "Too many wrong codes. Ask for a new call." };
  const want = Buffer.from(row.code_hash, "hex");
  const got = Buffer.from(hashCode(c, phone), "hex");
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
    await run("UPDATE phone_call_codes SET tries = tries + 1 WHERE id = $1", [row.id]);
    const left = MAX_TRIES - Number(row.tries) - 1;
    return { ok: false, error: left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Ask for a new call." };
  }
  const done = await one(
    "UPDATE phone_call_codes SET used_at = $2 WHERE id = $1 AND used_at = 0 RETURNING id",
    [row.id, now]
  );
  return done ? { ok: true } : { ok: false, error: "That code was already used." };
}

/** Old rows are useless after a day; the scheduler or a test may call this. */
async function prune(now = Date.now()) {
  await migrate();
  await run("DELETE FROM phone_call_codes WHERE created_at < $1", [now - 2 * DAY]);
}

const USER_TABLES = [["phone_call_codes", "user_id"]];

module.exports = {
  migrate, configured, start, check, prune, taskFor, spoken, callable, newCode,
  CallCodeError, USER_TABLES, LIMITS, TTL_MS, MAX_TRIES,
  _setDial: (fn) => { dial = fn || placeBolnaCall; },
};
