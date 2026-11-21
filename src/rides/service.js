/**
 * BOOK A CAB BY VOICE (owner, 2026-11-21): "book a cab from Yeshwanthpur
 * to Majestic" books one and says so — driver, car, OTP, arrival — with
 * no provider named. The flow:
 *
 *   1. resolve pickup and drop-off to real places (the phone's location
 *      when no pickup is named)
 *   2. ask every provider that can book for an estimate; the cheapest
 *      wins unless the user named one
 *   3. a fare over RIDES_MAX_FARE is not booked without a yes
 *   4. book, record it (ride_bookings), and confirm in one sentence
 *   5. follow the ride (job ride_status every RIDES_POLL_MS): a push when
 *      a driver is assigned (with the OTP), when they arrive, when the
 *      trip starts and ends; the Home strip shows it all
 *   6. cancel by voice or from Home
 *
 * When no provider can book (no partner access yet), canBook() is false
 * and book_ride keeps its deep-link handoff: the provider's own confirm
 * screen, trip pre-filled.
 */
const { one, query, run } = require("../db");
const providers = require("./providers");

const POLL_MS = Number(process.env.RIDES_POLL_MS) || 15_000;
const MAX_POLL_MIN = 180;
const MAX_FARE = Number(process.env.RIDES_MAX_FARE) || 1500;
const MAX_KM = Number(process.env.RIDES_MAX_KM) || 100;
const JOB = "ride_status";
const TERMINAL = new Set(["completed", "cancelled", "no_drivers"]);

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS ride_bookings (
        id            BIGSERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL,
        provider      TEXT NOT NULL,
        external_id   TEXT NOT NULL DEFAULT '',
        test          INTEGER NOT NULL DEFAULT 0,
        pickup        JSONB NOT NULL DEFAULT '{}',
        dropoff       JSONB NOT NULL DEFAULT '{}',
        product       TEXT NOT NULL DEFAULT '',
        fare          NUMERIC,
        currency      TEXT NOT NULL DEFAULT 'INR',
        status        TEXT NOT NULL DEFAULT 'searching',
        driver        JSONB,
        vehicle       JSONB,
        otp           TEXT NOT NULL DEFAULT '',
        eta_min       INTEGER,
        told          TEXT NOT NULL DEFAULT '',   -- statuses already pushed
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ride_bookings_user ON ride_bookings(user_id, id DESC);
      CREATE TABLE IF NOT EXISTS ride_accounts (
        user_id       INTEGER NOT NULL,
        provider      TEXT NOT NULL,
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL DEFAULT '',
        expires_at    BIGINT NOT NULL DEFAULT 0,
        created_at    BIGINT NOT NULL,
        PRIMARY KEY (user_id, provider)
      );
    `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

const canBook = () => providers.live().length > 0;

/** A spoken place to { name, address, lat, lng }; null lat/lng when unknown. */
async function place(text, near) {
  const q = String(text || "").trim();
  if (!q) return null;
  let p = null;
  try {
    p = await require("../fulfillment/service").resolveBusiness({ query: q, lat: near?.lat, lng: near?.lng });
  } catch { /* no places key: the name alone */ }
  let ok = p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
  // A city ride: a match 100 km away is another place with the same name
  // ("Majestic" matched abroad and quoted Rs 1.5 lakh). Keep the words,
  // drop the wrong coordinates.
  if (ok && near && Number.isFinite(Number(near.lat))) {
    const d = providers.km(near, { lat: Number(p.lat), lng: Number(p.lng) });
    if (d != null && d > MAX_KM) ok = false;
  }
  return {
    name: (ok && p.name) || q,
    address: (ok && (p.address || p.vicinity)) || q,
    lat: ok ? Number(p.lat) : null,
    lng: ok ? Number(p.lng) : null,
  };
}

function shape(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    provider: r.provider,
    providerLabel: providers.ALL[r.provider]?.label || r.provider,
    test: Boolean(Number(r.test)),
    pickup: r.pickup?.name || "",
    drop: r.dropoff?.name || "",
    fare: r.fare != null ? Number(r.fare) : null,
    currency: r.currency,
    status: r.status,
    driver: r.driver || null,
    vehicle: r.vehicle || null,
    otp: r.otp || "",
    etaMin: r.eta_min != null ? Number(r.eta_min) : null,
    createdAt: Number(r.created_at),
  };
}

/**
 * Books a ride. { userId, from, to, provider?, confirmFare?, here? }
 * Returns { ok, ride, speak } or { ok:false, needs, error, ... }.
 */
async function book({ userId, from, to, provider, confirmFare = false, here = null }) {
  await migrate();
  const live = providers.live();
  if (!live.length) return { ok: false, error: "no_provider" };
  if (!to) return { ok: false, needs: "destination", error: "where to?" };

  const pickup = from ? await place(from, here) : here && Number.isFinite(Number(here.lat))
    ? { name: "Your current location", address: "", lat: Number(here.lat), lng: Number(here.lng) }
    : null;
  if (!pickup) return { ok: false, needs: "pickup", error: "the pickup point is unknown; ask where to pick them up" };
  const drop = await place(to, pickup.lat != null ? pickup : here);

  // One active ride at a time: a second "book a cab" is almost always a
  // repeat, and two cabs arriving is worse than asking.
  const open = await active(userId);
  if (open) {
    return { ok: false, error: "already_active", ride: open,
      speak: `You already have a ride booked with ${open.providerLabel} to ${open.drop}. Shall I cancel it first?` };
  }

  const pool = provider ? live.filter((p) => p.id === provider) : live;
  if (!pool.length) {
    return { ok: false, error: "provider_unavailable",
      speak: `${providers.ALL[provider]?.label || provider} cannot be booked from here yet.` };
  }
  // Estimates from every candidate; real providers before the test one.
  const quotes = [];
  const unlinked = [];
  for (const p of pool) {
    try {
      const e = await p.estimate({ pickup, drop, userId });
      quotes.push({ p, e });
    } catch (err) {
      if (err?.code === "link_required") unlinked.push(p.label);
    }
  }
  if (!quotes.length && unlinked.length) {
    return { ok: false, error: "link_required",
      speak: `Please link your ${unlinked.join(" or ")} account first; I have opened Linked Accounts for you.` };
  }
  if (!quotes.length) return { ok: false, error: "no_quote", speak: "No cab could be quoted for that trip right now." };
  const real = quotes.filter((q) => !q.p.test);
  const candidates = real.length ? real : quotes;
  candidates.sort((a, b) => (a.e.fare ?? 1e9) - (b.e.fare ?? 1e9));
  const best = candidates[0];

  if (best.e.fare != null && best.e.fare > MAX_FARE && !confirmFare) {
    return { ok: false, needs: "fare_confirmation", fare: best.e.fare,
      speak: `The fare is about Rs ${best.e.fare} with ${best.p.label}. Shall I book it?` };
  }

  const booked = await best.p.book({ pickup, drop, userId, fareId: best.e.fareId, productId: best.e.product });
  const now = Date.now();
  const row = await one(
    `INSERT INTO ride_bookings (user_id, provider, external_id, test, pickup, dropoff, product, fare, currency, status, eta_min, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
    [userId, best.p.id, booked.externalId, best.p.test ? 1 : 0, pickup, drop, booked.product || best.e.product || "",
      booked.fare ?? best.e.fare ?? null, booked.currency || best.e.currency || "INR", booked.status || "searching",
      booked.etaMin ?? best.e.etaMin ?? null, now]);
  await require("../infra/jobs").enqueue(JOB, { id: Number(row.id) }, { userId, delayMs: POLL_MS });
  const ride = shape(row);
  const fare = ride.fare != null ? `, about Rs ${ride.fare}` : "";
  const testWords = ride.test ? " This is a TEST booking: no real cab is coming." : "";
  return {
    ok: true,
    ride,
    speak: `Booked. A ${ride.providerLabel} cab from ${pickup.name} to ${drop.name}${fare}. ` +
      `It is finding you a driver now; I will tell you the driver, the car and your OTP the moment one accepts.${testWords}`,
  };
}

async function active(userId) {
  await migrate();
  const r = await one(
    `SELECT * FROM ride_bookings WHERE user_id = $1 AND status NOT IN ('completed','cancelled','no_drivers')
      ORDER BY id DESC LIMIT 1`, [userId]);
  return shape(r);
}

async function cancel(userId, id) {
  await migrate();
  const r = await one(
    id ? `SELECT * FROM ride_bookings WHERE id = $2 AND user_id = $1` :
      `SELECT * FROM ride_bookings WHERE user_id = $1 AND status NOT IN ('completed','cancelled','no_drivers') ORDER BY id DESC LIMIT 1`,
    id ? [userId, id] : [userId]);
  if (!r || TERMINAL.has(r.status)) return null;
  const p = providers.ALL[r.provider];
  if (p) await p.cancel(r.external_id, { userId });
  const row = await one(`UPDATE ride_bookings SET status = 'cancelled', updated_at = $2 WHERE id = $1 RETURNING *`, [r.id, Date.now()]);
  return shape(row);
}

const TOLD = {
  accepted: (r) => [`Driver Assigned: ${r.driver?.name || "Your Driver"}`,
    `${r.vehicle?.model || "Cab"} ${r.vehicle?.plate || ""}. Your OTP is ${r.otp || "shown in the app"}. Arriving in about ${r.etaMin ?? "a few"} min.`],
  arriving: (r) => ["Your Cab Is Arriving", `${r.vehicle?.plate || "Your cab"} is almost there. OTP ${r.otp || "in the app"}.`],
  in_progress: (r) => ["Trip Started", `On the way to ${r.drop}.`],
  completed: (r) => ["Trip Completed", `You have reached ${r.drop}.${r.fare != null ? ` Fare about Rs ${r.fare}.` : ""}`],
  no_drivers: () => ["No Driver Found", "No driver accepted the ride. Please try again."],
  cancelled: () => ["Ride Cancelled", "The ride was cancelled."],
};

/** One status check; re-queues itself until the ride ends. */
async function onJob(payload) {
  await migrate();
  const r = await one(`SELECT * FROM ride_bookings WHERE id = $1`, [payload.id]);
  if (!r || TERMINAL.has(r.status)) return;
  const p = providers.ALL[r.provider];
  let s;
  try {
    s = await p.status(r.external_id, { userId: r.user_id });
  } catch {
    s = null; // a missed poll: try again next time
  }
  if (s) {
    const row = await one(
      `UPDATE ride_bookings SET status = $2, driver = COALESCE($3, driver), vehicle = COALESCE($4, vehicle),
              otp = COALESCE(NULLIF($5, ''), otp), eta_min = $6, updated_at = $7
        WHERE id = $1 RETURNING *`,
      [r.id, s.status, s.driver ? JSON.stringify(s.driver) : null, s.vehicle ? JSON.stringify(s.vehicle) : null,
        s.otp || "", s.etaMin ?? null, Date.now()]);
    await tell(row);
    if (TERMINAL.has(row.status)) return;
  }
  if (Date.now() - Number(r.created_at) > MAX_POLL_MIN * 60_000) return;
  await require("../infra/jobs").enqueue(JOB, { id: Number(r.id) }, { userId: r.user_id, delayMs: POLL_MS });
}

/**
 * Pushes each status once. The driver, car and OTP are never skipped: a
 * check that first sees the cab already arriving still sends them, since
 * the rider needs the OTP to start the trip.
 */
async function tell(row) {
  const told = new Set(String(row.told || "").split(",").filter(Boolean));
  const due = [];
  if (row.status === "arriving" && !told.has("accepted") && row.driver) due.push("accepted");
  if (!told.has(row.status) && TOLD[row.status]) due.push(row.status);
  if (!due.length) return;
  for (const d of due) told.add(d);
  await run(`UPDATE ride_bookings SET told = $2 WHERE id = $1`, [row.id, [...told].join(",")]);
  const ride = shape(row);
  const u = await one(`SELECT fcm_token FROM users WHERE id = $1`, [row.user_id]);
  if (!u?.fcm_token) return;
  for (const d of due) {
    const [title, body] = TOLD[d](ride);
    await require("../services/push").sendNotification(u.fcm_token, ride.test ? `${title} (Test)` : title, body,
      { kind: "ride_update", rideId: String(ride.id), status: ride.status }).catch(() => false);
  }
}

function register(jobs) {
  jobs.register(JOB, onJob);
}

const USER_TABLES = [["ride_bookings", "user_id"], ["ride_accounts", "user_id"]];

module.exports = { migrate, canBook, book, active, cancel, onJob, register, shape, USER_TABLES, JOB, MAX_FARE };
