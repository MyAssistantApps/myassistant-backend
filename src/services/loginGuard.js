/**
 * PER-ACCOUNT PASSWORD THROTTLE (2026-11-15, security hardening).
 *
 * /auth/login and the developer console's /console/auth/password were
 * throttled per IP only, so credential stuffing spread over many addresses
 * was not slowed at all. This counts FAILED password checks per email:
 * after MAX_FAILS inside WINDOW_MS the account refuses password sign-in
 * until the window passes. A success clears the count. Google and Apple
 * sign-in are unaffected, so a locked-out owner can still get in.
 *
 * In memory, on purpose: one backend container serves production, and a
 * restart forgetting a few counters is harmless next to a database write
 * per guess. The same answer is given whether or not the account exists,
 * so the lock reveals nothing about which emails are registered.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS) > 0 ? Number(process.env.LOGIN_MAX_FAILS) : 10;

const fails = new Map(); // email -> { n, first }

const norm = (email) => String(email || "").trim().toLowerCase().slice(0, 320);

function locked(email, now = Date.now()) {
  const e = fails.get(norm(email));
  if (!e) return false;
  if (now - e.first > WINDOW_MS) {
    fails.delete(norm(email));
    return false;
  }
  return e.n >= MAX_FAILS;
}

function failed(email, now = Date.now()) {
  const k = norm(email);
  if (!k) return;
  const e = fails.get(k);
  if (!e || now - e.first > WINDOW_MS) fails.set(k, { n: 1, first: now });
  else e.n += 1;
  if (fails.size > 50_000) {
    for (const [key, v] of fails) if (now - v.first > WINDOW_MS) fails.delete(key);
  }
  if (fails.get(k).n === MAX_FAILS) {
    console.warn(`[auth] password sign-in locked for 15 minutes after ${MAX_FAILS} failures (account hash ${
      require("crypto").createHash("sha256").update(k).digest("hex").slice(0, 12)})`);
  }
}

function succeeded(email) {
  fails.delete(norm(email));
}

const LOCKED_MESSAGE =
  "Too many unsuccessful sign-in attempts for this account. Please wait 15 minutes, or sign in with Google.";

module.exports = { locked, failed, succeeded, LOCKED_MESSAGE, MAX_FAILS, _reset: () => fails.clear() };
