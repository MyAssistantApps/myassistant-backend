/**
 * SENDING ON THE NETWORK (2026-11-04). Builds the ONDC context, signs the
 * exact bytes, posts to the gateway (search) or to the seller's app
 * (everything after search), and records what was sent. The answer
 * arrives later on our callback (src/routes/ondc.js).
 */
const { randomUUID } = require("crypto");
const { cfg, configured } = require("./config");
const crypto = require("./crypto");
const store = require("./store");

function context(action, { domain, transactionId, bppId, bppUri, city = "*" }) {
  const c = cfg();
  return {
    domain,
    country: c.country,
    city,
    action,
    core_version: c.coreVersion,
    bap_id: c.subscriberId,
    bap_uri: c.subscriberUrl,
    ...(bppId ? { bpp_id: bppId, bpp_uri: bppUri } : {}),
    transaction_id: transactionId || randomUUID(),
    message_id: randomUUID(),
    timestamp: new Date().toISOString(),
    ttl: "PT30S",
  };
}

/**
 * Send one action. Search goes to the gateway; the rest to [bppUri].
 * @returns {{ ok, transactionId, messageId, error? }}
 */
async function send(action, { domain, transactionId, bppId, bppUri, city, message, userId }) {
  if (!configured()) return { ok: false, error: "ONDC is not connected yet" };
  const c = cfg();
  const ctx = context(action, { domain, transactionId, bppId, bppUri, city });
  const body = JSON.stringify({ context: ctx, message });
  const target = action === "search"
    ? c.gatewayUrl.replace(/\/?$/, "/") + "search"
    : String(bppUri || "").replace(/\/+$/, "") + "/" + action;
  let ack = "NACK";
  let error = null;
  try {
    const r = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: crypto.authHeader(body, {
          subscriberId: c.subscriberId, ukId: c.ukId, privateKey: c.signingPrivateKey,
        }),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json().catch(() => ({}));
    ack = j?.message?.ack?.status || (r.ok ? "ACK" : "NACK");
    if (ack !== "ACK") error = j?.error?.message || `${action} refused (${r.status})`;
  } catch (e) {
    error = `${action} failed: ${String(e.message).slice(0, 100)}`;
  }
  await store.saveRequest({
    messageId: ctx.message_id, transactionId: ctx.transaction_id, userId, action,
    bppId, bppUri, payload: JSON.parse(body), ack,
  }).catch(() => {});
  return { ok: ack === "ACK", transactionId: ctx.transaction_id, messageId: ctx.message_id, error };
}

module.exports = { send, context };
