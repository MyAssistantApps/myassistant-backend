/**
 * JYOTISH — the Vedic horoscope (Home's last card in the app): birth
 * details from a chat, a local sidereal chart (engine.js), and readings
 * written by the model from that chart's data only. Wiring:
 *
 *   app.use("/jyotish", appAuth, jyotish.limiter, jyotish.router);
 *   ...jyotish.USER_TABLES                              // privacy export / erase
 *
 * Two per-user buckets: everything (JYOTISH_RATE_PER_MIN, 120), and the
 * model calls — /extract and /predict — on their own (JYOTISH_AI_RATE_PER_MIN, 15).
 */
const rateLimit = require("express-rate-limit");
const routes = require("./routes");
const { migrate, USER_TABLES } = require("./store");

const keyGenerator = (req) => String(req.user?.sub || req.ip);
const tooMany = (req, res) => res.status(429).json({ ok: false, error: "rate_limited", message: "Too many requests. Please wait a moment and try again." });

const general = rateLimit({
  windowMs: 60_000, max: Number(process.env.JYOTISH_RATE_PER_MIN) || 120,
  standardHeaders: true, keyGenerator, handler: tooMany,
});
const aiLimit = rateLimit({
  windowMs: 60_000, max: Number(process.env.JYOTISH_AI_RATE_PER_MIN) || 15,
  standardHeaders: true, keyGenerator, handler: tooMany,
});

function limiter(req, res, next) {
  general(req, res, (err) => {
    if (err) return next(err);
    if (req.method === "POST" && (req.path === "/extract" || req.path === "/predict")) return aiLimit(req, res, next);
    next();
  });
}

module.exports = { router: routes, limiter, migrate, USER_TABLES };
