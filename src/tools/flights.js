/**
 * FLIGHT SEARCH — provider adapter (§20).
 *
 * §32: no fabricated availability, ever. With no provider configured this
 * returns an honest "not configured" that the agent relays; it never
 * invents a flight number, time or price.
 *
 * Provider: SERPAPI_KEY (Google Flights via SerpApi, 2026-11-04; 250
 * searches a month on the free plan).
 */
function provider() {
  return process.env.SERPAPI_KEY ? "serpapi" : null;
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

/* ---------------- Google Flights via SerpApi (2026-11-04) ---------------- */

/** "2026-11-10 06:05" → "2026-11-10T06:05" (search() speaks [11,16)). */
const serpTime = (t) => String(t || "").replace(" ", "T");

const BACKENDS = {
  async serpapi({ from, to, date, adults }) {
    const u = new URL("https://serpapi.com/search.json");
    u.searchParams.set("engine", "google_flights");
    u.searchParams.set("departure_id", from);
    u.searchParams.set("arrival_id", to);
    u.searchParams.set("outbound_date", date);
    u.searchParams.set("type", "2"); // one way
    u.searchParams.set("adults", String(adults || 1));
    u.searchParams.set("travel_class", "1"); // economy
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
    return all
      .map((o) => {
        const seg = o.flights || [];
        const first = seg[0] || {};
        const last = seg[seg.length - 1] || {};
        return {
          carrier: first.airline || "",
          flight: first.flight_number || "",
          departure: serpTime(first.departure_airport?.time),
          arrival: serpTime(last.arrival_airport?.time),
          stops: Math.max(seg.length - 1, 0),
          price: Number(o.price),
        };
      })
      .filter((f) => Number.isFinite(f.price))
      .slice(0, 6)
      .map((f) => ({ ...f, price: `INR ${f.price}` }));
  },
};

module.exports = { search, provider, resolveAirport, CITY_IATA };
