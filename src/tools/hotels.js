/**
 * HOTEL PRICES (2026-11-24) — real Google Hotels results through SerpApi
 * (the same SERPAPI_KEY as flights), for the app's Hotels screen.
 *
 * Never invented: a hotel with no price is left out. Each search is kept
 * 20 minutes in the shared search cache, so a popular city and date costs
 * one search, not one per user (the plan has a monthly quota).
 * Without a key: {ok:false, configured:false}, and the app keeps opening
 * the booking sites as before.
 */

/** One SerpApi Google Hotels answer as the app's list. Pure, for tests. */
function toAppJson(j) {
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const hotels = (j?.properties || [])
    .map((p) => {
      const night = num(p.rate_per_night?.extracted_lowest);
      if (!p.name || !night) return null;
      const sites = (p.prices || [])
        .map((x) => ({ source: String(x.source || "").trim(), pricePerNight: num(x.rate_per_night?.extracted_lowest) }))
        .filter((x) => x.source && x.pricePerNight)
        .sort((a, b) => a.pricePerNight - b.pricePerNight)
        .slice(0, 4);
      const img = (p.images || [])[0] || {};
      const photo = String(img.original_image || img.thumbnail || "");
      return {
        name: String(p.name),
        type: String(p.type || ""),
        stars: num(p.extracted_hotel_class),
        rating: num(p.overall_rating),
        reviews: num(p.reviews),
        pricePerNight: night,
        total: num(p.total_rate?.extracted_lowest),
        image: photo.startsWith("https://") ? photo : "",
        link: String(p.link || "").startsWith("https://") ? String(p.link) : "",
        amenities: (p.amenities || []).slice(0, 4).map(String),
        sites,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.pricePerNight - b.pricePerNight)
    .slice(0, 20);
  return { ok: true, provider: "google_hotels", live: true, hotels };
}

async function searchForApp({ q, checkIn, checkOut, adults = 2 }) {
  if (!process.env.SERPAPI_KEY) return { ok: false, configured: false, error: "Hotel prices are not configured on the server." };
  const place = String(q || "").trim().slice(0, 80);
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!place) return { ok: false, error: "Enter a city, area or hotel." };
  if (!iso.test(String(checkIn || "")) || !iso.test(String(checkOut || "")) || checkOut <= checkIn) {
    return { ok: false, error: "Choose check-in and check-out dates." };
  }
  const a = Math.min(Math.max(Number(adults) || 2, 1), 12);
  const cache = require("./searchCache");
  const shape = `hotels|${place.toLowerCase()}|${checkIn}|${checkOut}|${a}`;
  const hit = await cache.get(shape);
  if (hit) return hit;
  const u = new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine", "google_hotels");
  u.searchParams.set("q", place);
  u.searchParams.set("check_in_date", checkIn);
  u.searchParams.set("check_out_date", checkOut);
  u.searchParams.set("adults", String(a));
  u.searchParams.set("currency", "INR");
  u.searchParams.set("gl", "in");
  u.searchParams.set("hl", "en");
  u.searchParams.set("api_key", process.env.SERPAPI_KEY);
  let j;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(25_000) });
    j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      if (/no results|hasn't returned any results/i.test(String(j.error || ""))) {
        return { ok: true, provider: "google_hotels", live: true, hotels: [] };
      }
      return { ok: false, error: `The hotel search did not answer (${r.status}). Please try again.` };
    }
  } catch (_) {
    return { ok: false, error: "The hotel search timed out. Please try again." };
  }
  const out = toAppJson(j);
  await cache.put(shape, `${place} ${checkIn}..${checkOut}`, out, true);
  return out;
}

module.exports = { searchForApp, toAppJson };
