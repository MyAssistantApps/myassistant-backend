/**
 * WHO A REQUEST COUNTS AGAINST (2026-11-25, launch readiness).
 *
 * The general limiter counted per IP address alone. Indian mobile networks
 * put many phones behind one address (CGNAT), and an office or a clinic
 * shares one Wi-Fi address: about twenty open apps on one network used up
 * the address's 240 requests a minute between them, and every one of them
 * — and anyone signing up from there — was answered 429.
 *
 * A request that carries a session token WE SIGNED counts against that
 * account; everything else (sign-up, sign-in, public pages, a forged or
 * expired token) still counts against the address. Only the signature and
 * expiry are checked here — a fast, in-memory HMAC, no database — because
 * this decides a bucket, not access: the route's own auth still judges the
 * account (paused, signed out everywhere) as before. A token that does not
 * verify cannot pick its own bucket, so it cannot dodge the address limit.
 */
const jwt = require("jsonwebtoken");

/** The account a request's session token names, or null. */
function accountOf(req) {
  const h = String((req.get && req.get("authorization")) || "");
  if (!/^Bearer\s+\S/i.test(h)) return null;
  try {
    const p = jwt.verify(h.replace(/^Bearer\s+/i, "").trim(),
      require("./jwtKey").sessionKey(), { algorithms: ["HS256"] });
    // Session tokens only: a scoped token (console, connected app) keeps
    // counting against its address.
    if (p && p.scope === undefined && p.uid != null) return String(p.uid);
  } catch (_) { /* not ours, or expired */ }
  return null;
}

/** express-rate-limit keyGenerator: the account when signed in, else the address. */
function rateKey(req) {
  const uid = accountOf(req);
  return uid ? `u:${uid}` : `ip:${req.ip}`;
}

module.exports = { rateKey, accountOf };
