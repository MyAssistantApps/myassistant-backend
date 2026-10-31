/**
 * /ui — the phone's side of the UI spec (2026-10-31).
 *
 *   GET  /ui/spec    the person's current spec, custom cards filled in.
 *                    Read at sign-in, so a reinstall gets their look back.
 *   POST /ui/undo    the previous look (Settings → Appearance)
 *   POST /ui/reset   the app's own look again (always there, whatever was
 *                    designed — the way out of a look nobody can read)
 */
const express = require("express");
const store = require("./store");
const cards = require("./cards");

const router = express.Router();

function userOf(req, res) {
  const id = Number(req.user && req.user.sub);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  return id;
}
const tzOf = (req) => {
  const n = Number(req.query.tz);
  return Number.isFinite(n) ? n : 330;
};

async function withCards(uid, spec, req) {
  return { spec, cards: await cards.fill(uid, spec.customCards, { tzOffsetMin: tzOf(req) }) };
}

router.get("/spec", async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  try {
    res.json(await withCards(uid, await store.get(uid), req));
  } catch (e) {
    console.error("ui: spec failed:", e.message);
    res.status(500).json({ error: "could not load the design" });
  }
});

router.post("/undo", async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  const spec = await store.undo(uid);
  if (!spec) return res.status(409).json({ error: "nothing to undo" });
  cards.forget(uid);
  res.json(await withCards(uid, spec, req));
});

router.post("/reset", async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  const spec = await store.reset(uid);
  cards.forget(uid);
  res.json(await withCards(uid, spec, req));
});

module.exports = router;
