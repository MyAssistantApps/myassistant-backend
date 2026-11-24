/**
 * THE APP'S FLIGHT SEARCH (2026-11-24): GET /flights/search — real Google
 * Flights results (src/tools/flights.js searchForApp), in the JSON the
 * app's flight results list reads. Without a SerpApi key it answers
 * {ok:false, configured:false} and the app labels its own fares estimates.
 */
const express = require("express");
const flights = require("../tools/flights");

const router = express.Router();

router.get("/search", async (req, res) => {
  const q = req.query || {};
  const out = await flights.searchForApp({
    from: q.from,
    to: q.to,
    date: q.date,
    adults: q.adults,
    children: q.children,
    infants: q.infants,
    cabin: q.cabin,
    nonStop: q.nonStop === "1" || q.nonStop === "true",
  });
  res.json(out);
});

module.exports = router;
