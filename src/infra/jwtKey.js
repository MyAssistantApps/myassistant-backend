/**
 * THE SESSION SECRET AS A KeyObject, made once.
 *
 * jsonwebtoken 9 turns a string secret into a KeyObject on EVERY verify —
 * first trying it as a PEM public key (createPublicKey), catching the
 * failure, then createSecretKey. That throw-and-catch was the single
 * largest JavaScript cost of an authenticated request under load
 * (2026-11-20 CPU profile, ~2% of all samples in the request mix).
 * Passing a ready KeyObject skips both. Keyed by the secret's value, so a
 * test (or a rotation) that changes JWT_SECRET gets a fresh key.
 */
const crypto = require("crypto");

let cached = { secret: null, key: null };

function sessionKey() {
  const secret = process.env.JWT_SECRET || "";
  if (cached.secret !== secret) cached = { secret, key: crypto.createSecretKey(Buffer.from(secret, "utf8")) };
  return cached.key;
}

module.exports = { sessionKey };
