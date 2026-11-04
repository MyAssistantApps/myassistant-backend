/**
 * WHO SENT THIS? — the ONDC registry knows every participant's public
 * signing key. Looked up once per sender and key, kept for an hour.
 */
const { cfg } = require("./config");
const crypto = require("./crypto");

const TTL_MS = 60 * 60 * 1000;
const cache = new Map();

async function publicKeyOf(subscriberId, ukId) {
  const key = `${subscriberId}|${ukId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.pub;
  const c = cfg();
  const body = JSON.stringify({ subscriber_id: subscriberId, ukId });
  const headers = { "content-type": "application/json" };
  // The v2 lookup is itself signed; v1 is open on some environments.
  if (c.signingPrivateKey) {
    headers.authorization = crypto.authHeader(body, {
      subscriberId: c.subscriberId, ukId: c.ukId, privateKey: c.signingPrivateKey,
    });
  }
  let rows = null;
  for (const path of ["/v2.0/lookup", "/lookup"]) {
    try {
      const r = await fetch(c.registryUrl + path, {
        method: "POST", headers, body, signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      rows = await r.json();
      if (Array.isArray(rows) && rows.length) break;
    } catch (_) {}
  }
  const pub = Array.isArray(rows) && rows[0] ? rows[0].signing_public_key : null;
  if (pub) cache.set(key, { at: Date.now(), pub });
  return pub;
}

module.exports = { publicKeyOf, _cache: cache };
