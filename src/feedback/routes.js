/**
 * FEEDBACK FROM THE APP (2026-11-21): the You tab's "Help & Feedback" and
 * the Pro early-access list write here, into the same Feedback inbox the
 * admin panel already shows (store.add: one row per summary per day,
 * DAILY_CAP per user).
 */
const express = require("express");
const store = require("./store");

const router = express.Router();

router.post("/", async (req, res) => {
  const uid = Number(req.user?.sub);
  if (!uid) return res.status(401).json({ error: "Please sign in." });
  const b = req.body || {};
  const r = await store.add(uid, {
    kind: String(b.kind || "improvement"),
    summary: b.summary,
    details: b.details,
    userWords: b.summary,
    source: b.source === "premium" ? "premium" : "app",
    appBuild: Number(b.appBuild) || Number(req.get("X-App-Build")) || 0,
    userAsked: true,
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) return res.status(400).json({ error: r.error === "daily feedback limit reached"
    ? "Daily limit reached. Please try again tomorrow." : "Please describe the issue." });
  res.json({ ok: true, id: Number(r.id) });
});

module.exports = router;
