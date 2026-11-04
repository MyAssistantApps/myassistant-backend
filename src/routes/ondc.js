/**
 * ONDC CALLBACKS (2026-11-04) — public; the network calls these.
 *
 *   POST /ondc/on_subscribe      the registry's challenge while registering
 *   POST /ondc/on_<action>       sellers' answers: on_search, on_select,
 *                                on_init, on_confirm, on_status, on_track,
 *                                on_cancel, on_update, on_support
 *   GET  /ondc-site-verification.html   (mounted at the site root)
 *
 * Every answer is checked against its sender's registered key (unless
 * ONDC_VERIFY_CALLBACKS=off while testing), stored, and acknowledged at
 * once — the network expects an ACK within seconds, the app reads later.
 */
const router = require("express").Router();
const { cfg } = require("../ondc/config");
const crypto = require("../ondc/crypto");
const registry = require("../ondc/registry");
const store = require("../ondc/store");

const ACK = { message: { ack: { status: "ACK" } } };
const nack = (msg) => ({ message: { ack: { status: "NACK" } }, error: { type: "CONTEXT-ERROR", message: msg } });

router.post("/on_subscribe", (req, res) => {
  const c = cfg();
  try {
    const answer = crypto.decryptChallenge(
      req.body?.challenge, c.registryPublicKey, c.encryptionPrivateKey);
    res.json({ answer });
  } catch (e) {
    console.error("ondc on_subscribe:", e.message);
    res.status(400).json(nack("could not read the challenge"));
  }
});

const CALLBACKS = new Set([
  "on_search", "on_select", "on_init", "on_confirm", "on_status",
  "on_track", "on_cancel", "on_update", "on_support", "on_rating",
]);

router.post("/:action", async (req, res) => {
  const action = req.params.action;
  if (!CALLBACKS.has(action)) return res.status(404).json(nack("unknown action"));
  const body = req.body || {};
  if (body.context?.action !== action || !body.context?.transaction_id) {
    return res.status(400).json(nack("context does not match"));
  }
  if (cfg().verifyCallbacks) {
    const a = crypto.parseAuthHeader(req.get("authorization"));
    const pub = a && (await registry.publicKeyOf(a.subscriberId, a.ukId).catch(() => null));
    const v = pub ? crypto.verifyAuth(req.rawBody || JSON.stringify(body), req.get("authorization"), pub)
      : { ok: false, reason: "unknown sender" };
    if (!v.ok) return res.status(401).json(nack(`signature: ${v.reason}`));
  }
  // Only answers to transactions we started are kept.
  const sent = body.context.message_id ? await store.requestOf(body.context.message_id).catch(() => null) : null;
  const ours = sent || (await store.responses(body.context.transaction_id, "on_search").catch(() => [])).length
    || action === "on_search" || action === "on_status" || action === "on_update";
  if (!ours) return res.status(400).json(nack("unknown transaction"));
  await store.saveResponse(body).catch((e) => console.error("ondc store:", e.message));
  res.json(ACK);
});

/** https://<subscriber_id>/ondc-site-verification.html */
function siteVerification(_req, res) {
  const c = cfg();
  const id = process.env.ONDC_REQUEST_ID || "";
  if (!id || !c.signingPrivateKey) return res.status(404).send("not configured");
  const signed = crypto.sign(id, c.signingPrivateKey);
  res.type("html").send(
    `<html><head><meta name='ondc-site-verification' content='${signed}' /></head>` +
    `<body>ONDC Site Verification Page</body></html>`);
}

module.exports = { router, siteVerification };
