/**
 * CASHBACK — what the phone and the affiliate network call.
 *
 *   GET  /cashback                       the user's balance, history and the
 *                                        partners that earn cashback
 *   POST /cashback/payouts { upiId }     ask for the available balance
 *
 *   GET|POST /cashback/:network/hook/:secret
 *        the affiliate network reports a purchase (new, validated or
 *        cancelled). No sign-in: the secret in the URL is the proof, and
 *        the URL does not exist while CASHBACK_HOOK_SECRET is unset. Access
 *        logs mask it (infra/observability.js redactPath, "/hook/…").
 *        Fields: service.js FIELDS (sub-id, transaction id, order amount,
 *        commission, status) under the names the network uses.
 */
const crypto = require("crypto");
const express = require("express");
const service = require("./service");

/* ---------------- the network's reports (no sign-in) ---------------- */
const hooks = express.Router();
// Networks post reports as JSON or as a form; both are read.
hooks.use(express.urlencoded({ extended: false, limit: "64kb" }));

function secretOk(given) {
  const want = service.cfg.hookSecret();
  if (want.length < 24) return false; // unset or too weak to trust with money
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function report(req, res) {
  // A wrong secret looks exactly like a URL that does not exist.
  if (!secretOk(req.params.secret)) return res.status(404).json({ error: "not found" });
  if (!service.networks().includes(String(req.params.network).toLowerCase())) {
    return res.status(404).json({ error: "not found" });
  }
  const src = { ...(req.query || {}), ...(req.body && typeof req.body === "object" ? req.body : {}) };
  try {
    const r = service.readReport(req.params.network, src);
    const out = await service.recordConversion(r);
    console.log(`cashback: ${r.network} report ${out.created ? "new" : out.changed ? "updated" : "repeat"} ` +
      `txn ${out.txn.id} ${out.txn.status}${out.txn.review ? " (review)" : ""}`);
    res.json({ ok: true, id: out.txn.id, status: out.txn.status });
  } catch (e) {
    if (e instanceof service.ReportError) return res.status(400).json({ error: e.message });
    console.error("cashback: report failed:", e.message);
    // 500 so the network retries: a purchase must not be lost to a hiccup.
    res.status(500).json({ error: "try again" });
  }
}
hooks.get("/:network/hook/:secret", report);
hooks.post("/:network/hook/:secret", report);

/* ---------------- the signed-in user ---------------- */
const router = express.Router();

const me = (req) => {
  const uid = Number(req.user?.sub);
  return Number.isInteger(uid) && uid > 0 ? uid : null;
};

router.get("/", async (req, res) => {
  const uid = me(req);
  if (!uid) return res.status(401).json({ error: "sign in required" });
  try {
    res.json(await service.summary(uid));
  } catch (e) {
    console.error("cashback: summary failed:", e.message);
    res.status(500).json({ error: "Unable to load your cashback. Please try again." });
  }
});

router.post("/payouts", async (req, res) => {
  const uid = me(req);
  if (!uid) return res.status(401).json({ error: "sign in required" });
  try {
    res.json({ payout: await service.requestPayout(uid, { upiId: req.body?.upiId }) });
  } catch (e) {
    if (e instanceof service.WithdrawError) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("cashback: payout request failed:", e.message);
    res.status(500).json({ error: "Unable to request the withdrawal. Please try again." });
  }
});

module.exports = { router, hooks, _secretOk: secretOk };
