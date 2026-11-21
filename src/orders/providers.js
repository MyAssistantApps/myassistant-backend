/**
 * ORDER PROVIDERS — food, groceries, medicines, parcels (owner, 2026-11-21).
 *
 * The same seam as rides (src/rides/providers.js). Every provider:
 *
 *   id, label, kinds          which of food | grocery | medicine | parcel
 *   available()               credentials set and switched on
 *   quote({ kind, items, restaurant, pickup, drop, userId })
 *                             → { total, currency, etaMin, summary, ref }
 *   place({ ...same, ref })   → { externalId, status, total, etaMin, summary }
 *   status(externalId, ctx)   → { status, partner, otp, etaMin }
 *   cancel(externalId, ctx)   → true
 *
 * Statuses: placed | confirmed | preparing | out_for_delivery | delivered |
 * cancelled | failed. (Parcels: placed | confirmed | picked_up |
 * out_for_delivery | delivered.)
 *
 * WHICH ARE LIVE
 * - test: simulated end to end for every kind, never contacts anyone,
 *   every word says TEST. Only with ORDERS_TEST_PROVIDER=on.
 * - swiggy: Swiggy's official MCP servers (Food, Instamart) for AI
 *   assistants. Needs Builders Club production approval; each user links
 *   their Swiggy account (OAuth 2.1, PKCE). The tools are discovered from
 *   the server, so their exact names are matched at run time.
 *   SWIGGY_CLIENT_ID, SWIGGY_ORDERS_ENABLED=on.
 * - porter (parcel) and tata1mg (medicine): enterprise/partner APIs whose
 *   documentation is shared only after a business agreement. Declared here
 *   so the flow, the tools and the app are ready; their calls are filled
 *   in from the docs the company sends (docs/OWNER_ACTIONS.md).
 *
 * With no provider for a kind, the tools keep opening the right app or
 * search (the deep-link handoff that works today).
 */
const crypto = require("crypto");

/* ------------------------------------------------------------------ *
 * TEST PROVIDER
 * ------------------------------------------------------------------ */
const STEP_MS = Number(process.env.ORDERS_TEST_STEP_MS) || 30_000;
const testOrders = new Map();
const FLOWS = {
  food: ["placed", "confirmed", "preparing", "out_for_delivery", "delivered"],
  grocery: ["placed", "confirmed", "preparing", "out_for_delivery", "delivered"],
  medicine: ["placed", "confirmed", "preparing", "out_for_delivery", "delivered"],
  parcel: ["placed", "confirmed", "picked_up", "out_for_delivery", "delivered"],
};
const PRICE = { food: 249, grocery: 60, medicine: 120, parcel: 90 };

const test = {
  id: "test",
  label: "Test Store",
  test: true,
  kinds: ["food", "grocery", "medicine", "parcel"],
  available: () => process.env.ORDERS_TEST_PROVIDER === "on",
  async quote({ kind, items = [], restaurant }) {
    const n = Math.max(1, items.length);
    const total = kind === "parcel" ? PRICE.parcel : PRICE[kind] * n + (kind === "food" ? 40 : 0);
    const what = items.length ? items.join(", ") : kind;
    return {
      total, currency: "INR",
      etaMin: { food: 35, grocery: 15, medicine: 45, parcel: 50 }[kind],
      summary: kind === "parcel" ? `Parcel: ${what}` : `${what}${restaurant ? ` from ${restaurant}` : ""}`,
      ref: `q_${crypto.randomBytes(4).toString("hex")}`,
    };
  },
  async place(args) {
    const q = await test.quote(args);
    const externalId = `test_${crypto.randomBytes(6).toString("hex")}`;
    testOrders.set(externalId, { kind: args.kind, createdAt: Date.now(), step: 0, cancelled: false,
      otp: String(crypto.randomInt(1000, 10000)) });
    return { externalId, status: "placed", total: q.total, currency: q.currency, etaMin: q.etaMin, summary: q.summary };
  },
  async status(externalId) {
    const o = testOrders.get(externalId);
    if (!o || o.cancelled) return { status: "cancelled" };
    if (Date.now() - o.createdAt >= (o.step + 1) * STEP_MS) o.step++;
    const flow = FLOWS[o.kind];
    const status = flow[Math.min(o.step, flow.length - 1)];
    const out = { status, etaMin: Math.max(0, 30 - o.step * 8) };
    if (status === "out_for_delivery" || status === "picked_up") {
      out.partner = { name: "Test Delivery Partner", phone: "" };
      out.otp = o.otp;
    }
    return out;
  },
  async cancel(externalId) {
    const o = testOrders.get(externalId);
    if (!o) return false;
    if (["out_for_delivery", "delivered"].includes(FLOWS[o.kind][o.step])) return false;
    o.cancelled = true;
    return true;
  },
};

/* ------------------------------------------------------------------ *
 * SWIGGY — official MCP servers (Food, Instamart).
 * ------------------------------------------------------------------ */
const SWIGGY_URLS = {
  food: process.env.SWIGGY_MCP_FOOD_URL || "https://mcp.swiggy.com/food",
  grocery: process.env.SWIGGY_MCP_IM_URL || "https://mcp.swiggy.com/im",
};

async function swiggyClient(userId, kind) {
  const access = await require("../accounts/service").tokenFor(userId, "swiggy");
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "myassistant", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(SWIGGY_URLS[kind]), {
    requestInit: { headers: { Authorization: `Bearer ${access}` } },
  }));
  const { tools } = await client.listTools();
  // The tool names are Swiggy's; match them by what they do.
  const pick = (...words) => tools.find((t) => words.every((w) => t.name.toLowerCase().includes(w)))?.name;
  return {
    client,
    call: async (name, args) => {
      if (!name) throw new Error("this Swiggy server has no such tool");
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content || []).map((c) => c.text || "").join("\n");
      try { return JSON.parse(text); } catch { return { text }; }
    },
    tools: {
      search: pick("search") || pick("find"),
      addToCart: pick("cart", "add") || pick("add", "item"),
      cart: pick("get", "cart") || pick("cart"),
      order: pick("place", "order") || pick("checkout"),
      track: pick("track") || pick("order", "status"),
      cancel: pick("cancel"),
    },
  };
}

const swiggy = {
  id: "swiggy",
  label: "Swiggy",
  kinds: ["food", "grocery"],
  available: () => Boolean(process.env.SWIGGY_CLIENT_ID && process.env.SWIGGY_ORDERS_ENABLED === "on"),
  async quote({ kind, items = [], restaurant, userId }) {
    const s = await swiggyClient(userId, kind);
    try {
      for (const item of items.length ? items : [restaurant]) {
        const found = await s.call(s.tools.search, { query: restaurant ? `${item} ${restaurant}` : item });
        const first = (found.items || found.results || found.restaurants || [])[0];
        if (first) await s.call(s.tools.addToCart, { item_id: first.id || first.item_id, quantity: 1 });
      }
      const cart = await s.call(s.tools.cart, {});
      return { total: cart.total ?? cart.to_pay ?? null, currency: "INR", etaMin: cart.eta ?? null,
        summary: (cart.items || []).map((i) => i.name).join(", ") || items.join(", "), ref: cart.cart_id || "" };
    } finally {
      await s.client.close().catch(() => {});
    }
  },
  async place({ kind, userId }) {
    const s = await swiggyClient(userId, kind);
    try {
      const o = await s.call(s.tools.order, {});
      return { externalId: String(o.order_id || o.id || ""), status: "placed", total: o.total ?? null, etaMin: o.eta ?? null };
    } finally {
      await s.client.close().catch(() => {});
    }
  },
  async status(externalId, { userId, kind }) {
    const s = await swiggyClient(userId, kind);
    try {
      const t = await s.call(s.tools.track, { order_id: externalId });
      const map = { PLACED: "placed", CONFIRMED: "confirmed", PREPARING: "preparing", PICKED_UP: "out_for_delivery",
        OUT_FOR_DELIVERY: "out_for_delivery", DELIVERED: "delivered", CANCELLED: "cancelled" };
      return { status: map[String(t.status || "").toUpperCase()] || "confirmed", etaMin: t.eta ?? null,
        partner: t.delivery_partner ? { name: t.delivery_partner.name, phone: t.delivery_partner.phone } : null,
        otp: t.otp || t.delivery_otp || null };
    } finally {
      await s.client.close().catch(() => {});
    }
  },
  async cancel(externalId, { userId, kind }) {
    const s = await swiggyClient(userId, kind);
    try {
      await s.call(s.tools.cancel, { order_id: externalId });
      return true;
    } finally {
      await s.client.close().catch(() => {});
    }
  },
};

/* ------------------------------------------------------------------ *
 * PORTER (parcels) and TATA 1MG (medicines): agreement first.
 * ------------------------------------------------------------------ */
function awaitingAgreement(id, label, kinds, envKey) {
  const notYet = () => {
    throw Object.assign(new Error(`${label} API calls are added from the documentation ${label} shares after the agreement`), { code: "not_configured" });
  };
  return { id, label, kinds, available: () => Boolean(process.env[envKey]) && process.env[`${envKey}_READY`] === "on",
    quote: notYet, place: notYet, status: notYet, cancel: notYet };
}
const porter = awaitingAgreement("porter", "Porter", ["parcel"], "PORTER_API_KEY");
const tata1mg = awaitingAgreement("tata1mg", "Tata 1mg", ["medicine"], "TATA1MG_API_KEY");

const ALL = { test, swiggy, porter, tata1mg };

/** Providers that can take this kind of order now, real ones first. */
function live(kind) {
  return [swiggy, porter, tata1mg, test].filter((p) => {
    try { return p.kinds.includes(kind) && p.available(); } catch { return false; }
  });
}

module.exports = { ALL, live, FLOWS, _testOrders: testOrders };
