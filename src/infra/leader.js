/**
 * ONE RUNNER PER CLUSTER for periodic background work.
 *
 * The proactive sweep, the daily housekeeping pass and the quote-card
 * generator run on a setInterval in every backend process. With one
 * replica that is fine; with two (a rollout overlap, or a second replica) each
 * would nudge, ring and generate twice. `exclusive(name, fn)` takes a
 * Postgres session advisory lock on a dedicated connection for the length
 * of fn: whoever gets it runs, everyone else skips this round. The lock
 * dies with the connection, so a crashed runner never wedges the others.
 *
 * Skipping (not waiting) is the point: the next tick tries again, and a
 * sweep is idempotent per tick rather than per process.
 */
const db = require("../db");

// Advisory locks share one keyspace per database; the class keeps ours
// apart from the per-user xact locks other stores take.
const LOCK_CLASS = 0x6d79_6131; // "mya1"

/**
 * @template T
 * @param {string} name a stable name for the work ("proactive.sweep")
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ran: true, value: T} | {ran: false}>}
 */
async function exclusive(name, fn) {
  const client = await db.pool.connect();
  let locked = false;
  try {
    const r = await client.query(
      "SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok", [LOCK_CLASS, String(name)]);
    locked = !!(r.rows[0] && r.rows[0].ok);
    if (!locked) return { ran: false };
    return { ran: true, value: await fn() };
  } finally {
    let broken = null;
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [LOCK_CLASS, String(name)])
        .catch((e) => { broken = e; });
    }
    // A connection that may still hold the lock must not go back to the
    // pool — release(err) destroys it, and the lock dies with it.
    client.release(broken || undefined);
  }
}

module.exports = { exclusive, LOCK_CLASS };
