/**
 * X-Admin-Key gate for server-to-server/admin routes: the key must be set
 * (16+ characters) and match, compared in constant time. Anything else is a
 * plain 404 — the route is not advertised to the curious.
 */
const { safeEqual } = require("../services/safeCompare");

function requireAdminKey(req, res, next) {
  const key = String(process.env.ADMIN_KEY || "");
  if (key.length >= 16 && safeEqual(String(req.get("X-Admin-Key") || ""), key)) return next();
  return res.status(404).json({ error: "not found" });
}

module.exports = { requireAdminKey };
