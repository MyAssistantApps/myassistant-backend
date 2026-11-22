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
    for (const k of ["daily_left_paise", "cap_left_paise"]) if (e[k] != null) body[k] = e[k];
    return res.status(e.status || 400).json(body);
  }
  console.error(`wallet ${where} error:`, e.message || e);
  return res.status(500).json({ error: "server_error", message: "Something went wrong. Please try again." });
}

router.get("/", async (req, res) => {
  try {
    res.json(await service.summary(req.user.sub));
  } catch (e) {
    fail(res, e, "summary");
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
