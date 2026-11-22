/**
 * GET /go           → { merchants:[{id,name,category,color,earns}] }
 * GET /go/:id[?url=] → { url, tracked } — the partner link (or a search on its
 *                     own site) with our tracking,
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

/**
 * A RIDE, READY TO CONFIRM (owner, 2026-11-21). Tapping Uber or Ola on
 * Home asks "Where to?"; this resolves the destination to real coordinates
 * and returns the provider's documented link with pickup (the phone's
 * location) and drop-off filled in, so the rider only picks the car and
 * confirms. Uber and Ola publish no open booking API (Uber's is
 * partner-gated), so their own confirm screen is the honest end point.
 * body: { provider: "uber"|"ola", destination }
 */
router.post("/ride", async (req, res) => {
  const provider = req.body?.provider === "ola" ? "ola" : "uber";
  const destination = String(req.body?.destination || "").trim().slice(0, 200);
  if (!destination) return res.status(400).json({ error: "Please say where you want to go." });
  const lat = Number(req.get("X-Geo-Lat"));
  const lng = Number(req.get("X-Geo-Lng"));
  const here = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
  let place = null;
  try {
    place = await require("../fulfillment/service").resolveBusiness({
      query: destination, lat: here ? lat : undefined, lng: here ? lng : undefined,
    });
  } catch { /* no places key or no match: Uber searches the address itself */ }
  const hasPlace = place && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng));
  const name = (hasPlace && place.name) || destination;
  const link = require("../fulfillment/deeplinks").ride({
    provider,
    destination: name,
    lat: hasPlace ? place.lat : null,
    lng: hasPlace ? place.lng : null,
    pickupLat: here ? lat : null,
    pickupLng: here ? lng : null,
    platform: "web", // a plain https link: Android opens the app when installed
  });
  res.json({
    url: link.url,
    precision: link.precision,
    destination: name,
    address: (hasPlace && (place.address || place.vicinity)) || "",
  });
});

router.get("/:id", async (req, res) => {
  const merchant = m.BY_ID.get(String(req.params.id));
  if (!merchant) return res.status(404).json({ error: "unknown partner" });
  // ?url= a search on the partner's own site (same host only).
  const out = m.trackedUrl(merchant, req.query.url);
  const uid = Number(req.user?.sub);
  migrate().then(() => require("../db").run(
    "INSERT INTO affiliate_clicks (user_id, merchant, tracked, created_at) VALUES ($1,$2,$3,$4)",
    [Number.isInteger(uid) && uid > 0 ? uid : null, merchant.id, out.tracked, Date.now()]))
    .catch(() => {});
  res.json(out);
});

module.exports = router;
// The erase suite's schema guard creates every table before it looks.
module.exports.migrate = migrate;
