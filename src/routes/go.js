/**
 * GET /go           → { merchants:[{id,name,category,color,earns}] }
 * GET /go/:id       → { url, tracked } — the partner link with our tracking,
 *                     and the click counted (affiliate_clicks).
 * Only known partners: an unknown id is a 404, never a redirect.
 */
const router = require("express").Router();
const m = require("../affiliate/merchants");

let ready = null;
function migrate() {
  if (!ready) {
    const { run } = require("../db");
    ready = run(`CREATE TABLE IF NOT EXISTS affiliate_clicks (
      id BIGSERIAL PRIMARY KEY, user_id INTEGER, merchant TEXT NOT NULL,
      tracked BOOLEAN NOT NULL, created_at BIGINT NOT NULL)`)
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

router.get("/", (_req, res) => res.json({ merchants: m.catalogue() }));

router.get("/:id", async (req, res) => {
  const merchant = m.BY_ID.get(String(req.params.id));
  if (!merchant) return res.status(404).json({ error: "unknown partner" });
  const out = m.trackedUrl(merchant);
  const uid = Number(req.user?.sub);
  migrate().then(() => require("../db").run(
    "INSERT INTO affiliate_clicks (user_id, merchant, tracked, created_at) VALUES ($1,$2,$3,$4)",
    [Number.isInteger(uid) && uid > 0 ? uid : null, merchant.id, out.tracked, Date.now()]))
    .catch(() => {});
  res.json(out);
});

module.exports = router;
