/**
 * CASHBACK — the owner's side, inside the admin panel (routes/admin_web.js
 * mounts this at /admin-panel/api/cashback, behind the panel's sign-in).
 *
 *   GET  /                      settings, totals, rows waiting for a person,
 *                               open withdrawals, recent purchases, partners
 *   POST /txns                  enter a purchase by hand (a network with no
 *                               automatic reports, or a dispute won)
 *   POST /txns/:id              { status, note?, userId? } confirm or reject
 *   POST /payouts/:id           { status: paid|rejected, reference?, note? }
 *   PUT  /rules/:merchant       { enabled, rateText, sharePct }
 *   POST /import                { network, rows:[{…}] } a network's report,
 *                               row by row, through the same door as a hook
 */
const router = require("express").Router();
const store = require("./store");
const service = require("./service");
const merchants = require("../affiliate/merchants");

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof service.ReportError) return res.status(400).json({ error: e.message });
    console.error("cashback admin:", e.message);
    res.status(500).json({ error: "The cashback request failed." });
  }
};

router.get("/", wrap(async (_req, res) => {
  const rules = await store.rules();
  const [totals, review, unmatched, payouts, recent] = await Promise.all([
    store.totals(),
    store.listTxns({ review: true, limit: 100 }),
    store.listTxns({ status: "pending", limit: 200 }).then((rows) => rows.filter((t) => t.userId == null)),
    store.listPayouts({ status: "requested", limit: 100 }),
    store.listTxns({ limit: 60 }),
  ]);
  // What each waiting withdrawal stands on today, so the owner sees a
  // purchase cancelled since the request BEFORE paying it.
  for (const p of payouts) {
    const b = await store.balance(p.userId);
    p.coveredPaise = b.confirmedPaise - b.paidPaise;
    p.short = p.coveredPaise < p.amountPaise;
  }
  res.json({
    settings: {
      on: service.cfg.on(), sharePct: service.cfg.sharePct(),
      minPayoutPaise: service.cfg.minPayoutPaise(), reviewAbovePaise: service.cfg.reviewAbovePaise(),
      hookReady: service.cfg.hookSecret().length >= 24,
      sandbox: String(process.env.CASHBACK_SANDBOX || "").toLowerCase() === "on",
    },
    totals, review, unmatched, payouts, recent,
    partners: merchants.MERCHANTS.map((m) => {
      const rule = rules.get(m.id) || null;
      const t = merchants.trackedUrl(m);
      return {
        id: m.id, name: m.name, category: m.category, program: m.program,
        tracked: t.tracked, network: t.network, eligible: service.eligible(m, rule),
        rule,
      };
    }),
  });
}));

router.post("/txns", wrap(async (req, res) => {
  const b = req.body || {};
  const userId = b.userId == null || b.userId === "" ? null : Number(b.userId);
  if (userId != null && !(Number.isInteger(userId) && userId > 0)) return res.status(400).json({ error: "bad user id" });
  const out = await service.recordConversion({
    network: String(b.network || "manual"),
    networkTxnId: String(b.networkTxnId || `manual-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    clickId: b.clickId || "", userId, merchant: b.merchant || "",
    salePaise: service.toPaise(b.saleInr), commissionPaise: service.toPaise(b.commissionInr),
    status: ["pending", "confirmed", "rejected"].includes(b.status) ? b.status : "pending",
    note: b.note || "entered by hand",
  });
  res.json(out);
}));

router.post("/txns/:id", wrap(async (req, res) => {
  const b = req.body || {};
  if (!store.TXN_STATUSES.has(b.status)) return res.status(400).json({ error: "status must be pending, confirmed or rejected" });
  const before = await store.txnById(req.params.id);
  if (!before) return res.status(404).json({ error: "no such purchase" });
  const userId = b.userId == null || b.userId === "" ? undefined : Number(b.userId);
  let cashbackPaise;
  if (userId !== undefined) {
    if (!(Number.isInteger(userId) && userId > 0)
        || !(await require("../db").one("SELECT id FROM users WHERE id = $1", [userId]))) {
      return res.status(400).json({ error: "no such user" });
    }
    // A purchase nobody was matched to carried no cashback; giving it its
    // owner gives it its amount, by the share it was recorded with.
    if (before.userId == null && before.cashbackPaise === 0 && b.status !== "rejected") {
      const m = merchants.BY_ID.get(before.merchant);
      const rule = m ? (await store.rules()).get(m.id) : null;
      if (m && service.eligible(m, rule)) cashbackPaise = Math.floor((before.commissionPaise * before.sharePct) / 100);
    }
  }
  const txn = await store.setTxnStatus(before.id, b.status, { note: b.note, userId, cashbackPaise });
  if (txn.userId != null && txn.cashbackPaise > 0 && before.status !== txn.status) {
    service._tell(txn, before.status).catch(() => {});
  }
  res.json({ txn });
}));

router.post("/payouts/:id", wrap(async (req, res) => {
  const b = req.body || {};
  if (b.status !== "paid" && b.status !== "rejected") return res.status(400).json({ error: "status must be paid or rejected" });
  if (b.status === "paid" && !String(b.reference || "").trim()) {
    return res.status(400).json({ error: "enter the payment reference (UTR) before marking it paid" });
  }
  let payout;
  try {
    payout = await service.decidePayout(req.params.id, b);
  } catch (e) {
    if (e instanceof store.PayoutError) return res.status(409).json({ error: e.message, code: e.code });
    throw e;
  }
  if (!payout) return res.status(409).json({ error: "this withdrawal was already decided" });
  res.json({ payout });
}));

router.put("/rules/:merchant", wrap(async (req, res) => {
  const m = merchants.BY_ID.get(String(req.params.merchant));
  if (!m) return res.status(404).json({ error: "unknown partner" });
  const b = req.body || {};
  await store.setRule(m.id, { enabled: b.enabled !== false, rateText: b.rateText, sharePct: b.sharePct === "" ? null : b.sharePct });
  res.json({ ok: true, rule: (await store.rules()).get(m.id) });
}));

router.post("/import", wrap(async (req, res) => {
  const b = req.body || {};
  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 2000) : [];
  if (!rows.length) return res.status(400).json({ error: "rows required" });
  // The network's real name, so an imported purchase and the same one
  // reported by postback are one row.
  if (!service.networks().includes(String(b.network || "").toLowerCase())) {
    return res.status(400).json({ error: `network must be one of: ${service.networks().join(", ")}` });
  }
  const result = { created: 0, updated: 0, unchanged: 0, failed: [] };
  for (let i = 0; i < rows.length; i++) {
    try {
      const out = await service.recordConversion(service.readReport(b.network, rows[i] || {}));
      if (out.created) result.created++; else if (out.changed) result.updated++; else result.unchanged++;
    } catch (e) {
      result.failed.push({ row: i + 1, error: String(e.message).slice(0, 120) });
    }
  }
  res.json(result);
}));

module.exports = router;
