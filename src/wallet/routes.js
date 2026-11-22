/**
 * WALLET API (Phase 1) — mounted at /wallet behind appAuth (server.js).
 *
 *   GET  /wallet                    balances + what can be added now
 *   GET  /wallet/transactions       history, newest first (cursor paging)
 *   POST /wallet/topups             start a top-up → a Razorpay order
 *                                   (Idempotency-Key header required)
 *   POST /wallet/topups/:id/verify  Checkout's result → verified, credited
 *   GET  /wallet/topups/:id         a top-up's state (the app polls it)
 *
 * Amounts are integer paise both ways. The app never sends an amount to
 * CREDIT — only the amount it wants to pay, which becomes the order.
 */
const express = require("express");
const rateLimit = require("express-rate-limit");
const service = require("./service");
const store = require("./store");
const security = require("./security");

const router = express.Router();

const byUser = (req) => String(req.user?.sub || req.ip);

/** Everything under /wallet: 60 requests a minute per user. */
router.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, keyGenerator: byUser }));

/** Starting top-ups: 10 an hour per user — far above honest use. */
const topupLimit = rateLimit({
  windowMs: 3_600_000,
  max: 10,
  standardHeaders: true,
  keyGenerator: byUser,
  message: { error: "too_many_requests", message: "Too many attempts. Please wait a little and try again." },
});

/** Verifying: 30 an hour per user. */
const verifyLimit = rateLimit({
  windowMs: 3_600_000,
  max: 30,
  standardHeaders: true,
  keyGenerator: byUser,
  message: { error: "too_many_requests", message: "Too many attempts. Please wait a little and try again." },
});

/** Sends a WalletError as { error, message } with its status; anything else is a plain 500. */
function fail(res, e, where) {
  if (e instanceof service.WalletError) {
    const body = { error: e.code, message: e.message };
    for (const k of ["daily_left_paise", "cap_left_paise", "refundable_paise", "needed_paise", "transaction_id"]) {
      if (e[k] != null) body[k] = e[k];
    }
    return res.status(e.status || 400).json(body);
  }
  console.error(`wallet ${where} error:`, e.message || e);
  return res.status(500).json({ error: "server_error", message: "Something went wrong. Please try again." });
}

/**
 * THE STAGED LAUNCH (security.allowed): until the wallet is on for this
 * account, GET /wallet says so (the app hides the wallet) and everything
 * else refuses.
 */
router.use((req, res, next) => {
  if (security.allowed(req.user?.sub)) return next();
  if (req.method === "GET" && req.path === "/") return res.json({ available: false });
  return res.status(403).json({ error: "not_available", message: "The wallet is not available yet." });
});

router.get("/", async (req, res) => {
  try {
    res.json({
      available: true,
      ...(await service.summary(req.user.sub)),
      has_pin: await security.hasPin(req.user.sub),
      step_up_above_paise: security.stepUpThreshold(),
    });
  } catch (e) {
    fail(res, e, "summary");
  }
});

/* ---------------- PIN and step-up ---------------- */

const pinLimit = rateLimit({
  windowMs: 15 * 60_000, max: 20, standardHeaders: true, keyGenerator: byUser,
  message: { error: "too_many_requests", message: "Too many attempts. Please wait a little and try again." },
});

router.post("/pin", pinLimit, async (req, res) => {
  try {
    const problem = await security.setPin(req.user.sub, req.body?.pin, req.body?.current_pin);
    if (problem) return res.status(400).json({ error: "pin_rejected", message: problem });
    require("../audit/log").record(req.user.sub, "wallet.pin.set", "Wallet PIN set").catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    fail(res, e, "pin");
  }
});

router.post("/step-up", pinLimit, async (req, res) => {
  try {
    const r = await security.verifyPin(req.user.sub, req.body?.pin);
    if (!r.ok) return res.status(r.code === "pin_locked" ? 429 : 401).json({ error: r.code, message: r.message });
    res.json({ step_up_token: security.issueStepUp(req.user.sub), expires_in: security.STEP_UP_SECONDS });
  } catch (e) {
    fail(res, e, "step-up");
  }
});

/* ---------------- Spending ---------------- */

const spendLimit = rateLimit({
  windowMs: 3_600_000, max: 30, standardHeaders: true, keyGenerator: byUser,
  message: { error: "too_many_requests", message: "Too many payments. Please wait a little and try again." },
});

router.post("/spend", spendLimit, async (req, res) => {
  try {
    res.json(await require("./spend").spend(req.user, req.body || {}, req.get("X-Wallet-Step-Up") || ""));
  } catch (e) {
    fail(res, e, "spend");
  }
});

/* ---------------- Refunds ---------------- */

router.get("/refundable", async (req, res) => {
  try {
    const r = await require("./refunds").refundable(req.user.sub);
    res.json({ refundable_paise: r.refundable_paise });
  } catch (e) {
    fail(res, e, "refundable");
  }
});

router.get("/refunds", async (req, res) => {
  try {
    res.json({ items: await require("./refunds").list(req.user.sub) });
  } catch (e) {
    fail(res, e, "refunds");
  }
});

router.post("/refunds", topupLimit, async (req, res) => {
  try {
    res.status(201).json(await require("./refunds").requestRefund(req.user, req.body?.amount_paise, {
      stepUpToken: req.get("X-Wallet-Step-Up") || "", key: req.get("Idempotency-Key") || "",
    }));
  } catch (e) {
    fail(res, e, "refund");
  }
});

router.get("/transactions", async (req, res) => {
  try {
    res.json(await store.history(req.user.sub, { cursor: req.query.cursor, limit: req.query.limit }));
  } catch (e) {
    fail(res, e, "history");
  }
});

router.post("/topups", topupLimit, async (req, res) => {
  try {
    const out = await service.createTopup(req.user, req.body?.amount_paise, req.get("Idempotency-Key"));
    res.status(201).json(out);
  } catch (e) {
    fail(res, e, "topup");
  }
});

router.post("/topups/:id/verify", verifyLimit, async (req, res) => {
  try {
    res.json(await service.verifyTopup(req.user.sub, req.params.id, req.body || {}));
  } catch (e) {
    fail(res, e, "verify");
  }
});

router.get("/topups/:id", async (req, res) => {
  try {
    res.json(service.topupView(await service.getTopup(req.user.sub, req.params.id)));
  } catch (e) {
    fail(res, e, "topup status");
  }
});

module.exports = router;
