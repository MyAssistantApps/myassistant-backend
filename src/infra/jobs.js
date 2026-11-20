/**
 * BACKGROUND JOBS (§25) — durable, in-process worker.
 *
 * OCR, embedding and document indexing must not block a live voice turn.
 * Jobs are persisted in PostgreSQL rather than held in memory, so a
 * restart mid-document does not silently lose the work.
 *
 * WHY NOT REDIS/BullMQ: Redis is not part of the current deployment, and
 * adding a broker the environment doesn't run would be a fake dependency.
 * The table-backed queue below uses SELECT … FOR UPDATE SKIP LOCKED, which
 * is safe across MULTIPLE backend instances — so this scales horizontally
 * as-is, and swapping in BullMQ later means reimplementing `claim()` only.
 */
const { query, one, run } = require("../db");
const { logger, timed, count } = require("./observability");

const HANDLERS = new Map();
let timer = null;
let running = false;

const POLL_MS = Number(process.env.JOB_POLL_MS) || 2000;
const MAX_ATTEMPTS = 3;

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER,
      kind        TEXT NOT NULL,
      payload     JSONB NOT NULL DEFAULT '{}',
      status      TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT NOT NULL DEFAULT '',
      run_after   BIGINT NOT NULL,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_claim
      ON jobs(status, run_after) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_running
      ON jobs(updated_at) WHERE status = 'running';
  `);
}

function register(kind, handler) {
  HANDLERS.set(kind, handler);
}

async function enqueue(kind, payload = {}, { userId = null, delayMs = 0 } = {}) {
  const t = Date.now();
  const row = await one(
    `INSERT INTO jobs (user_id,kind,payload,run_after,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
    [userId, kind, JSON.stringify(payload), t + delayMs, t]
  );
  count(`jobs.enqueued.${kind}`);
  return Number(row.id);
}

/**
 * Claims one job atomically. SKIP LOCKED means two backend instances never
 * pick up the same row, so this is safe to run on every replica.
 */
async function claim() {
  const rows = await query(
    `UPDATE jobs SET status='running', attempts=attempts+1, updated_at=$1
      WHERE id = (
        SELECT id FROM jobs
         WHERE status='pending' AND run_after <= $1
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`,
    [Date.now()]
  );
  return rows[0] || null;
}

async function runOne() {
  const job = await claim();
  if (!job) return false;

  const handler = HANDLERS.get(job.kind);
  if (!handler) {
    await run(
      `UPDATE jobs SET status='failed', last_error=$2, updated_at=$3 WHERE id=$1`,
      [job.id, `no handler for "${job.kind}"`, Date.now()]
    );
    logger.warn("job_no_handler", { id: Number(job.id), kind: job.kind });
    return true;
  }

  inFlight.add(Number(job.id));
  try {
    await timed(`job.${job.kind}`, () => handler(job.payload, job), {
      jobId: Number(job.id),
    });
    await run(`UPDATE jobs SET status='done', updated_at=$2 WHERE id=$1`, [
      job.id, Date.now(),
    ]);
    require("./metrics").jobFinished(job.kind, "done");
  } catch (e) {
    const give_up = job.attempts >= MAX_ATTEMPTS;
    // Exponential backoff; a permanently broken job stops retrying rather
    // than spinning forever.
    await run(
      `UPDATE jobs SET status=$2, last_error=$3, run_after=$4, updated_at=$5 WHERE id=$1`,
      [
        job.id,
        give_up ? "failed" : "pending",
        String(e.message).slice(0, 300),
        Date.now() + Math.min(60_000, 2000 * 2 ** job.attempts),
        Date.now(),
      ]
    );
    if (give_up) require("./metrics").jobFinished(job.kind, "failed");
    logger.error("job_failed", {
      id: Number(job.id), kind: job.kind, attempts: job.attempts,
      willRetry: !give_up, error: e.message,
    });
  } finally {
    inFlight.delete(Number(job.id));
  }
  return true;
}

/** Drains the queue; used by tests and by the poller. */
async function drain(max = 50) {
  let n = 0;
  while (n < max && (await runOne())) n++;
  return n;
}

// LEASES. A claimed job's updated_at is its heartbeat: this process
// touches every job it is running each HEARTBEAT_MS, and a 'running' row
// whose heartbeat is older than LEASE_MS belongs to a process that died
// (restart, rollout, crash). Such rows are failed, not retried: a handler
// may have had side effects (a call placed, an order sent) before it died,
// and running it twice is worse than reporting it.
//
// This replaced a boot-time "fail every running job" pass, which was only
// correct with exactly one replica — during a rollout, or with two
// instances, a starting server failed the jobs the OTHER one was running.
const HEARTBEAT_MS = Number(process.env.JOB_HEARTBEAT_MS) || 60_000;
const LEASE_MS = Math.max(Number(process.env.JOB_LEASE_MS) || 3 * 60_000, HEARTBEAT_MS * 2);
const inFlight = new Set();
let heartbeat = null;

async function touchInFlight() {
  if (!inFlight.size) return 0;
  return run(`UPDATE jobs SET updated_at=$2 WHERE id = ANY($1::bigint[]) AND status='running'`,
    [[...inFlight], Date.now()]);
}

/** Fails 'running' jobs whose owner stopped heartbeating. Returns the count. */
async function reapStale(now = Date.now()) {
  const n = await run(
    `UPDATE jobs SET status='failed',
            last_error='interrupted by a server restart mid-run',
            updated_at=$1
      WHERE status='running' AND updated_at < $2`,
    [now, now - LEASE_MS]
  );
  if (n) logger.warn("jobs_reaped_stranded", { count: n });
  return n;
}

function start() {
  if (timer) return;
  reapStale().catch((e) => logger.error("jobs_reap_failed", { error: e.message }));
  heartbeat = setInterval(() => {
    touchInFlight()
      .then(() => reapStale())
      .catch((e) => logger.error("jobs_heartbeat_failed", { error: e.message }));
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();
  timer = setInterval(async () => {
    if (running) return; // never overlap polls
    running = true;
    try {
      await drain(10);
    } catch (e) {
      logger.error("job_poll_failed", { error: e.message });
    } finally {
      running = false;
    }
  }, POLL_MS);
  if (timer.unref) timer.unref();
  logger.info("jobs_started", { pollMs: POLL_MS, leaseMs: LEASE_MS, handlers: [...HANDLERS.keys()] });
}

function stop() {
  if (timer) clearInterval(timer);
  if (heartbeat) clearInterval(heartbeat);
  timer = null;
  heartbeat = null;
}

module.exports = { migrate, register, enqueue, drain, runOne, start, stop, reapStale, HANDLERS, LEASE_MS };
