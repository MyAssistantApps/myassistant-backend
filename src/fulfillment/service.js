/**
 * FULFILLMENT SERVICE — the part that actually gets things done.
 *
 * Two execution paths, chosen by what the world genuinely allows:
 *
 *   handoff  Hari resolves the exact target and deep-links the provider
 *            app; the user pays. Ends at 'handed_off', never 'confirmed'
 *            (see deeplinks.js for why no API path exists for Swiggy,
 *            BookMyShow, Uber & co).
 *
 *   api      a real partner integration. `PROVIDER_ADAPTERS` is the seam;
 *            it is deliberately empty, and an empty seam is honest where a
 *            mocked one is not.
 *
 * The rule every function here obeys: the ledger and the spoken sentence
 * must describe what REALLY happened.
 */
const places = require("../services/tools/places");
const store = require("./store");
const deeplinks = require("./deeplinks");

/**
 * Real provider APIs, when a partner key exists. Empty today — every
 * consumer platform we target (Swiggy, Zomato, BookMyShow, Ola) offers no
 * public ordering API, and Uber's Rides API is partner-gated. Register an
 * adapter here and the tools below will prefer it over a handoff.
 *
 *   PROVIDER_ADAPTERS.uber = {
 *     kind: "ride",
 *     available: () => Boolean(process.env.UBER_SERVER_TOKEN),
 *     async execute(task, ctx) { … return { ok, confirmation, outcome } },
 *   };
 */
const PROVIDER_ADAPTERS = Object.create(null);

function adapterFor(kind, provider) {
  const a = PROVIDER_ADAPTERS[provider];
  if (!a || a.kind !== kind) return null;
  try {
    return a.available() ? a : null;
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * RESOLUTION — turn "that biryani place near me" into a real business
 * ------------------------------------------------------------------ */

/**
 * Finds the business the user means, with a phone number where possible.
 * A phone number is what unlocks the `call` path, so we prefer a slightly
 * lower-rated place that we can actually ring over a better one we cannot.
 *
 * Returns null when nothing matches — the caller must then ask rather than
 * invent a venue.
 */
async function resolveBusiness({ query, lat, lng, requirePhone = false }) {
  if (!query) return null;
  let list = [];
  try {
    list = (await places.searchPlaces({ q: query, lat, lng })) || [];
  } catch (_) {
    return null;
  }
  if (!list.length) return null;

  if (requirePhone) {
    // This number is about to be DIALLED autonomously, so a near-enough
    // match is not acceptable. Results are distance-sorted, which means the
    // first callable place can easily be a different business entirely:
    // ask for a dentist whose number Google doesn't list and you would end
    // up phoning whoever happens to be nearest. Requiring the name to
    // actually match makes the failure "I couldn't find their number",
    // which is true, instead of a call to a stranger.
    const named = list.filter((p) => p.phone && nameMatches(query, p.name));
    return named[0] || null;
  }

  // Prefer callable, but only when it isn't a much worse match: the first
  // result is the best name match, so we only skip past it for a callable
  // place inside the top three.
  const callableNearTop = list.slice(0, 3).find((p) => p.phone);
  return callableNearTop || list[0];
}

/** Words too generic to identify a business on their own. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "of", "at", "in", "near", "me", "my",
  "clinic", "hospital", "restaurant", "salon", "centre", "center",
  "dr", "doctor", "cafe", "shop", "store", "hotel",
]);

function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Does this result plausibly refer to the business the user named?
 *
 * Every distinctive word the user gave must appear in the result's name.
 * "Apollo Clinic" matches "Apollo Clinic Indiranagar"; it does not match
 * "Manipal Hospital". When the user's phrase carries no distinctive word
 * at all ("the clinic"), nothing can be verified, so nothing matches —
 * Hari asks rather than guessing whose phone to ring.
 */
function nameMatches(query, name) {
  const q = tokens(query);
  if (!q.length) return false;
  const n = new Set(tokens(name));
  return q.every((w) => n.has(w));
}

/* ------------------------------------------------------------------ *
 * PATH: HANDOFF — resolve the target, then open the provider app
 * ------------------------------------------------------------------ */

/**
 * Builds a handoff and records it. Returns { task, url, speak }.
 * `speak` always states that the user completes the payment step.
 */
async function handoff({ userId, kind, provider, link, title, venue, whenMs, details, what }) {
  const row = await store.create(userId, {
    kind,
    provider,
    path: "handoff",
    title,
    venue: venue || null,
    when_at: whenMs || null,
    details: details || {},
    deep_link: link.url,
    status: "handed_off",
    outcome: `Opened ${deeplinks.labelFor(provider)} (${link.note}). Payment is completed by you in the app.`,
  });
  return {
    task: row,
    url: link.url,
    speak: deeplinks.speakFor({
      precision: link.precision,
      providerLabel: deeplinks.labelFor(provider),
      what,
    }),
  };
}

module.exports = {
  PROVIDER_ADAPTERS,
  adapterFor,
  resolveBusiness,
  nameMatches,
  handoff,
};
