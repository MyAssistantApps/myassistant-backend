/**
 * RIDE PROVIDERS — the seam between "book a cab" and a company that can
 * actually send one (owner, 2026-11-21).
 *
 * Every provider has the same shape:
 *
 *   id, label
 *   available()                     true when its credentials are set
 *   estimate({ pickup, drop })      → { fare, currency, etaMin, product }
 *   book({ pickup, drop, rider, productId, userId })
 *                                   → { externalId, status, fare, ... }
 *   status(externalId, { userId })  → { status, driver, vehicle, otp, etaMin }
 *   cancel(externalId, { userId })  → true
 *
 * pickup / drop = { name, address, lat, lng } (lat/lng may be null).
 * status is one of: searching | accepted | arriving | in_progress |
 * completed | cancelled | no_drivers.
 *
 * WHICH ARE LIVE
 * - test: a simulated provider for building and demonstrating the whole
 *   flow. It never contacts a real company and every word it produces
 *   says "test booking". On only when RIDES_TEST_PROVIDER=on, never by
 *   default, so production cannot book a pretend cab by accident.
 * - uber: Uber's Ride Requests API (estimates, POST /v1.2/requests,
 *   status, cancel). Partner-gated: needs Uber's approval for the
 *   privileged "request" scope, then each rider links their Uber account
 *   (OAuth). Credentials: UBER_CLIENT_ID, UBER_CLIENT_SECRET,
 *   UBER_REDIRECT_URI; per-user tokens in ride_accounts.
 * - ola: Ola's partner booking API (XAPP token from affiliates@olacabs.com
 *   plus the rider's Ola authorisation). Credentials: OLA_XAPP_TOKEN.
 *
 * Until a real provider is approved, book_ride falls back to the
 * documented deep link (the provider's own confirm screen), which works
 * today without any agreement. See docs/RIDES.md for what to send each
 * company.
 */
const crypto = require("crypto");

const R = 6371; // km
// Number(null) is 0: a missing coordinate is not the Gulf of Guinea.
const real = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
function km(a, b) {
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every(real)) return null;
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ------------------------------------------------------------------ *
 * TEST PROVIDER — the whole lifecycle, nothing real.
 * ------------------------------------------------------------------ */
const testRides = new Map(); // externalId -> { createdAt, cancelled, otp, ... }
const TEST_STEP_MS = Number(process.env.RIDES_TEST_STEP_MS) || 20_000;

const test = {
  id: "test",
  label: "Test Cabs",
  test: true,
  available: () => process.env.RIDES_TEST_PROVIDER === "on",
  async estimate({ pickup, drop }) {
    const d = km(pickup, drop) ?? 7; // no coordinates: a typical city hop
    return { fare: Math.round(60 + d * 18), currency: "INR", etaMin: 4, product: "Test Mini", distanceKm: Math.round(d * 10) / 10 };
  },
  async book({ pickup, drop }) {
    const e = await test.estimate({ pickup, drop });
    const externalId = `test_${crypto.randomBytes(6).toString("hex")}`;
    testRides.set(externalId, {
      createdAt: Date.now(),
      cancelled: false,
      otp: String(crypto.randomInt(1000, 10000)),
      driver: { name: "Test Driver", phone: "", rating: 4.8 },
      vehicle: { model: "Test Hatchback", plate: "KA 00 TE 0000", colour: "White" },
    });
    return { externalId, status: "searching", fare: e.fare, currency: e.currency, etaMin: e.etaMin, product: e.product };
  },
  async status(externalId) {
    const r = testRides.get(externalId);
    if (!r) return { status: "cancelled" };
    if (r.cancelled) return { status: "cancelled" };
    // One step per check at most, once its time has come, so every status
    // is seen in order however the checks are spaced.
    r.step = r.step || 0;
    if (Date.now() - r.createdAt >= (r.step + 1) * TEST_STEP_MS) r.step++;
    const step = r.step;
    const status = ["searching", "accepted", "arriving", "in_progress", "completed"][Math.min(step, 4)];
    const out = { status, etaMin: Math.max(0, 4 - step) };
    if (status !== "searching") Object.assign(out, { driver: r.driver, vehicle: r.vehicle, otp: r.otp });
    return out;
  },
  async cancel(externalId) {
    const r = testRides.get(externalId);
    if (r) r.cancelled = true;
    return true;
  },
};

/* ------------------------------------------------------------------ *
 * UBER — Ride Requests API (partner access required).
 * ------------------------------------------------------------------ */
const UBER_API = process.env.UBER_API_BASE || "https://api.uber.com";
const uber = {
  id: "uber",
  label: "Uber",
  available: () => Boolean(process.env.UBER_CLIENT_ID && process.env.UBER_CLIENT_SECRET && process.env.UBER_RIDES_ENABLED === "on"),
  async token(userId) {
    const row = await require("../db").one(
      `SELECT access_token FROM ride_accounts WHERE user_id = $1 AND provider = 'uber'`, [userId]);
    if (!row) throw Object.assign(new Error("Uber account not linked"), { code: "link_required" });
    return row.access_token;
  },
  async call(userId, path, { method = "GET", body } = {}) {
    const r = await fetch(UBER_API + path, {
      method,
      headers: { Authorization: `Bearer ${await uber.token(userId)}`, "Content-Type": "application/json", "Accept-Language": "en_IN" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) throw Object.assign(new Error(`uber ${r.status}`), { status: r.status });
    return r.status === 204 ? {} : r.json();
  },
  async estimate({ pickup, drop, userId }) {
    const j = await uber.call(userId, "/v1.2/requests/estimate", { method: "POST", body: {
      start_latitude: pickup.lat, start_longitude: pickup.lng, end_latitude: drop.lat, end_longitude: drop.lng } });
    return { fare: j.fare?.value ?? null, currency: j.fare?.currency_code || "INR", etaMin: j.pickup_estimate ?? null,
      product: j.product_id || "", fareId: j.fare?.fare_id };
  },
  async book({ pickup, drop, userId, fareId, productId }) {
    const j = await uber.call(userId, "/v1.2/requests", { method: "POST", body: {
      fare_id: fareId, product_id: productId,
      start_latitude: pickup.lat, start_longitude: pickup.lng, end_latitude: drop.lat, end_longitude: drop.lng } });
    return { externalId: j.request_id, status: mapUber(j.status), etaMin: j.eta ?? null };
  },
  async status(externalId, { userId }) {
    const j = await uber.call(userId, `/v1.2/requests/${encodeURIComponent(externalId)}`);
    return {
      status: mapUber(j.status), etaMin: j.pickup?.eta ?? j.eta ?? null,
      driver: j.driver ? { name: j.driver.name, phone: j.driver.phone_number, rating: j.driver.rating } : null,
      vehicle: j.vehicle ? { model: `${j.vehicle.make || ""} ${j.vehicle.model || ""}`.trim(), plate: j.vehicle.license_plate } : null,
      // Uber shows a trip PIN only when the rider has turned PIN
      // verification on; its API does not always return one.
      otp: j.pin || j.verification_code || null,
    };
  },
  async cancel(externalId, { userId }) {
    await uber.call(userId, `/v1.2/requests/${encodeURIComponent(externalId)}`, { method: "DELETE" });
    return true;
  },
};
function mapUber(s) {
  return ({ processing: "searching", accepted: "accepted", arriving: "arriving", in_progress: "in_progress",
    completed: "completed", rider_canceled: "cancelled", driver_canceled: "cancelled", no_drivers_available: "no_drivers" })[s] || "searching";
}

/* ------------------------------------------------------------------ *
 * OLA — partner booking API (XAPP token + rider authorisation).
 * ------------------------------------------------------------------ */
const OLA_API = process.env.OLA_API_BASE || "https://devapi.olacabs.com";
const ola = {
  id: "ola",
  label: "Ola",
  available: () => Boolean(process.env.OLA_XAPP_TOKEN && process.env.OLA_RIDES_ENABLED === "on"),
  async call(userId, path, { method = "GET", body } = {}) {
    const acct = await require("../db").one(
      `SELECT access_token FROM ride_accounts WHERE user_id = $1 AND provider = 'ola'`, [userId]);
    if (!acct) throw Object.assign(new Error("Ola account not linked"), { code: "link_required" });
    const r = await fetch(OLA_API + path, {
      method,
      headers: { "X-APP-TOKEN": process.env.OLA_XAPP_TOKEN, Authorization: `Bearer ${acct.access_token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) throw Object.assign(new Error(`ola ${r.status}`), { status: r.status });
    return r.json();
  },
  async estimate({ pickup, drop, userId }) {
    const j = await ola.call(userId, `/v1/products?pickup_lat=${pickup.lat}&pickup_lng=${pickup.lng}&drop_lat=${drop.lat}&drop_lng=${drop.lng}&category=mini`);
    const e = (j.ride_estimate || [])[0] || {};
    return { fare: e.amount_min ?? null, currency: "INR", etaMin: (j.categories || [])[0]?.eta ?? null, product: "mini" };
  },
  async book({ pickup, drop, userId }) {
    const j = await ola.call(userId, "/v1/bookings/create", { method: "POST", body: {
      pickup_lat: pickup.lat, pickup_lng: pickup.lng, drop_lat: drop.lat, drop_lng: drop.lng, pickup_mode: "NOW", category: "mini" } });
    return { externalId: j.booking_id, status: "searching" };
  },
  async status(externalId, { userId }) {
    const j = await ola.call(userId, `/v1/bookings/track_ride?booking_id=${encodeURIComponent(externalId)}`);
    const map = { CALL_DRIVER: "accepted", CLIENT_LOCATED: "arriving", IN_PROGRESS: "in_progress", COMPLETED: "completed", BOOKING_CANCELLED: "cancelled" };
    return {
      status: map[j.booking_status] || "searching",
      etaMin: j.driver_eta ?? null,
      driver: j.driver_name ? { name: j.driver_name, phone: j.driver_number } : null,
      vehicle: j.cab_number ? { model: j.car_model, plate: j.cab_number } : null,
      otp: j.otp?.start_trip?.value || j.otp || null,
    };
  },
  async cancel(externalId, { userId }) {
    await ola.call(userId, "/v1/bookings/cancel", { method: "POST", body: { booking_id: externalId, reason: "Plan changed" } });
    return true;
  },
};

const ALL = { test, uber, ola };

/** The providers that can book right now, real ones first. */
function live() {
  return [uber, ola, test].filter((p) => {
    try { return p.available(); } catch { return false; }
  });
}

module.exports = { ALL, live, km, _testRides: testRides };
