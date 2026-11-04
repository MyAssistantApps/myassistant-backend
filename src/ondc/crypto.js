/**
 * ONDC SIGNING (2026-11-04) — every message on the network is signed by
 * its sender and checked by its receiver.
 *
 *   digest        = base64( BLAKE2b-512( raw body bytes ) )
 *   signing string = "(created): <t>\n(expires): <t>\ndigest: BLAKE-512=<digest>"
 *   signature     = base64( Ed25519( signing string ) )
 *   Authorization: Signature keyId="<subscriber_id>|<unique_key_id>|ed25519",
 *     algorithm="ed25519",created="<t>",expires="<t>",
 *     headers="(created) (expires) digest",signature="<sig>"
 *
 * Keys are kept the way the ONDC registry wants them:
 *   signing    — Ed25519, raw base64 (private: 32-byte seed, or the 64-byte
 *                seed+public libsodium form; public: 32 bytes)
 *   encryption — X25519, base64 DER (private PKCS#8, public SPKI); used to
 *                read the registry's on_subscribe challenge.
 */
const crypto = require("crypto");

// DER prefixes that wrap a raw 32-byte key so Node's crypto accepts it.
const ED_PRIV = Buffer.from("302e020100300506032b657004220420", "hex");
const ED_PUB = Buffer.from("302a300506032b6570032100", "hex");

function edPrivateKey(b64) {
  const raw = Buffer.from(String(b64 || ""), "base64");
  if (raw.length !== 32 && raw.length !== 64) throw new Error("bad ed25519 private key");
  return crypto.createPrivateKey({
    key: Buffer.concat([ED_PRIV, raw.subarray(0, 32)]), format: "der", type: "pkcs8",
  });
}

function edPublicKey(b64) {
  const raw = Buffer.from(String(b64 || ""), "base64");
  if (raw.length !== 32) throw new Error("bad ed25519 public key");
  return crypto.createPublicKey({ key: Buffer.concat([ED_PUB, raw]), format: "der", type: "spki" });
}

function digest(body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return crypto.createHash("blake2b512").update(buf).digest("base64");
}

function signingString(created, expires, d) {
  return `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${d}`;
}

/** Sign [message] (string) with the base64 Ed25519 private key. */
function sign(message, privateB64) {
  return crypto.sign(null, Buffer.from(message), edPrivateKey(privateB64)).toString("base64");
}

function verify(message, signatureB64, publicB64) {
  try {
    return crypto.verify(null, Buffer.from(message), edPublicKey(publicB64),
      Buffer.from(String(signatureB64 || ""), "base64"));
  } catch (_) {
    return false;
  }
}

/** The Authorization header for [body] (the exact bytes that are sent). */
function authHeader(body, { subscriberId, ukId, privateKey, ttlSec = 300, now = Date.now() }) {
  const created = Math.floor(now / 1000);
  const expires = created + ttlSec;
  const sig = sign(signingString(created, expires, digest(body)), privateKey);
  return `Signature keyId="${subscriberId}|${ukId}|ed25519",algorithm="ed25519",` +
    `created="${created}",expires="${expires}",headers="(created) (expires) digest",` +
    `signature="${sig}"`;
}

/** Authorization header → its fields, or null when it is not one. */
function parseAuthHeader(h) {
  const s = String(h || "").replace(/^Signature\s+/i, "");
  const out = {};
  for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  if (!out.keyId || !out.signature || !out.created || !out.expires) return null;
  const [subscriberId, ukId, alg] = out.keyId.split("|");
  return { ...out, subscriberId, ukId, alg };
}

/**
 * Check a received body against its Authorization header and the
 * sender's registered public key. Returns { ok, reason }.
 */
function verifyAuth(body, header, publicB64, { now = Date.now(), skewSec = 60 } = {}) {
  const a = parseAuthHeader(header);
  if (!a) return { ok: false, reason: "no signature" };
  const t = Math.floor(now / 1000);
  if (Number(a.created) > t + skewSec) return { ok: false, reason: "created in the future" };
  if (Number(a.expires) < t - skewSec) return { ok: false, reason: "expired" };
  const msg = signingString(a.created, a.expires, digest(body));
  return verify(msg, a.signature, publicB64) ? { ok: true } : { ok: false, reason: "bad signature" };
}

/** Fresh keys for registering with ONDC (scripts/ondc-keys.js). */
function generateKeys() {
  const ed = crypto.generateKeyPairSync("ed25519");
  const edPriv = ed.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const edPub = ed.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const x = crypto.generateKeyPairSync("x25519");
  return {
    signingPrivateKey: Buffer.concat([edPriv, edPub]).toString("base64"),
    signingPublicKey: edPub.toString("base64"),
    encryptionPrivateKey: x.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    encryptionPublicKey: x.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/**
 * The registry's on_subscribe challenge: AES-256-ECB with the X25519
 * shared secret between our encryption key and ONDC's public key.
 */
function decryptChallenge(challengeB64, ondcPublicDerB64, ourPrivateDerB64) {
  const priv = crypto.createPrivateKey({
    key: Buffer.from(ourPrivateDerB64, "base64"), format: "der", type: "pkcs8",
  });
  const pub = crypto.createPublicKey({
    key: Buffer.from(ondcPublicDerB64, "base64"), format: "der", type: "spki",
  });
  const secret = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  const d = crypto.createDecipheriv("aes-256-ecb", secret, null);
  return Buffer.concat([d.update(Buffer.from(challengeB64, "base64")), d.final()]).toString("utf8");
}

module.exports = {
  digest, signingString, sign, verify, authHeader, parseAuthHeader, verifyAuth,
  generateKeys, decryptChallenge,
};
