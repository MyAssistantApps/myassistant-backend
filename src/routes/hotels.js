/**
 * THE APP'S HOTEL PRICES (2026-11-24): GET /hotels/search — real Google
 * Hotels results (src/tools/hotels.js). Without a SerpApi key it answers
 * {ok:false, configured:false}.
 */
const express = require("express");
const hotels = require("../tools/hotels");

const router = express.Router();

router.get("/search", async (req, res) => {
  const q = req.query || {};
  res.json(await hotels.searchForApp({ q: q.q, checkIn: q.checkIn, checkOut: q.checkOut, adults: q.adults }));
});

module.exports = router;
