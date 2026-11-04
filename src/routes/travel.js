/**
 * TRAVEL (2026-11-04) — the app's Flights page.
 *
 * GET /travel/flights?from=BLR&to=DEL&date=YYYY-MM-DD&adults=1&cabin=economy
 *   → { configured:false, flights:[] }            no airline API key set
 *   → { configured:true, provider, flights:[…] }  cheapest first
 *   → { configured:true, error, flights:[] }
 * Each flight: { id, airline, carrier, flight, from, to, departure, arrival,
 *   durationMin, stops, via[], price, currency, cabin }.
 * Never invented: with no provider the app says so (src/tools/flights.js).
 */
const router = require("express").Router();
const flights = require("../tools/flights");

router.get("/flights", async (req, res) => {
  const q = req.query;
  const out = await flights.list({
    from: q.from, to: q.to, date: q.date, adults: q.adults, cabin: q.cabin,
  });
  res.json(out);
});

module.exports = router;
