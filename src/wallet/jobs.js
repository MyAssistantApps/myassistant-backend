/**
 * WALLET JOBS — the reconcile safety net every 10 minutes and the daily
 * ledger + Razorpay check (service.js reconcileOpen / dailyCheck).
 *
 * Background only: a failure is logged and tried again next time, never
 * surfaced to a request. A Postgres advisory lock makes each run happen on
 * one server even if several are running.
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

function start() {
  if (timers.length) return;
  const reconcile = () => once("reconcile", () => service.reconcileOpen()).then((r) => {
    if (r && (r.credited || r.errors)) console.log(`  wallet reconcile: ${JSON.stringify(r)}`);
  });
  const daily = () => once("daily", () => service.dailyCheck()).then((r) => {
    if (r) console.log(`  wallet daily check: ${JSON.stringify(r)}`);
  });
  timers.push(setTimeout(reconcile, 2 * MIN), setInterval(reconcile, 10 * MIN),
    setTimeout(daily, 5 * MIN), setInterval(daily, 24 * 60 * MIN));
  for (const t of timers) t.unref?.();
}

function stop() {
  while (timers.length) {
    const t = timers.pop();
    clearTimeout(t);
    clearInterval(t);
  }
}

module.exports = { start, stop };
