/**
 * IN-APP SHOPPING OVER ONDC (2026-11-04) — the app's side.
 *
 *   GET  /shop/status                 { configured, env }
 *   POST /shop/search                 { domain, q?, lat, lng, areaCode? } → { transactionId }
 *   GET  /shop/search/:txn            → { stores:[…], replies, waitingMs }
 *   POST /shop/select                 { transactionId, domain, bppId, bppUri, providerId,
 *                                       locationId?, items:[{id, quantity}], lat, lng, areaCode? }
 *   GET  /shop/quote/:txn             → { quote | null }
 *   POST /shop/init                   { …select fields, billing:{name, phone, email?, address},
 *                                       delivery:{name, phone, address, lat, lng, areaCode} }
 *   GET  /shop/init/:txn              → the seller's terms and payment details
 *
 *   POST /shop/pay                    { transactionId } → { orderId, url, amount }
 *                                     (a Razorpay link for the seller's on_init total)
 *   POST /shop/confirm                { orderId } → paid? then ONDC confirm
 *   GET  /shop/orders                 the user's orders
 *   GET  /shop/orders/:id             one order, with the seller's latest state
 *   POST /shop/orders/:id/refresh     ask the seller for the status now
 *   POST /shop/orders/:id/cancel      { reasonId? }
 *
 * Every call is the signed-in user's own: a transaction started by someone
 * else is a 404. Search falls back to the phone's location headers.
 */
const router = require("express").Router();
const { cfg, configured, DOMAINS } = require("../ondc/config");
const client = require("../ondc/client");
const store = require("../ondc/store");
const catalog = require("../ondc/catalog");

const uid = (req) => {
  const n = Number(req.user?.sub);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const gps = (lat, lng) => `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
const domainOf = (d) => DOMAINS[d] || DOMAINS.grocery;

async function owned(req, txn) {
  const rows = await require("../db").query(
    "SELECT user_id FROM ondc_requests WHERE transaction_id = $1 LIMIT 1", [txn]).catch(() => []);
  return rows[0] && rows[0].user_id === uid(req);
}

router.get("/status", (_req, res) => res.json({
  configured: configured(), env: cfg().env, payments: require("../ondc/pay").enabled(),
}));

router.use((req, res, next) => {
  if (!configured()) return res.status(503).json({ configured: false, error: "ONDC is not connected yet" });
  if (!uid(req)) return res.status(401).json({ error: "sign in first" });
  store.migrate().then(() => next(), (e) => res.status(500).json({ error: e.message }));
});

router.post("/search", async (req, res) => {
  const { domain, q, areaCode } = req.body || {};
  const lat = req.body?.lat ?? parseFloat(req.get("X-Geo-Lat"));
  const lng = req.body?.lng ?? parseFloat(req.get("X-Geo-Lng"));
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    return res.status(400).json({ error: "the delivery location is needed" });
  }
  const intent = {
    fulfillment: {
      type: "Delivery",
      end: { location: { gps: gps(lat, lng), ...(areaCode ? { address: { area_code: String(areaCode) } } : {}) } },
    },
    payment: {
      "@ondc/org/buyer_app_finder_fee_type": "percent",
      "@ondc/org/buyer_app_finder_fee_amount": String(process.env.ONDC_FINDER_FEE_PERCENT || "3"),
    },
  };
  if (q && String(q).trim()) intent.item = { descriptor: { name: String(q).trim().slice(0, 80) } };
  const r = await client.send("search", {
    domain: domainOf(domain), message: { intent }, userId: uid(req),
  });
  if (!r.ok) return res.status(502).json({ error: r.error });
  res.json({ transactionId: r.transactionId });
});

router.get("/search/:txn", async (req, res) => {
  if (!(await owned(req, req.params.txn))) return res.status(404).json({ error: "not found" });
  const rows = await store.responses(req.params.txn, "on_search");
  res.json({ stores: catalog.flatten(rows), replies: rows.length });
});

function orderBody(b) {
  return {
    provider: { id: String(b.providerId), ...(b.locationId ? { locations: [{ id: String(b.locationId) }] } : {}) },
    items: (b.items || []).slice(0, 50).map((i) => ({
      id: String(i.id),
      quantity: { count: Math.max(1, Math.min(99, parseInt(i.quantity, 10) || 1)) },
      ...(b.locationId ? { location_id: String(b.locationId) } : {}),
    })),
  };
}

router.post("/select", async (req, res) => {
  // (providerName rides along to init, where the order row is written.)
  const b = req.body || {};
  if (!(await owned(req, b.transactionId))) return res.status(404).json({ error: "not found" });
  if (!b.bppId || !b.bppUri || !b.providerId || !(b.items || []).length) {
    return res.status(400).json({ error: "a store and at least one item are needed" });
  }
  const r = await client.send("select", {
    domain: domainOf(b.domain), transactionId: b.transactionId, bppId: b.bppId, bppUri: b.bppUri,
    userId: uid(req),
    message: {
      order: {
        ...orderBody(b),
        fulfillments: [{ end: { location: { gps: gps(b.lat, b.lng),
          ...(b.areaCode ? { address: { area_code: String(b.areaCode) } } : {}) } } }],
      },
    },
  });
  if (!r.ok) return res.status(502).json({ error: r.error });
  res.json({ messageId: r.messageId });
});

router.get("/quote/:txn", async (req, res) => {
  if (!(await owned(req, req.params.txn))) return res.status(404).json({ error: "not found" });
  const rows = await store.responses(req.params.txn, "on_select");
  res.json({ quote: rows.length ? catalog.quote(rows[rows.length - 1]) : null });
});

router.post("/init", async (req, res) => {
  const b = req.body || {};
  if (!(await owned(req, b.transactionId))) return res.status(404).json({ error: "not found" });
  const bill = b.billing || {};
  const del = b.delivery || {};
  if (!bill.name || !bill.phone || !del.address || !del.phone) {
    return res.status(400).json({ error: "name, phone and delivery address are needed" });
  }
  const address = (a) => ({
    name: a.name || bill.name,
    building: a.building || "",
    locality: a.locality || a.address || "",
    city: a.city || "",
    state: a.state || "",
    country: "IND",
    area_code: String(a.areaCode || del.areaCode || ""),
  });
  const r = await client.send("init", {
    domain: domainOf(b.domain), transactionId: b.transactionId, bppId: b.bppId, bppUri: b.bppUri,
    userId: uid(req),
    message: {
      order: {
        ...orderBody(b),
        billing: {
          name: bill.name, phone: String(bill.phone), email: bill.email || undefined,
          address: address({ ...bill, ...(bill.address || {}) }),
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
        fulfillments: [{
          id: b.fulfillmentId || "1",
          type: "Delivery",
          end: {
            location: { gps: gps(del.lat, del.lng), address: address(del) },
            contact: { phone: String(del.phone), email: del.email || undefined },
          },
        }],
        payment: { type: "ON-ORDER", collected_by: "BAP" },
      },
    },
  });
  if (!r.ok) return res.status(502).json({ error: r.error });
  const db = require("../db");
  const now = Date.now();
  // One order row per transaction: the cart and address as sent.
  await db.run("DELETE FROM ondc_orders WHERE transaction_id = $1 AND user_id = $2 AND state IN ('cart','initialised')",
    [b.transactionId, uid(req)]);
  await db.run(
    `INSERT INTO ondc_orders (user_id, transaction_id, domain, bpp_id, bpp_uri, provider_id, provider_name,
       items, billing, fulfillment, state, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'initialised',$11,$11)`,
    [uid(req), b.transactionId, domainOf(b.domain), b.bppId, b.bppUri, String(b.providerId),
      b.providerName || null, JSON.stringify(orderBody(b)), JSON.stringify(bill), JSON.stringify(del), now]);
  res.json({ messageId: r.messageId });
});

router.get("/init/:txn", async (req, res) => {
  if (!(await owned(req, req.params.txn))) return res.status(404).json({ error: "not found" });
  const rows = await store.responses(req.params.txn, "on_init");
  const last = rows[rows.length - 1];
  res.json({ order: last ? last.payload.message?.order || null : null,
    error: last?.payload?.error?.message || null });
});

/* ------------------------------------------------------------------ */
/* PAY, CONFIRM, ORDERS                                                */
/* ------------------------------------------------------------------ */

const pay = require("../ondc/pay");
const db = () => require("../db");

async function myOrder(req, id) {
  return db().one("SELECT * FROM ondc_orders WHERE id = $1 AND user_id = $2", [Number(id), uid(req)]);
}

router.post("/pay", async (req, res) => {
  if (!pay.enabled()) return res.status(503).json({ error: "payments are not set up yet" });
  const txn = req.body?.transactionId;
  const order = await db().one(
    "SELECT * FROM ondc_orders WHERE transaction_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 1",
    [txn, uid(req)]);
  if (!order) return res.status(404).json({ error: "not found" });
  const rows = await store.responses(txn, "on_init");
  const onInit = rows[rows.length - 1]?.payload?.message?.order;
  const total = Number(onInit?.quote?.price?.value);
  if (!onInit || !Number.isFinite(total)) return res.status(409).json({ error: "the store has not confirmed the price yet" });
  try {
    const bill = order.billing || {};
    const link = await pay.createLink({
      amountRupees: total,
      description: `${order.provider_name || "Order"} via MyAssistant`,
      name: bill.name, phone: bill.phone, referenceId: `ondc-${order.id}`,
    });
    await db().run(
      "UPDATE ondc_orders SET quote = $1, payment = $2, state = 'awaiting_payment', updated_at = $3 WHERE id = $4",
      [JSON.stringify(onInit.quote), JSON.stringify({ linkId: link.id, url: link.url, amount: total,
        settlement: onInit.payment || null }), Date.now(), order.id]);
    res.json({ orderId: order.id, url: link.url, amount: total });
  } catch (e) {
    res.status(502).json({ error: `payment: ${e.message}` });
  }
});

router.post("/confirm", async (req, res) => {
  const order = await myOrder(req, req.body?.orderId);
  if (!order) return res.status(404).json({ error: "not found" });
  if (order.state !== "awaiting_payment" && order.state !== "paid") {
    return res.json({ orderId: order.id, state: order.state });
  }
  const p = order.payment || {};
  let st;
  try { st = await pay.linkStatus(p.linkId); } catch (e) { return res.status(502).json({ error: e.message }); }
  if (!st.paid) return res.json({ orderId: order.id, state: "awaiting_payment", paid: false });
  const rows = await store.responses(order.transaction_id, "on_init");
  const onInit = rows[rows.length - 1]?.payload?.message?.order || {};
  const now = new Date().toISOString();
  const r = await client.send("confirm", {
    domain: order.domain, transactionId: order.transaction_id, bppId: order.bpp_id, bppUri: order.bpp_uri,
    userId: uid(req),
    message: {
      order: {
        id: `MA-${order.id}-${Date.now().toString(36)}`,
        state: "Created",
        provider: onInit.provider || order.items.provider,
        items: onInit.items || order.items.items,
        billing: onInit.billing,
        fulfillments: onInit.fulfillments,
        quote: onInit.quote,
        payment: {
          ...(onInit.payment || {}),
          type: "ON-ORDER",
          collected_by: "BAP",
          status: "PAID",
          params: {
            amount: String(p.amount),
            currency: "INR",
            transaction_id: st.paymentId,
          },
        },
        tags: onInit.tags,
        created_at: now,
        updated_at: now,
      },
    },
  });
  await db().run("UPDATE ondc_orders SET state = $1, payment = $2, updated_at = $3 WHERE id = $4",
    [r.ok ? "placed" : "paid", JSON.stringify({ ...p, paymentId: st.paymentId, paid: true }), Date.now(), order.id]);
  if (!r.ok) return res.status(502).json({ orderId: order.id, state: "paid", error: r.error });
  res.json({ orderId: order.id, state: "placed", paid: true });
});

/** The order as the app shows it, with the seller's latest word. */
async function view(order) {
  const latest = async (action) => {
    const rows = await store.responses(order.transaction_id, action);
    return rows[rows.length - 1]?.payload || null;
  };
  const conf = (await latest("on_status")) || (await latest("on_update")) || (await latest("on_confirm"));
  const o = conf?.message?.order || {};
  const f = (o.fulfillments || [])[0] || {};
  const tracking = await latest("on_track");
  return {
    id: order.id,
    domain: order.domain,
    store: order.provider_name,
    state: o.state || order.state,
    fulfillmentState: f.state?.descriptor?.code || null,
    sellerOrderId: o.id || null,
    total: Number.isFinite(Number(order.payment?.amount)) ? Number(order.payment.amount)
      : Number.isFinite(Number(order.quote?.price?.value)) ? Number(order.quote.price.value) : null,
    items: (order.quote?.breakup || []).filter((b) => b["@ondc/org/title_type"] === "item")
      .map((b) => ({ name: b.title, quantity: b["@ondc/org/item_quantity"]?.count || 1, price: Number(b.price?.value) })),
    agent: f.agent ? { name: f.agent.name || null, phone: f.agent.phone || null } : null,
    trackingUrl: tracking?.message?.tracking?.url || null,
    paid: Boolean(order.payment?.paid),
    paymentUrl: order.state === "awaiting_payment" ? order.payment?.url || null : null,
    createdAt: Number(order.created_at),
    updatedAt: Number(order.updated_at),
  };
}

router.get("/orders", async (req, res) => {
  const rows = await db().query(
    `SELECT * FROM ondc_orders WHERE user_id = $1 AND state NOT IN ('cart','initialised')
     ORDER BY updated_at DESC LIMIT 50`, [uid(req)]);
  res.json({ orders: await Promise.all(rows.map(view)) });
});

router.get("/orders/:id", async (req, res) => {
  const order = await myOrder(req, req.params.id);
  if (!order) return res.status(404).json({ error: "not found" });
  res.json({ order: await view(order) });
});

router.post("/orders/:id/refresh", async (req, res) => {
  const order = await myOrder(req, req.params.id);
  if (!order) return res.status(404).json({ error: "not found" });
  const conf = (await store.responses(order.transaction_id, "on_confirm")).pop();
  const sellerId = conf?.payload?.message?.order?.id;
  if (!sellerId) return res.json({ order: await view(order) });
  await client.send("status", {
    domain: order.domain, transactionId: order.transaction_id, bppId: order.bpp_id, bppUri: order.bpp_uri,
    userId: uid(req), message: { order_id: sellerId },
  });
  res.json({ order: await view(order) });
});

router.post("/orders/:id/cancel", async (req, res) => {
  const order = await myOrder(req, req.params.id);
  if (!order) return res.status(404).json({ error: "not found" });
  const conf = (await store.responses(order.transaction_id, "on_confirm")).pop();
  const sellerId = conf?.payload?.message?.order?.id;
  if (!sellerId) return res.status(409).json({ error: "the store has not accepted the order yet" });
  const r = await client.send("cancel", {
    domain: order.domain, transactionId: order.transaction_id, bppId: order.bpp_id, bppUri: order.bpp_uri,
    userId: uid(req),
    // ONDC cancellation reason 001: "price of one or more items has changed"… the
    // buyer's own change of mind is 006 in the retail spec's list.
    message: { order_id: sellerId, cancellation_reason_id: String(req.body?.reasonId || "006") },
  });
  if (!r.ok) return res.status(502).json({ error: r.error });
  await db().run("UPDATE ondc_orders SET state = 'cancelling', updated_at = $1 WHERE id = $2", [Date.now(), order.id]);
  res.json({ ok: true });
});

module.exports = router;
