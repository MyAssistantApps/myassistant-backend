/**
 * JYOTISH GEO — a birth place to coordinates and an IANA timezone, and a
 * local birth time to the UTC instant with that zone's historical offset.
 *
 * Geocoding is OpenStreetMap Nominatim: an identifying User-Agent, at most
 * one request a second across the whole server (their usage policy), and
 * every answer cached in jyotish_geocode. The timezone comes from the
 * coordinates (tz-lookup), the offset from Node's IANA database (Intl), so
 * India's 1942–45 war time, Europe's DST and the like come out right.
 */
const tzlookup = require("@photostructure/tz-lookup");
const store = require("./store");

const NOMINATIM = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org/search";
const USER_AGENT = process.env.NOMINATIM_USER_AGENT || "MyAssistant-Jyotish/1.0 (+https://backend.envisionsit.in)";
const MIN_GAP_MS = 1100;

let fetchImpl = (...a) => fetch(...a);
/** Test seam: replace the HTTP call (and so never reach Nominatim). */
function _setFetch(f) { fetchImpl = f || ((...a) => fetch(...a)); }

// One request at a time, a second apart, for the whole process.
let chain = Promise.resolve();
let last = 0;
function throttled(fn) {
  const next = chain.then(async () => {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { last = Date.now(); }
  });
  chain = next.catch(() => {});
  return next;
}

const normQuery = (q) => String(q || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

function zoneOf(lat, lng) {
  try { return tzlookup(lat, lng); } catch { return null; }
}

/** Up to five places for a query: { name, lat, lng, tz }. Throws { status:502 } when Nominatim fails. */
async function searchPlaces(q) {
  const key = normQuery(q);
  if (key.length < 2) return [];
  const hit = await store.cachedGeocode(key);
  if (hit) return hit;
  const url = `${NOMINATIM}?format=jsonv2&limit=5&addressdetails=0&q=${encodeURIComponent(key)}`;
  const res = await throttled(() => fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
    signal: AbortSignal.timeout(8000),
  }));
  if (!res.ok) {
    const e = new Error(`nominatim ${res.status}`);
    e.status = 502;
    throw e;
  }
  const rows = await res.json();
  const places = (Array.isArray(rows) ? rows : []).slice(0, 5).map((r) => {
    const lat = Number(r.lat), lng = Number(r.lon);
    return { name: String(r.display_name || "").slice(0, 200), lat, lng, tz: zoneOf(lat, lng) };
  }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.tz);
  await store.saveGeocode(key, places);
  return places;
}

/** The zone's offset from UTC, in minutes, at a UTC instant. */
function offsetMinutes(tz, utcMs) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/**
 * Local wall-clock date + time in a zone → the UTC Date. A time that the
 * zone skipped (spring forward) resolves to the later offset; a repeated
 * one (fall back) to the first. Returns { utc, offsetMinutes }.
 */
function localToUtc(date, time, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (time || "12:00").split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // The offsets either side of any transition near this wall time.
  const before = offsetMinutes(tz, wall - 86_400_000);
  const after = offsetMinutes(tz, wall + 86_400_000);
  const fits = [...new Set([before, after])]
    .map((o) => wall - o * 60000)
    .filter((c) => offsetMinutes(tz, c) === Math.round((wall - c) / 60000))
    .sort((a, b) => a - b);
  // A real time: the earliest instant that shows it. A skipped one: read with
  // the offset before the jump, which lands it after (02:30 → 03:30).
  const utc = fits.length ? fits[0] : wall - before * 60000;
  return { utc: new Date(utc), offsetMinutes: offsetMinutes(tz, utc) };
}

function validZone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

module.exports = { searchPlaces, localToUtc, offsetMinutes, zoneOf, validZone, normQuery, _setFetch, USER_AGENT };
