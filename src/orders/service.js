/**
 * ORDER BY VOICE — food, groceries, medicines, parcels (owner, 2026-11-21).
 * The rides flow (src/rides/service.js) for everything else that is
 * delivered: quote from every provider that can take it, cheapest wins
 * unless one was named, a total over ORDERS_MAX_TOTAL waits for a yes,
 * place, confirm in one sentence, then follow it with a push per step
 * (the delivery partner and OTP included) and a Home card with Cancel.
 *
 * Medicines: prescription medicines are never ordered by voice alone; the
 * user is told the pharmacy will ask for the prescription (and the test
 * provider says so too). Parcels need a pickup and a drop-off.
 */
const { one, run } = require("../db");
const providers = require("./providers");

const POLL_MS = Number(process.env.ORDERS_POLL_MS) || 30_000;
const MAX_POLL_MIN = 240;
const MAX_TOTAL = Number(process.env.ORDERS_MAX_TOTAL) || 2000;
const JOB = "order_status";
const TERMINAL = new Set(["delivered", "cancelled", "failed"]);
const KINDS = ["food", "grocery", "medicine", "parcel"];
const NOUN = { food: "food order", grocery: "grocery order", medicine: "medicine order", parcel: "parcel pickup" };

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS order_bookings (
        id           BIGSERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL,
        kind         TEXT NOT NULL,
        provider     TEXT NOT NULL,
        external_id  TEXT NOT NULL DEFAULT '',
        test         INTEGER NOT NULL DEFAULT 0,
        summary      TEXT NOT NULL DEFAULT '',
        details      JSONB NOT NULL DEFAULT '{}',
        total        NUMERIC,
        currency     TEXT NOT NULL DEFAULT 'INR',
        status       TEXT NOT NULL DEFAULT 'placed',
        partner      JSONB,
        otp          TEXT NOT NULL DEFAULT '',
        eta_min      INTEGER,
        told         TEXT NOT NULL DEFAULT '',
        created_at   BIGINT NOT NULL,
        updated_at   BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_order_bookings_user ON order_bookings(user_id, id DESC);
      CREATE TABLE IF NOT EXISTS order_accounts (
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

const canOrder = (kind) => providers.live(kind).length > 0;

function shape(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    kind: r.kind,
    provider: r.provider,
    providerLabel: providers.ALL[r.provider]?.label || r.provider,
    test: Boolean(Number(r.test)),
    summary: r.summary,
    total: r.total != null ? Number(r.total) : null,
    currency: r.currency,
    status: r.status,
    partner: r.partner || null,
    otp: r.otp || "",
    etaMin: r.eta_min != null ? Number(r.eta_min) : null,
    createdAt: Number(r.created_at),
  };
}

/**
 * Places an order. { userId, kind, items[], restaurant?, pickup?, drop?,
 * provider?, confirmTotal? } → { ok, order, speak } | { ok:false, ... }.
 */
async function place({ userId, kind, items = [], restaurant, pickup, drop, provider, confirmTotal = false }) {
  await migrate();
  if (!KINDS.includes(kind)) return { ok: false, error: "unknown kind" };
  const live = providers.live(kind);
  if (!live.length) return { ok: false, error: "no_provider" };
  items = (Array.isArray(items) ? items : [items]).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 20);
  if (kind === "parcel" && (!pickup || !drop)) {
    return { ok: false, needs: !pickup ? "pickup" : "drop", error: "a parcel needs a pickup and a drop-off address" };
  }
  if (kind !== "parcel" && !items.length && !restaurant) return { ok: false, needs: "items", error: "what should be ordered?" };

  const pool = provider ? live.filter((p) => p.id === provider) : live;
  if (!pool.length) return { ok: false, error: "provider_unavailable",
    speak: `${providers.ALL[provider]?.label || provider} cannot take this order from here yet.` };
  const args = { kind, items, restaurant, pickup, drop, userId };
  const quotes = [];
  const unlinked = [];
  for (const p of pool) {
    try {
      quotes.push({ p, q: await p.quote(args) });
    } catch (e) {
      if (e?.code === "link_required") unlinked.push(p.label);
    }
  }
  if (!quotes.length && unlinked.length) {
    return { ok: false, error: "link_required",
      speak: `Please link your ${unlinked.join(" or ")} account first; I have opened Linked Accounts for you.` };
  }
  if (!quotes.length) return { ok: false, error: "no_quote", speak: `No ${NOUN[kind]} could be priced right now.` };
  const real = quotes.filter((x) => !x.p.test);
  const best = (real.length ? real : quotes).sort((a, b) => (a.q.total ?? 1e9) - (b.q.total ?? 1e9))[0];
  if (best.q.total != null && best.q.total > MAX_TOTAL && !confirmTotal) {
    return { ok: false, needs: "total_confirmation", total: best.q.total,
      speak: `That comes to about Rs ${best.q.total} with ${best.p.label}. Shall I place it?` };
  }

  const placed = await best.p.place({ ...args, ref: best.q.ref });
  const now = Date.now();
  const row = await one(
    `INSERT INTO order_bookings (user_id, kind, provider, external_id, test, summary, details, total, currency, status, eta_min, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
    [userId, kind, best.p.id, placed.externalId, best.p.test ? 1 : 0, placed.summary || best.q.summary || items.join(", "),
      { items, restaurant: restaurant || null, pickup: pickup || null, drop: drop || null },
      placed.total ?? best.q.total ?? null, placed.currency || best.q.currency || "INR", placed.status || "placed",
      placed.etaMin ?? best.q.etaMin ?? null, now]);
  await require("../infra/jobs").enqueue(JOB, { id: Number(row.id) }, { userId, delayMs: POLL_MS });
  const order = shape(row);
  const total = order.total != null ? `, about Rs ${order.total}` : "";
  const eta = order.etaMin != null ? ` It should arrive in about ${order.etaMin} minutes.` : "";
  const rx = kind === "medicine" ? " If any of these need a prescription, the pharmacy will ask you to upload it." : "";
  const testWords = order.test ? " This is a TEST order: nothing real is coming." : "";
  return {
    ok: true,
    order,
    speak: kind === "parcel"
      ? `Booked. A ${order.providerLabel} pickup for ${order.summary.replace(/^Parcel: /, "")} from ${pickup} to ${drop}${total}. I will tell you when it is picked up.${testWords}`
      : `Ordered. ${order.summary} from ${order.providerLabel}${total}.${eta}${rx}${testWords}`,
  };
}

async function activeList(userId) {
  await migrate();
  const { query } = require("../db");
  const rows = await query(
    `SELECT * FROM order_bookings WHERE user_id = $1 AND status NOT IN ('delivered','cancelled','failed')
      ORDER BY id DESC LIMIT 5`, [userId]);
  return rows.map(shape);
}

async function cancel(userId, id) {
  await migrate();
  const r = await one(
    id ? `SELECT * FROM order_bookings WHERE id = $2 AND user_id = $1` :
      `SELECT * FROM order_bookings WHERE user_id = $1 AND status NOT IN ('delivered','cancelled','failed') ORDER BY id DESC LIMIT 1`,
    id ? [userId, id] : [userId]);
  if (!r || TERMINAL.has(r.status)) return { ok: false, error: "none" };
  const p = providers.ALL[r.provider];
  const ok = p ? await p.cancel(r.external_id, { userId, kind: r.kind }).catch(() => false) : false;
  if (!ok) return { ok: false, error: "too_late", order: shape(r) };
  const row = await one(`UPDATE order_bookings SET status = 'cancelled', updated_at = $2 WHERE id = $1 RETURNING *`, [r.id, Date.now()]);
  return { ok: true, order: shape(row) };
}

const TOLD = {
  confirmed: (o) => [`${label(o)} Confirmed`, `${o.providerLabel} has accepted your order: ${o.summary}.`],
  preparing: (o) => [o.kind === "food" ? "Your Food Is Being Prepared" : "Your Order Is Being Packed", o.summary],
  picked_up: (o) => ["Parcel Picked Up", `${o.partner?.name || "The delivery partner"} has your parcel.${o.otp ? ` Delivery OTP ${o.otp}.` : ""}`],
  out_for_delivery: (o) => ["Out for Delivery",
    `${o.partner?.name || "Your delivery partner"} is on the way${o.etaMin != null ? `, about ${o.etaMin} min` : ""}.${o.otp ? ` Your OTP is ${o.otp}.` : ""}`],
  delivered: (o) => ["Delivered", `${o.summary} has been delivered.`],
  cancelled: (o) => ["Order Cancelled", `${o.summary} was cancelled.`],
  failed: (o) => ["Order Failed", `${o.summary} could not be completed. Please try again.`],
};
const label = (o) => ({ food: "Food Order", grocery: "Grocery Order", medicine: "Medicine Order", parcel: "Parcel Pickup" })[o.kind] || "Order";

async function onJob(payload) {
  await migrate();
  const r = await one(`SELECT * FROM order_bookings WHERE id = $1`, [payload.id]);
  if (!r || TERMINAL.has(r.status)) return;
  const p = providers.ALL[r.provider];
  let s = null;
  try {
    s = await p.status(r.external_id, { userId: r.user_id, kind: r.kind });
  } catch { /* a missed poll: next time */ }
  if (s) {
    const row = await one(
      `UPDATE order_bookings SET status = $2, partner = COALESCE($3, partner), otp = COALESCE(NULLIF($4, ''), otp),
              eta_min = $5, updated_at = $6 WHERE id = $1 RETURNING *`,
      [r.id, s.status, s.partner ? JSON.stringify(s.partner) : null, s.otp || "", s.etaMin ?? null, Date.now()]);
    await tell(row);
    if (TERMINAL.has(row.status)) return;
  }
  if (Date.now() - Number(r.created_at) > MAX_POLL_MIN * 60_000) return;
  await require("../infra/jobs").enqueue(JOB, { id: Number(r.id) }, { userId: r.user_id, delayMs: POLL_MS });
}

async function tell(row) {
  const told = new Set(String(row.told || "").split(",").filter(Boolean));
  if (told.has(row.status) || !TOLD[row.status]) return;
  told.add(row.status);
  await run(`UPDATE order_bookings SET told = $2 WHERE id = $1`, [row.id, [...told].join(",")]);
  const o = shape(row);
  const [title, body] = TOLD[row.status](o);
  const u = await one(`SELECT fcm_token FROM users WHERE id = $1`, [row.user_id]);
  if (!u?.fcm_token) return;
  await require("../services/push").sendNotification(u.fcm_token, o.test ? `${title} (Test)` : title, body,
    { kind: "order_update", orderId: String(o.id), status: o.status }).catch(() => false);
}

function register(jobs) {
  jobs.register(JOB, onJob);
}

const USER_TABLES = [["order_bookings", "user_id"], ["order_accounts", "user_id"]];

module.exports = { migrate, canOrder, place, activeList, cancel, onJob, register, shape, USER_TABLES, JOB, KINDS };
