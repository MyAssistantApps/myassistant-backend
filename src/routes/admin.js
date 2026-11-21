/**
 * ADMIN — the owner's X-Admin-Key endpoints (APK publishing). Guarded by a
 * static ADMIN_KEY; every request without the right key gets a plain 404,
 * and the router is disabled entirely when the env var is unset.
 */
const router = require("express").Router();

router.use(require("../middleware/adminKey").requireAdminKey);

// ---- APK publishing (self-hosted update channel, see routes/appUpdate.js) ----
// Usage:
//   curl -H "X-Admin-Key: $ADMIN_KEY" \
//     -F apk=@build/app/outputs/flutter-apk/app-release.apk \
//     -F versionCode=2 -F versionName=1.0.1 \
//     -F changelog="Fixed fingerprint unlock" -F changelog="Faster chat" \
//     https://backend.envisionsit.in/admin/apk
const multer = require("multer");
const os = require("os");
const appUpdate = require("./appUpdate");
const apkUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(null, file.originalname.toLowerCase().endsWith(".apk")),
});

router.post("/apk", apkUpload.single("apk"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "apk file required (field name: apk)" });
    const versionCode = parseInt(req.body.versionCode, 10);
    const versionName = String(req.body.versionName || "").trim();
    if (!Number.isInteger(versionCode) || versionCode < 1 || !versionName) {
      return res.status(400).json({ error: "versionCode (int) and versionName required" });
    }
    const changelog = [].concat(req.body.changelog || []).map(String).filter(Boolean);
    const meta = await appUpdate.publish({
      tmpPath: req.file.path,
      versionCode,
      versionName,
      changelog,
    });
    res.json({ ok: true, ...meta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
