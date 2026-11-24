/**
 * WALLET JOBS — background only; a failure is logged and tried again next
 * time, never surfaced to a request. A Postgres advisory lock makes each
 * run happen on one server even if several are running.
 *
 *   every 10 min  top-ups whose webhook was lost; refunds not yet settled
 *   every hour    referral rewards whose hold has ended
 *   every day     ledger + bonus-lot audit, Razorpay check, bonus expiry
 */
const service = require("./service");
const { tx } = require("../db");

const MIN = 60_000;
const timers = [];

async function once(name, fn) {
  try {
    return await tx(async (c) => {
      const got = (await c.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [`wallet_job:${name}`])).rows[0];
      if (!got?.ok) return null;
      return fn();
    });
  } catch (e) {
    console.warn(`wallet: ${name} failed — ${e.message || e}`);
    return null;
  }
}

const log = (name) => (r) => {
  if (r && Object.values(r).some((v) => Number(v) > 0)) console.log(`  wallet ${name}: ${JSON.stringify(r)}`);
};

function reconcile() {
  return once("reconcile", async () => ({
    ...(await service.reconcileOpen()),
    ...Object.fromEntries(Object.entries(await require("./refunds").reconcile()).map(([k, v]) => [`refund_${k}`, v])),
  })).then(log("reconcile"));
}

function referrals() {
  return once("referrals", () => require("./referrals").payout()).then(log("referrals"));
}

function daily() {
  return once("daily", async () => {
    const r = await service.dailyCheck();
    const drift = await require("./store").lotDrift();
    if (drift.length) {
      service.alert("Wallet bonus lots do not match bonus balances", JSON.stringify(drift.slice(0, 5)));
    }
    return { ...r, lot_drift: drift.length, ...(await require("./referrals").expireBonuses()) };
  }).then(log("daily"));
}

function start() {
  if (timers.length) return;
  timers.push(
    setTimeout(reconcile, 2 * MIN), setInterval(reconcile, 10 * MIN),
    setTimeout(referrals, 3 * MIN), setInterval(referrals, 60 * MIN),
    setTimeout(daily, 5 * MIN), setInterval(daily, 24 * 60 * MIN),
  );
  for (const t of timers) t.unref?.();
}

function stop() {
  while (timers.length) {
    const t = timers.pop();
    clearTimeout(t);
    clearInterval(t);
  }
}

module.exports = { start, stop, reconcile, referrals, daily };
