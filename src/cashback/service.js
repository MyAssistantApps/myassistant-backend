/**
 * CASHBACK — THE RULES (see store.js for the ledger and the whole flow).
 *
 * SETTINGS (the server's .env; mirrored in deploy/docker-vps/production.flags)
 *   CASHBACK                  on | off (default off). Off: nothing is shown
 *                             in the app, no cashback accrues, no payout can
 *                             be asked for. Clicks and reported purchases are
 *                             still recorded, so commission stays visible.
 *   CASHBACK_SHARE_PCT        how much of OUR commission goes to the user.
 *                             Default 100 (owner, 2026-11-27: all of it).
 *   CASHBACK_MIN_PAYOUT_INR   smallest withdrawal. Default 100.
 *   CASHBACK_REVIEW_ABOVE_INR a single cashback above this waits for a
 *                             person to confirm it. Default 1000.
 *   CASHBACK_HOOK_SECRET      the secret in the URL the affiliate network
 *                             reports purchases to (routes.js). Unset: the
 *                             URL does not exist.
 *   CASHBACK_HOOK_FIELDS      optional JSON: the network's own names for the
 *                             fields below, when they differ from FIELDS.
 *   CASHBACK_SANDBOX          on = a development server pretends network
 *                             partners are tracked (network "sandbox"), so
 *                             the flow can be tried without an affiliate
 *                             account. NEVER on production.
 *
 * WHO EARNS CASHBACK. A partner is eligible when the feature is on, we earn
 * on its link right now (affiliate/merchants.js trackedUrl), the owner has
 * not switched it off (cashback_rules), and it is not an Amazon link:
 * Amazon's Associates agreement forbids rewarding people for using its
 * links, so Amazon never earns cashback here.
 */
const store = require("./store");
const merchants = require("../affiliate/merchants");

const num = (v, dflt) => {
  if (v === undefined || String(v).trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

const cfg = {
  on: () => String(process.env.CASHBACK || "off").trim().toLowerCase() === "on",
  sharePct: () => Math.min(100, Math.round(num(process.env.CASHBACK_SHARE_PCT, 100))),
  minPayoutPaise: () => Math.round(num(process.env.CASHBACK_MIN_PAYOUT_INR, 100) * 100),
  reviewAbovePaise: () => Math.round(num(process.env.CASHBACK_REVIEW_ABOVE_INR, 1000) * 100),
  // 32+ characters of letters, digits, _ or -: anything else is treated as
  // unset, so a weak or oddly formed secret can never be the only guard on
  // money (and the access log's masking always recognises it).
  hookSecret: () => {
    const s = String(process.env.CASHBACK_HOOK_SECRET || "").trim();
    return /^[A-Za-z0-9_-]{32,}$/.test(s) ? s : "";
  },
};

/** Rupees as a network writes them ("1,299.50", "₹ 45") → paise, or null. */
function toPaise(v) {
  if (v === undefined || v === null || v === "") return null;
  const digits = String(v).replace(/[^0-9.-]/g, "");
  // "n/a" or "-" is no amount at all, not an amount of zero.
  if (!/[0-9]/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** ₹1,234.50 — for the words a person reads. */
function rupees(paise) {
  const n = Number(paise) / 100;
  return "₹" + n.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2,
  });
}

/* ------------------------------------------------------------------ *
 * Eligibility
 * ------------------------------------------------------------------ */

function eligible(m, rule) {
  if (!cfg.on() || !m) return false;
  if (m.program === "amazon") return false;
  if (rule && rule.enabled === false) return false;
  return merchants.trackedUrl(m).tracked;
}

/** The partners a user earns cashback with right now, for the app. */
async function stores() {
  if (!cfg.on()) return [];
  const rules = await store.rules();
  return merchants.MERCHANTS
    .filter((m) => eligible(m, rules.get(m.id)))
    .map((m) => ({
      id: m.id, name: m.name, category: m.category, color: m.color,
      rateText: (rules.get(m.id) || {}).rateText || "",
    }));
}

/* ------------------------------------------------------------------ *
 * A purchase, as a network reports it
 * ------------------------------------------------------------------ */

// The names networks commonly use; the first one present wins.
const FIELDS = {
  click: ["subid", "sub_id", "subid1", "aff_sub", "click_id", "clickid", "s1"],
  txn: ["transaction_id", "txn_id", "conversion_id", "order_id", "id"],
  sale: ["sale_amount", "order_amount", "amount", "sale"],
  commission: ["commission", "user_commission", "payout", "earning"],
  status: ["status", "conversion_status"],
  merchant: ["store", "store_name", "merchant", "campaign", "campaign_name"],
  when: ["transaction_date", "conversion_time", "date", "timestamp"],
};

function fieldNames() {
  try {
    const j = JSON.parse(process.env.CASHBACK_HOOK_FIELDS || "{}");
    const out = { ...FIELDS };
    for (const k of Object.keys(FIELDS)) {
      if (Array.isArray(j[k]) && j[k].length) out[k] = j[k].map(String);
      else if (typeof j[k] === "string" && j[k]) out[k] = [j[k]];
    }
    return out;
  } catch (_) {
    return FIELDS;
  }
}

function pick(src, names) {
  for (const n of names) {
    const v = src[n];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

/**
 * A network's word for where a purchase stands → ours.
 *
 * WHOLE WORDS ONLY (security review, 2026-11-27). Matching pieces of words
 * read "unpaid", "unapproved", "unsuccessful" and "pending approval" as
 * confirmed. A word that is not on a list is `pending`, and `known: false`
 * puts the purchase in front of a person: money is never confirmed on a
 * word nobody has seen before. CASHBACK_STATUS_WORDS (JSON: {confirmed:[…],
 * rejected:[…], pending:[…]}) adds a network's own vocabulary.
 */
const STATUS_WORDS = {
  confirmed: ["validated", "valid", "approved", "confirmed", "payable", "paid", "success", "successful", "settled"],
  rejected: ["rejected", "cancelled", "canceled", "declined", "invalid", "failed", "returned", "refunded", "reversed", "void"],
  pending: ["pending", "new", "tracked", "open", "processing", "in process", "awaiting validation", "pending approval", "unpaid", ""],
};
function statusWords() {
  const out = { confirmed: [...STATUS_WORDS.confirmed], rejected: [...STATUS_WORDS.rejected], pending: [...STATUS_WORDS.pending] };
  try {
    const j = JSON.parse(process.env.CASHBACK_STATUS_WORDS || "{}");
    for (const k of Object.keys(out)) if (Array.isArray(j[k])) out[k].push(...j[k].map((x) => String(x).toLowerCase().trim()));
  } catch (_) { /* the built-in words stand */ }
  return out;
}
function readStatus(word) {
  const w = String(word || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const words = statusWords();
  // Rejected is looked up first: when in doubt, nobody is paid.
  for (const status of ["rejected", "pending", "confirmed"]) {
    if (words[status].includes(w)) return { status, known: true };
  }
  return { status: "pending", known: false };
}
const statusOf = (word) => readStatus(word).status;

function whenOf(v) {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n; // seconds or ms
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

/** The fields of a report, by whatever names the network used. */
function readReport(network, src) {
  const f = fieldNames();
  return {
    network: String(network || "").toLowerCase(),
    networkTxnId: pick(src, f.txn),
    clickId: pick(src, f.click),
    merchantName: pick(src, f.merchant),
    salePaise: toPaise(pick(src, f.sale)),
    commissionPaise: toPaise(pick(src, f.commission)),
    status: readStatus(pick(src, f.status)).status,
    statusWord: readStatus(pick(src, f.status)).known ? "" : pick(src, f.status).slice(0, 40),
    occurredAt: whenOf(pick(src, f.when)),
  };
}

/** ₹1 crore: no single order or commission here is ever larger. */
const MAX_PAISE = 1_000_000_000;

/** Entered by a person in the admin panel, not reported by a network. */
const HAND_ENTERED = ["manual"];

/**
 * The networks a purchase may come from: the affiliate network, a person
 * (admin panel), the sandbox on a development server, and any named in
 * CASHBACK_NETWORKS (comma-separated) when a second network is added.
 */
function networks() {
  const extra = String(process.env.CASHBACK_NETWORKS || "").toLowerCase().split(",")
    .map((x) => x.trim()).filter((x) => /^[a-z0-9_-]{2,24}$/.test(x));
  const list = ["cuelinks", ...HAND_ENTERED, ...extra];
  if (sandboxOn()) list.push("sandbox");
  return [...new Set(list)];
}

let sandboxWarned = false;
function sandboxOn() {
  const on = String(process.env.CASHBACK_SANDBOX || "").toLowerCase() === "on";
  if (on && !sandboxWarned) {
    sandboxWarned = true;
    console.warn("⚠️  CASHBACK_SANDBOX is ON: partners are pretend-tracked and test purchases are accepted. Development only — MUST be off on production.");
  }
  return on;
}

class ReportError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** A partner by the name a network calls it ("Myntra", "myntra.com"). */
function merchantByName(name) {
  const n = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!n) return null;
  return merchants.MERCHANTS.find((m) => {
    const id = m.id.toLowerCase();
    const nm = m.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return n === id || n === nm || n.startsWith(nm) || n.startsWith(id);
  }) || null;
}

/**
 * Records one reported purchase and tells the user when something real
 * changed. Safe to call again with the same report: nothing happens twice.
 *
 * @param r  { network, networkTxnId, clickId?, userId?, merchant?, merchantName?,
 *             salePaise?, commissionPaise?, status, occurredAt?, note? }
 */
async function recordConversion(r, { notifyUser = true } = {}) {
  const network = String(r.network || "").toLowerCase();
  // One purchase is one row: a network has ONE name here, from a short
  // list, so the same purchase cannot be credited again under another.
  if (!networks().includes(network)) throw new ReportError("unknown network");
  const networkTxnId = String(r.networkTxnId || "").trim().slice(0, 120);
  if (!networkTxnId) throw new ReportError("a transaction id is required");
  const commission = r.commissionPaise == null ? null : Number(r.commissionPaise);
  const sale = r.salePaise == null ? null : Number(r.salePaise);
  if ((commission != null && commission < 0) || (sale != null && sale < 0)) {
    throw new ReportError("amounts cannot be negative");
  }
  // An absurd amount is a mistake in the report, not a purchase: refused
  // (400, so the network does not retry it for ever), never stored.
  if ((commission != null && commission > MAX_PAISE) || (sale != null && sale > MAX_PAISE)) {
    throw new ReportError("amount out of range");
  }

  // Who and where: the click the sub-id names. A report can also name the
  // user outright (a person entering it in the admin panel).
  const click = await store.clickById(r.clickId);
  const userId = r.userId != null ? Number(r.userId) : (click && click.user_id != null ? Number(click.user_id) : null);
  const clicked = merchants.BY_ID.get(String(r.merchant || (click && click.merchant) || "")) || null;
  // THE STORE THE NETWORK NAMES DECIDES, NOT ONLY THE CLICK (security
  // review, 2026-11-27). A sub-id can be carried to another store on the
  // same network; if the report names a store we know and it is not the
  // one that was opened, eligibility is judged for the store actually
  // bought from, and a person looks at it.
  const reported = merchantByName(r.merchantName);
  const m = reported || clicked;
  const storeMismatch = Boolean(reported && clicked && reported.id !== clicked.id);
  const networkMismatch = Boolean(click && click.network && !HAND_ENTERED.includes(network) && click.network !== network);
  const rule = m ? (await store.rules()).get(m.id) : null;

  const share = rule && rule.sharePct != null ? rule.sharePct : cfg.sharePct();
  // Eligibility is judged when the purchase is first reported. A partner
  // switched off later does not take back what was already tracked.
  const earns = Boolean(m) && eligible(m, rule) && userId != null;
  const cashback = commission == null ? null : (earns ? Math.floor((commission * share) / 100) : 0);

  let note = String(r.note || "").slice(0, 300);
  let review = false;
  if (userId == null) { review = true; note = note || "no click matched this purchase"; }
  if (cashback != null && cashback > cfg.reviewAbovePaise()) { review = true; note = note || "large amount: confirm by hand"; }
  if (sale != null && commission != null && sale > 0 && commission > sale) {
    review = true; note = note || "commission is larger than the order";
  }
  if (storeMismatch) { review = true; note = note || `opened ${clicked.id}, bought at ${reported.id}`; }
  if (networkMismatch) { review = true; note = note || `the click was on ${click.network}, the report came from ${network}`; }
  if (r.statusWord) { review = true; note = note || `status word not recognised: "${r.statusWord}"`; }
  if (!earns && userId != null) note = note || (cfg.on() ? "partner not eligible for cashback" : "cashback is switched off");

  // Money that needs a person's eyes is never confirmed by a report alone.
  let status = r.status || "pending";
  if (review && status === "confirmed") status = "pending";

  const out = await store.upsertTxn({
    userId, clickId: r.clickId || "", merchant: m ? m.id : String(r.merchantName || "").slice(0, 60),
    network, networkTxnId, salePaise: sale, commissionPaise: commission, sharePct: share,
    cashbackPaise: cashback, earns, status, review, note, occurredAt: r.occurredAt || 0,
  });
  if (notifyUser && out.changed && out.txn.userId != null && out.txn.cashbackPaise > 0) {
    tell(out.txn, out.created ? null : out.from).catch(() => {});
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Telling the user
 * ------------------------------------------------------------------ */

function storeName(id) {
  const m = merchants.BY_ID.get(id);
  return m ? m.name : (id || "the store");
}

async function push(userId, title, body, data = {}) {
  try {
    const u = await require("../db").one("SELECT fcm_token FROM users WHERE id = $1", [Number(userId)]);
    if (!u || !u.fcm_token) return false;
    await require("../services/push").sendNotification(u.fcm_token, title, body, { type: "cashback", ...data });
    return true;
  } catch (_) {
    return false;
  }
}

/** One message per real change: tracked, confirmed, or cancelled. */
function tell(txn, from) {
  const amount = rupees(txn.cashbackPaise);
  const where = storeName(txn.merchant);
  if (txn.status === "pending" && from == null) {
    return push(txn.userId, "Cashback Tracked",
      `${amount} cashback from ${where} is tracked. It is confirmed once the store validates your order.`);
  }
  if (txn.status === "confirmed" && from !== "confirmed") {
    return push(txn.userId, "Cashback Confirmed", `${amount} cashback from ${where} is confirmed and ready to withdraw.`);
  }
  if (txn.status === "rejected" && from !== "rejected") {
    return push(txn.userId, "Cashback Cancelled",
      `${where} cancelled the cashback of ${amount}. This happens when an order is returned or cancelled.`);
  }
  return Promise.resolve(false);
}

/* ------------------------------------------------------------------ *
 * The user's view, and withdrawals
 * ------------------------------------------------------------------ */

const UPI = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,64}$/;

async function summary(userId) {
  if (!cfg.on()) return { enabled: false };
  const [balance, txns, payouts, list] = await Promise.all([
    store.balance(userId),
    store.listTxns({ userId, limit: 30 }),
    store.listPayouts({ userId, limit: 10 }),
    stores(),
  ]);
  return {
    enabled: true,
    balance,
    minPayoutPaise: cfg.minPayoutPaise(),
    sharePct: cfg.sharePct(),
    canWithdraw: balance.availablePaise >= cfg.minPayoutPaise() && balance.heldPaise === 0,
    // What the user may see of a row: never our commission or the network.
    txns: txns.filter((t) => t.cashbackPaise > 0).map((t) => ({
      id: t.id, store: storeName(t.merchant), merchant: t.merchant, cashbackPaise: t.cashbackPaise,
      salePaise: t.salePaise, status: t.status, occurredAt: t.occurredAt, confirmedAt: t.confirmedAt,
    })),
    payouts: payouts.map((p) => ({
      id: p.id, amountPaise: p.amountPaise, upiId: maskUpi(p.upiId), status: p.status,
      note: p.status === "rejected" ? p.note : "", requestedAt: p.requestedAt, decidedAt: p.decidedAt,
    })),
    stores: list,
  };
}

/** ra•••@okaxis — enough to recognise, not enough to copy from a screenshot. */
function maskUpi(upi) {
  const [name, bank] = String(upi || "").split("@");
  if (!bank) return "";
  return `${name.slice(0, 2)}${"•".repeat(Math.max(3, Math.min(6, name.length - 2)))}@${bank}`;
}

// 409 for every refusal the user can act on: the app shows a 409's own
// words (ApiService.sendJson) and treats any other failure as "try again".
class WithdrawError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function requestPayout(userId, { upiId }) {
  if (!cfg.on()) throw new WithdrawError("off", "Cashback is not available yet.", 404);
  const upi = String(upiId || "").trim();
  if (!UPI.test(upi)) throw new WithdrawError("upi", "Please enter a valid UPI ID, for example name@bank.");
  const u = await require("../db").one("SELECT phone_verified_at FROM users WHERE id = $1", [Number(userId)]);
  if (!u || !u.phone_verified_at) {
    throw new WithdrawError("phone", "Please verify your phone number before withdrawing cashback.");
  }
  try {
    const p = await store.requestPayout(userId, { upiId: upi, minPaise: cfg.minPayoutPaise() });
    // The owner pays withdrawals by hand for now: tell the admin inbox.
    require("../feedback/store")
      .alert(`Cashback withdrawal requested: ${rupees(p.amountPaise)} (payout ${p.id})`,
        { details: `User ${p.userId}. Open Cashback in the admin panel to pay or reject it.`, windowMs: 1000 })
      .catch(() => {});
    return { id: p.id, amountPaise: p.amountPaise, upiId: maskUpi(p.upiId), status: p.status, requestedAt: p.requestedAt };
  } catch (e) {
    if (e instanceof store.PayoutError) {
      const min = rupees(cfg.minPayoutPaise());
      throw new WithdrawError(e.code, e.code === "below_min"
        ? `You can withdraw once your available cashback reaches ${min}.` : e.message, 409);
    }
    // The unique index: a second request slipped in beside the first.
    if (e && e.code === "23505") throw new WithdrawError("open", "A withdrawal is already being processed.", 409);
    throw e;
  }
}

/** The owner paid it (or refused it): record it and tell the user. */
async function decidePayout(id, { status, reference, note }) {
  // store.PayoutError("short") passes through: the panel shows its words.
  const p = await store.decidePayout(id, { status, reference, note });
  if (!p) return null;
  if (status === "paid") {
    push(p.userId, "Cashback Paid", `${rupees(p.amountPaise)} has been sent to your UPI ID.`).catch(() => {});
  } else {
    push(p.userId, "Withdrawal Not Completed",
      `Your cashback withdrawal of ${rupees(p.amountPaise)} could not be completed${note ? `: ${String(note).slice(0, 120)}` : "."} The amount is back in your balance.`)
      .catch(() => {});
  }
  return p;
}

module.exports = {
  cfg, toPaise, rupees, eligible, stores, readReport, statusOf, readStatus, networks, recordConversion, ReportError,
  summary, requestPayout, decidePayout, WithdrawError, maskUpi, merchantByName, FIELDS,
  _tell: tell,
};
