/**
 * RAZORPAY FOR THE WALLET — Orders API + payment fetch + Checkout signature.
 *
 * The wallet never trusts the app about money. A top-up is an ORDER the
 * server creates for an amount it chose; the app only opens Checkout for
 * that order. Afterwards the server (a) checks Checkout's signature, and
 * (b) asks Razorpay itself what was paid, before crediting anything.
 *
 * Keys come from the server's environment only (RAZORPAY_KEY_ID /
 * RAZORPAY_KEY_SECRET — test keys until the live launch gate). The app
 * gets the key ID in the top-up response; the secret never leaves here.
 */
const crypto = require("crypto");

const API = "https://api.razorpay.com/v1";
const TIMEOUT_MS = 12_000;

let fetchImpl = (...a) => fetch(...a);

function cfg() {
  return {
    keyId: process.env.RAZORPAY_KEY_ID || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "",
  };
}

function enabled() {
  const c = cfg();
  return Boolean(c.keyId && c.keySecret);
}

/** True when the configured key is a TEST key (rzp_test_…). */
function testMode() {
  return cfg().keyId.startsWith("rzp_test_");
}

async function call(method, path, body) {
  const c = cfg();
  if (!c.keyId || !c.keySecret) {
    const e = new Error("payments are not configured");
    e.code = "payments_unavailable";
    throw e;
  }
  const auth = Buffer.from(`${c.keyId}:${c.keySecret}`).toString("base64");
  let r;
  try {
    r = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const e = new Error(`razorpay unreachable: ${err.message || err}`);
    e.code = "payments_unavailable";
    throw e;
  }
  let j = null;
  try {
    j = await r.json();
  } catch (_) {
    j = null;
  }
  if (!r.ok) {
    const e = new Error(j?.error?.description || `razorpay ${r.status}`);
    e.code = r.status >= 500 ? "payments_unavailable" : "razorpay_rejected";
    e.status = r.status;
    throw e;
  }
  return j;
}

/** Creates an order for exactly [amountPaise]. receipt ≤ 40 chars. */
function createOrder({ amountPaise, receipt, notes = {} }) {
  return call("POST", "/orders", {
    amount: amountPaise,
    currency: "INR",
    receipt: String(receipt).slice(0, 40),
    notes,
  });
}

/** One payment, as Razorpay has it now. */
function fetchPayment(paymentId) {
  if (!/^pay_[A-Za-z0-9]+$/.test(String(paymentId || ""))) {
    const e = new Error("not a payment id");
    e.code = "bad_payment_id";
    return Promise.reject(e);
  }
  return call("GET", `/payments/${paymentId}`);
}

/** Every payment attempt made against an order. */
async function orderPayments(orderId) {
  if (!/^order_[A-Za-z0-9]+$/.test(String(orderId || ""))) {
    const e = new Error("not an order id");
    e.code = "bad_order_id";
    throw e;
  }
  const j = await call("GET", `/orders/${orderId}/payments`);
  return Array.isArray(j?.items) ? j.items : [];
}

/**
 * Payments captured between two times (Unix seconds), one page of up to
 * 100 — for the daily check that no captured top-up was missed.
 */
async function listPayments({ from, to, skip = 0 }) {
  const j = await call("GET", `/payments?from=${Math.floor(from)}&to=${Math.floor(to)}&count=100&skip=${Math.floor(skip)}`);
  return Array.isArray(j?.items) ? j.items : [];
}

/**
 * Checkout's success signature: HMAC-SHA256(order_id + "|" + payment_id)
 * keyed with the key SECRET, hex. Constant-time compare; any missing part
 * or a wrong length is simply false.
 */
function verifyCheckoutSignature(orderId, paymentId, signature) {
  const secret = cfg().keySecret;
  if (!secret || !orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  enabled, testMode, createOrder, fetchPayment, orderPayments, listPayments, verifyCheckoutSignature, keyId: () => cfg().keyId,
  _setFetch(f) { fetchImpl = f || ((...a) => fetch(...a)); },
};
