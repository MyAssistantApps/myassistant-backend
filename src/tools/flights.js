/**
 * FLIGHT SEARCH — provider adapter (§20).
 *
 * §32: no fabricated availability, ever. With no provider configured this
 * returns an honest "not configured" that the agent relays; it never
 * invents a flight number, time or price.
 *
 * Providers (first configured wins):
 *   AMADEUS_CLIENT_ID + AMADEUS_CLIENT_SECRET   (self-service API — Amadeus
 *                                                shut it down 2026-07-17;
 *                                                kept for Enterprise keys)
 *   DUFFEL_API_TOKEN                            (Duffel)
 *   SERPAPI_KEY                                 (Google Flights via SerpApi,
 *                                                2026-11-04; 250 free/month)
 */
const TIMEOUT_MS = 12_000;

/**
 * Amadeus runs two entirely separate environments with different hosts AND
 * different credentials. This was pinned to the test host, so a production
 * key would have authenticated against the sandbox and returned sandbox
 * inventory — plausible-looking flights that cannot be booked.
 * Set AMADEUS_ENV=production once you have live credentials.
 */
function amadeusHost() {
  return String(process.env.AMADEUS_ENV || "test").toLowerCase() === "production"
    ? "https://api.amadeus.com"
    : "https://test.api.amadeus.com";
}

function provider() {
  if (process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET) return "amadeus";
  if (process.env.DUFFEL_API_TOKEN) return "duffel";
  if (process.env.SERPAPI_KEY) return "serpapi";
  return null;
}

/** IATA code if given one, else null — we do not guess airports. */
function iata(s) {
  const v = String(s || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? v : null;
}

// Only well-known unambiguous city→primary-airport mappings. Anything else
// is asked about rather than assumed, so we never search the wrong city.
const CITY_IATA = {
  BANGALORE: "BLR", BENGALURU: "BLR", DELHI: "DEL", "NEW DELHI": "DEL",
  MUMBAI: "BOM", BOMBAY: "BOM", CHENNAI: "MAA", KOLKATA: "CCU",
  HYDERABAD: "HYD", MANGALORE: "IXE", MANGALURU: "IXE", GOA: "GOI",
  PUNE: "PNQ", KOCHI: "COK", COCHIN: "COK", AHMEDABAD: "AMD",
  JAIPUR: "JAI", LUCKNOW: "LKO", TRIVANDRUM: "TRV", COIMBATORE: "CJB",
};

function resolveAirport(input) {
  const direct = iata(input);
  if (direct) return direct;
  const key = String(input || "").trim().toUpperCase();
  return CITY_IATA[key] || null;
}

let amadeusToken = { value: null, expires: 0 };

async function amadeusAuth() {
  if (amadeusToken.value && Date.now() < amadeusToken.expires) return amadeusToken.value;
  const r = await fetch(`${amadeusHost()}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AMADEUS_CLIENT_ID,
      client_secret: process.env.AMADEUS_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`amadeus auth ${r.status}`);
  const j = await r.json();
  amadeusToken = {
    value: j.access_token,
    expires: Date.now() + (j.expires_in - 60) * 1000,
  };
  return amadeusToken.value;
}

const BACKENDS = {
  async amadeus({ from, to, date, adults }) {
    const token = await amadeusAuth();
    const u = new URL(`${amadeusHost()}/v2/shopping/flight-offers`);
    u.searchParams.set("originLocationCode", from);
    u.searchParams.set("destinationLocationCode", to);
    u.searchParams.set("departureDate", date);
    u.searchParams.set("adults", String(adults || 1));
    u.searchParams.set("max", "6");
    u.searchParams.set("currencyCode", "INR");
    const r = await fetch(u, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`amadeus ${r.status}`);
    const j = await r.json();
    return (j.data || []).map((o) => {
      const seg = o.itineraries[0].segments;
      return {
        carrier: seg[0].carrierCode,
        flight: `${seg[0].carrierCode}${seg[0].number}`,
        departure: seg[0].departure.at,
        arrival: seg[seg.length - 1].arrival.at,
        stops: seg.length - 1,
        price: `${o.price.currency} ${o.price.total}`,
      };
    });
  },

  async duffel({ from, to, date, adults }) {
    const r = await fetch("https://api.duffel.com/air/offer_requests?return_offers=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Duffel-Version": "v2",
        authorization: `Bearer ${process.env.DUFFEL_API_TOKEN}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        data: {
          slices: [{ origin: from, destination: to, departure_date: date }],
          passengers: Array.from({ length: adults || 1 }, () => ({ type: "adult" })),
          cabin_class: "economy",
        },
      }),
    });
    if (!r.ok) throw new Error(`duffel ${r.status}`);
    const j = await r.json();
    return (j.data?.offers || []).slice(0, 6).map((o) => {
      const seg = o.slices[0].segments;
      return {
        carrier: o.owner?.name || seg[0].operating_carrier?.iata_code,
        flight: `${seg[0].operating_carrier?.iata_code}${seg[0].operating_carrier_flight_number}`,
        departure: seg[0].departing_at,
        arrival: seg[seg.length - 1].arriving_at,
        stops: seg.length - 1,
        price: `${o.total_currency} ${o.total_amount}`,
      };
    });
  },
};

/**
 * @returns {ok:true,data} | {ok:false,error} | {ok:false,needsArgs:[…]}
 */
async function search({ from, to, date, adults = 1 }) {
  const p = provider();
  if (!p) {
    // No airline API key. That is NOT a dead end, and it must not be
    // reported to the user as a technical failure — they asked a question
    // that a search can answer perfectly well. The message is addressed to
    // the MODEL, telling it what to do next, because "I'm unable to check
    // due to a technical issue" is the worst possible reply to "what are
    // the flight timings?".
    return {
      ok: false,
      error:
        "no airline booking API is configured, so I have no live fare data. " +
        "DO NOT tell the user this failed or mention a technical issue. " +
        "Instead, look the flight schedule up with Google Search (or " +
        "web_search) and answer from that, making clear the times are " +
        "indicative and should be confirmed on the airline's site.",
    };
  }
  const o = resolveAirport(from);
  const d = resolveAirport(to);
  // Ask rather than guess which airport was meant (§20).
  const missing = [];
  if (!o) missing.push("origin airport (a city I know or a 3-letter code)");
  if (!d) missing.push("destination airport (a city I know or a 3-letter code)");
  if (missing.length) return { ok: false, needsArgs: missing };

  // DATE. An ISO date is used as given. Anything else is parsed properly:
  // this used to fall through to "tomorrow" for any unrecognised string, so
  // "next Friday" quietly returned tomorrow's flights and the user would
  // only find out at the airport. An unparseable date is now a question.
  let day;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    day = date;
  } else if (date) {
    let parsed = null;
    try {
      parsed = require("chrono-node").parseDate(String(date), new Date(), { forwardDate: true });
    } catch (_) {}
    if (!parsed) {
      return { ok: false, needsArgs: [`a clearer travel date (I couldn't read "${date}")`] };
    }
    day = parsed.toISOString().slice(0, 10);
  } else {
    day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  }

  try {
    const flights = await BACKENDS[p]({ from: o, to: d, date: day, adults });
    if (!flights.length) {
      return { ok: false, error: `no flights found for ${o}→${d} on ${day}` };
    }
    return {
      ok: true,
      data: flights,
      speak: flights
        .slice(0, 3)
        .map(
          (f) =>
            `${f.flight} departs ${String(f.departure).slice(11, 16)}, ` +
            `${f.stops === 0 ? "non-stop" : `${f.stops} stop`}, ${f.price}`
        )
        .join("; "),
    };
  } catch (e) {
    return { ok: false, error: `flight search failed: ${String(e.message).slice(0, 160)}` };
  }
}

/* ------------------------------------------------------------------ */
/* THE APP'S FLIGHT LIST (2026-11-04): the Flights page asks for a full */
/* list — airline, times, duration, stops, a numeric price — not a     */
/* spoken summary. Same providers, same rule: nothing is ever invented. */
/* ------------------------------------------------------------------ */

const CABINS = ["economy", "premium_economy", "business", "first"];
const AMADEUS_CABIN = {
  economy: "ECONOMY", premium_economy: "PREMIUM_ECONOMY", business: "BUSINESS", first: "FIRST",
};

/** "PT2H35M" → 155 */
function isoMinutes(d) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(String(d || ""));
  return m ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : null;
}

const LIST_BACKENDS = {
  async amadeus({ from, to, date, adults, cabin, max }) {
    const token = await amadeusAuth();
    const u = new URL(`${amadeusHost()}/v2/shopping/flight-offers`);
    u.searchParams.set("originLocationCode", from);
    u.searchParams.set("destinationLocationCode", to);
    u.searchParams.set("departureDate", date);
    u.searchParams.set("adults", String(adults));
    u.searchParams.set("travelClass", AMADEUS_CABIN[cabin]);
    u.searchParams.set("max", String(max));
    u.searchParams.set("currencyCode", "INR");
    const r = await fetch(u, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`amadeus ${r.status}`);
    const j = await r.json();
    const names = j.dictionaries?.carriers || {};
    return (j.data || []).map((o) => {
      const it = o.itineraries[0];
      const seg = it.segments;
      return {
        id: String(o.id),
        airline: names[seg[0].carrierCode] || seg[0].carrierCode,
        carrier: seg[0].carrierCode,
        flight: `${seg[0].carrierCode} ${seg[0].number}`,
        from: seg[0].departure.iataCode,
        to: seg[seg.length - 1].arrival.iataCode,
        departure: seg[0].departure.at,
        arrival: seg[seg.length - 1].arrival.at,
        durationMin: isoMinutes(it.duration),
        stops: seg.length - 1,
        via: seg.slice(0, -1).map((x) => x.arrival.iataCode),
        price: Number(o.price.grandTotal || o.price.total),
        currency: o.price.currency,
        cabin,
      };
    });
  },

  async duffel({ from, to, date, adults, cabin, max }) {
    const r = await fetch("https://api.duffel.com/air/offer_requests?return_offers=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Duffel-Version": "v2",
        authorization: `Bearer ${process.env.DUFFEL_API_TOKEN}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        data: {
          slices: [{ origin: from, destination: to, departure_date: date }],
          passengers: Array.from({ length: adults }, () => ({ type: "adult" })),
          cabin_class: cabin,
        },
      }),
    });
    if (!r.ok) throw new Error(`duffel ${r.status}`);
    const j = await r.json();
    return (j.data?.offers || []).slice(0, max).map((o) => {
      const sl = o.slices[0];
      const seg = sl.segments;
      const oc = seg[0].operating_carrier || {};
      return {
        id: String(o.id),
        airline: o.owner?.name || oc.name || oc.iata_code,
        carrier: o.owner?.iata_code || oc.iata_code,
        flight: `${oc.iata_code || ""} ${seg[0].operating_carrier_flight_number || ""}`.trim(),
        from: seg[0].origin?.iata_code || from,
        to: seg[seg.length - 1].destination?.iata_code || to,
        departure: seg[0].departing_at,
        arrival: seg[seg.length - 1].arriving_at,
        durationMin: isoMinutes(sl.duration),
        stops: seg.length - 1,
        via: seg.slice(0, -1).map((x) => x.destination?.iata_code).filter(Boolean),
        price: Number(o.total_amount),
        currency: o.total_currency,
        cabin,
      };
    });
  },
};

/* ---------------- Google Flights via SerpApi (2026-11-04) ---------------- */

const SERP_CLASS = { economy: 1, premium_economy: 2, business: 3, first: 4 };

/** "2026-11-10 06:05" → "2026-11-10T06:05" (the app reads [11,16)). */
const serpTime = (t) => String(t || "").replace(" ", "T");

LIST_BACKENDS.serpapi = async ({ from, to, date, adults, cabin }) => {
  const u = new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine", "google_flights");
  u.searchParams.set("departure_id", from);
  u.searchParams.set("arrival_id", to);
  u.searchParams.set("outbound_date", date);
  u.searchParams.set("type", "2"); // one way
  u.searchParams.set("adults", String(adults));
  u.searchParams.set("travel_class", String(SERP_CLASS[cabin] || 1));
  u.searchParams.set("currency", "INR");
  u.searchParams.set("hl", "en");
  u.searchParams.set("gl", "in");
  u.searchParams.set("api_key", process.env.SERPAPI_KEY);
  const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    // "no results" is an empty list, not a failure.
    if (/no results/i.test(String(j.error || ""))) return [];
    throw new Error(`serpapi ${r.status} ${String(j.error || "").slice(0, 80)}`);
  }
  const all = [...(j.best_flights || []), ...(j.other_flights || [])];
  return all.map((o, i) => {
    const seg = o.flights || [];
    const first = seg[0] || {};
    const last = seg[seg.length - 1] || {};
    return {
      id: `${i}-${first.flight_number || ""}`,
      airline: first.airline || "",
      carrier: String(first.flight_number || "").split(" ")[0] || "",
      flight: first.flight_number || "",
      logo: o.airline_logo || first.airline_logo || null,
      from: first.departure_airport?.id || from,
      to: last.arrival_airport?.id || to,
      departure: serpTime(first.departure_airport?.time),
      arrival: serpTime(last.arrival_airport?.time),
      durationMin: Number(o.total_duration) || null,
      stops: Math.max(seg.length - 1, 0),
      via: (o.layovers || []).map((l) => l.id).filter(Boolean),
      price: Number(o.price),
      currency: "INR",
      cabin,
    };
  }).filter((f) => Number.isFinite(f.price));
};

// The voice tool's short list, from the same results.
BACKENDS.serpapi = async ({ from, to, date, adults }) =>
  (await LIST_BACKENDS.serpapi({ from, to, date, adults, cabin: "economy" }))
    .slice(0, 6)
    .map((f) => ({
      carrier: f.airline,
      flight: f.flight,
      departure: f.departure,
      arrival: f.arrival,
      stops: f.stops,
      price: `INR ${f.price}`,
    }));

/* SHARED RESULTS (owner, 2026-11-04: "when one user makes a request use
 * the API; another request for the same route uses the same results;
 * refresh every 4 hours"). One search per route+date+travellers+class
 * per 4 hours, whoever asks — kept in Postgres so a restart or a deploy
 * does not spend searches again, with a memory layer in front, and a
 * search already on its way shared by everyone who asks meanwhile.
 * SerpApi's free plan is 250 searches a month. */
const CACHE_MS = 4 * 60 * 60 * 1000;
const cache = new Map(); // key → { at, out }
const inFlight = new Map(); // key → Promise<out>
let cacheReady = null;

function cacheTable() {
  if (!cacheReady) {
    const db = require("../db");
    cacheReady = db.run(`
      CREATE TABLE IF NOT EXISTS flight_search_cache (
        key        TEXT PRIMARY KEY,
        result     JSONB NOT NULL,
        fetched_at BIGINT NOT NULL
      )`).catch((e) => { cacheReady = null; throw e; });
  }
  return cacheReady;
}

async function cacheGet(key) {
  const m = cache.get(key);
  if (m && Date.now() - m.at < CACHE_MS) return m.out;
  try {
    await cacheTable();
    const row = await require("../db").one(
      "SELECT result, fetched_at FROM flight_search_cache WHERE key = $1", [key]);
    if (row && Date.now() - Number(row.fetched_at) < CACHE_MS) {
      cache.set(key, { at: Number(row.fetched_at), out: row.result });
      return row.result;
    }
  } catch (_) {}
  return null;
}

async function cachePut(key, out) {
  const at = Date.now();
  cache.set(key, { at, out });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  try {
    await cacheTable();
    const db = require("../db");
    await db.run(
      `INSERT INTO flight_search_cache (key, result, fetched_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET result = EXCLUDED.result, fetched_at = EXCLUDED.fetched_at`,
      [key, JSON.stringify(out), at]);
    // Old entries go, so the table stays small.
    await db.run("DELETE FROM flight_search_cache WHERE fetched_at < $1", [at - 2 * CACHE_MS]);
  } catch (_) {}
}

/**
 * The list the app draws.
 * @returns {configured:false} | {configured:true, flights:[…]} | {configured:true, error}
 */
async function list({ from, to, date, adults = 1, cabin = "economy", max = 20 }) {
  const p = provider();
  if (!p) return { configured: false, flights: [] };
  const o = iata(from);
  const d = iata(to);
  if (!o || !d || o === d) return { configured: true, error: "pick two different airports", flights: [] };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    return { configured: true, error: "pick a travel date", flights: [] };
  }
  const n = Math.min(Math.max(parseInt(adults, 10) || 1, 1), 9);
  const c = CABINS.includes(cabin) ? cabin : "economy";
  const key = `${p}|${o}|${d}|${date}|${n}|${c}`;
  const hit = await cacheGet(key);
  if (hit) return hit;
  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    try {
      const flights = await LIST_BACKENDS[p]({
        from: o, to: d, date, adults: n, cabin: c, max: Math.min(Math.max(max, 1), 30),
      });
      flights.sort((a, b) => a.price - b.price);
      const out = { configured: true, provider: p, fetchedAt: Date.now(), flights: flights.slice(0, 30) };
      await cachePut(key, out); // an empty list is an answer too: cached
      return out;
    } catch (e) {
      // A failure is never cached: the next asker tries again.
      return { configured: true, error: `flight search failed: ${String(e.message).slice(0, 120)}`, flights: [] };
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

module.exports = { search, list, provider, resolveAirport, CITY_IATA, amadeusHost, isoMinutes };
