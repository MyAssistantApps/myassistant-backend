/**
 * APPLICATION METRICS for Prometheus (served at /metrics by
 * express-prom-bundle, which uses prom-client's default registry).
 *
 * The bundle already exports HTTP rate/latency and the Node runtime
 * (CPU, heap, GC, event-loop lag). These add what only the app knows:
 *
 *   myassistant_pg_pool_{total,idle,waiting}  connection pool state
 *   myassistant_jobs{status}                  durable job queue depth
 *   myassistant_jobs_total{kind,status}       jobs finished (done|failed)
 *   myassistant_ai_spend_today_usd            AI spend since 00:00 UTC
 *
 * Gauges are computed when Prometheus scrapes (every 30 s), never on the
 * request path. The two database reads are cached for 30 s so a burst of
 * scrapes cannot load the database.
 */
const client = require("prom-client");

const CACHE_MS = 30_000;
let jobsCache = { at: 0, rows: [] };

function registerOnce(name, make) {
  return client.register.getSingleMetric(name) || make();
}

function install() {
  const db = require("../db");

  registerOnce("myassistant_pg_pool_total", () => new client.Gauge({
    name: "myassistant_pg_pool_total", help: "Open connections in the Postgres pool",
    collect() { this.set(db.pool.totalCount); },
  }));
  registerOnce("myassistant_pg_pool_idle", () => new client.Gauge({
    name: "myassistant_pg_pool_idle", help: "Idle connections in the Postgres pool",
    collect() { this.set(db.pool.idleCount); },
  }));
  registerOnce("myassistant_pg_pool_waiting", () => new client.Gauge({
    name: "myassistant_pg_pool_waiting", help: "Queries waiting for a pool connection",
    collect() { this.set(db.pool.waitingCount); },
  }));

  registerOnce("myassistant_jobs", () => new client.Gauge({
    name: "myassistant_jobs", help: "Jobs in the durable queue by status (pending, running)",
    labelNames: ["status"],
    async collect() {
      const now = Date.now();
      if (now - jobsCache.at > CACHE_MS) {
        const rows = await db.query(
          `SELECT status, count(*)::int AS n FROM jobs WHERE status IN ('pending','running') GROUP BY status`
        ).catch(() => null);
        if (rows) jobsCache = { at: now, rows };
      }
      this.reset();
      for (const s of ["pending", "running"]) {
        const r = jobsCache.rows.find((x) => x.status === s);
        this.set({ status: s }, r ? r.n : 0);
      }
    },
  }));

  registerOnce("myassistant_ai_spend_today_usd", () => new client.Gauge({
    name: "myassistant_ai_spend_today_usd", help: "AI provider spend since 00:00 UTC (ops/spend.js ledger)",
    async collect() {
      const usd = await require("../ops/budget").globalSpend(Date.now()).catch(() => null);
      if (usd !== null) this.set(usd);
    },
  }));
}

const jobsTotal = registerOnce("myassistant_jobs_total", () => new client.Counter({
  name: "myassistant_jobs_total", help: "Background jobs finished, by kind and outcome",
  labelNames: ["kind", "status"],
}));

/** Called by infra/jobs.js when a job ends. */
function jobFinished(kind, status) {
  try { jobsTotal.inc({ kind: String(kind).slice(0, 40), status }); } catch (_) {}
}

module.exports = { install, jobFinished };
