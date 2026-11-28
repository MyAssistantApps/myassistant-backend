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

/**
 * PUBLISHING AN APP BUILD HAS ITS OWN KEY (2026-11-28). A published build
 * installs itself on every phone, and CI has to hold the key that does it;
 * that key should not also open the admin panel with every user's data.
 * With APK_PUBLISH_KEY set (16+ characters), only it publishes and the
 * admin key no longer does. Unset, the admin key publishes as before, so
 * nothing changes until the owner sets it and updates the CI secret.
 */
function requirePublishKey(req, res, next) {
  const publish = String(process.env.APK_PUBLISH_KEY || "");
  const given = String(req.get("X-Admin-Key") || "");
  if (publish.length >= 16) {
    if (safeEqual(given, publish)) return next();
    return res.status(404).json({ error: "not found" });
  }
  return requireAdminKey(req, res, next);
}

module.exports = { requireAdminKey, requirePublishKey };
