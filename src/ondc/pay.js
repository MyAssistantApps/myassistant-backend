/**
 * PAYING FOR AN ONDC ORDER (2026-11-04) — Razorpay Payment Links.
 *
 * The buyer app collects the money (payment type ON-ORDER, collected by
 * BAP) and settles with the seller as the seller's on_init asks. A link
 * needs no native SDK: the app opens Razorpay's own page, then asks us,
 * and WE ask Razorpay whether it is paid — the app is never trusted with
 * "it's paid". The amount is always the seller's quoted total from
 * on_init, never a number the app sends.
 */
const API = "https://api.razorpay.com/v1";

function enabled() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function auth() {
  return "Basic " + Buffer.from(
    `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
}

async function createLink({ amountRupees, description, name, phone, referenceId }) {
  const paise = Math.round(Number(amountRupees) * 100);
  if (!Number.isFinite(paise) || paise < 100) throw new Error("amount too small");
  const r = await fetch(`${API}/payment_links`, {
    method: "POST",
    headers: { authorization: auth(), "content-type": "application/json" },
    body: JSON.stringify({
      amount: paise,
      currency: "INR",
      description: String(description || "Order").slice(0, 2048),
      reference_id: String(referenceId).slice(0, 40),
      customer: { name: name || undefined, contact: phone ? String(phone) : undefined },
      notify: { sms: false, email: false },
      reminder_enable: false,
      expire_by: Math.floor(Date.now() / 1000) + 30 * 60,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.description || `razorpay ${r.status}`);
  return { id: j.id, url: j.short_url, amountRupees: paise / 100 };
}

/** { paid, paymentId, status } — asked of Razorpay itself. */
async function linkStatus(linkId) {
  const r = await fetch(`${API}/payment_links/${encodeURIComponent(linkId)}`, {
    headers: { authorization: auth() },
    signal: AbortSignal.timeout(12_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.description || `razorpay ${r.status}`);
  const pay = (j.payments || []).find((p) => p.status === "captured") || (j.payments || [])[0];
  return { paid: j.status === "paid", status: j.status, paymentId: pay?.payment_id || null };
}

module.exports = { enabled, createLink, linkStatus };
