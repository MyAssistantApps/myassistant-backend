/**
 * REQUEST LOG — every HTTP request the server answers, kept for 2 days and
 * shown in the admin panel (Operations → Request log).
 *
 * What is stored per request: time, method, path, status, duration, the
 * user id (when signed in), IP, user agent, response size and request id.
 * What is NOT stored: query strings, headers, cookies or bodies — they can
 * carry tokens and what the user said. Webhook secrets in paths are masked
 * the same way the console access log masks them (infra/observability.js).
 *
 * Writes never slow a request down: rows are buffered in memory and written
 * in one INSERT every couple of seconds. If the database is unreachable the
 * batch is dropped (with one warning a minute) rather than piling up.
 *
 * Retention: rows older than REQUEST_LOG_DAYS (default 2) are deleted at
 * boot and every hour. REQUEST_LOG=0 switches the whole thing off.
 *
 * user_id is listed in USER_TABLES (routes/privacy.js), so a user's rows go
 * with their account and are part of their data export.
 */
const db = require("../db");

const ENABLED = process.env.REQUEST_LOG !== "0";
const KEEP_DAYS = Math.max(Number(process.env.REQUEST_LOG_DAYS) || 2, 0.01);
const KEEP_MS = KEEP_DAYS * 86400_000;
const FLUSH_MS = 2000;
const FLUSH_AT = 200; // rows — flush early when this many are waiting
const MAX_BUFFER = 5000; // never hold more than this in memory

let buffer = [];
let migrated = null;
let lastWarn = 0;
let flushing = false;
let timers = null;

function warn(msg) {
  if (Date.now() - lastWarn < 60_000) return;
  lastWarn = Date.now();
  console.warn("request log:", msg);
}

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id       BIGSERIAL PRIMARY KEY,
      ts       BIGINT  NOT NULL,
      rid      TEXT,
      method   TEXT    NOT NULL,
      path     TEXT    NOT NULL,
      status   INTEGER NOT NULL,
      ms       INTEGER NOT NULL,
      user_id  TEXT,
      ip       TEXT,
      ua       TEXT,
      bytes    INTEGER,
      aborted  BOOLEAN NOT NULL DEFAULT FALSE
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_request_logs_ts ON request_logs(ts)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_request_logs_user ON request_logs(user_id, id DESC)`);
}

function ensureTable() {
  if (!migrated) migrated = migrate().catch((e) => { migrated = null; throw e; });
  return migrated;
}

/** The path without its query string, secrets masked, length capped. */
function cleanPath(originalUrl) {
  const p = String(originalUrl || "/").split("?")[0].split("#")[0];
  // Same masks as infra/observability.js redactPath (Bolna, the tool hook,
  // Plivo's per-call tokens), plus long tokens after common secret words.
  return p
    .replace(/\/(webhook|tool|inbound|hook|cb|callback)\/[A-Za-z0-9_-]{16,}/gi, "/$1/:secret")
    .replace(/\/[A-Fa-f0-9]{32,}(?=\/|$)/g, "/:secret")
    .replace(/\/(ws|socket|token|t|k|key)\/[A-Za-z0-9._~-]{16,}/gi, "/$1/:secret")
    .slice(0, 500);
}

const cap = (s, n) => (s == null ? null : String(s).slice(0, n));

/** Express middleware. Mount it first so every request is seen. */
function middleware() {
  if (!ENABLED) return (_req, _res, next) => next();
  return (req, res, next) => {
    const t0 = process.hrtime.bigint();
    const ts = Date.now();
    let done = false;
    const record = (aborted) => {
      if (done) return;
      done = true;
      try { push(aborted); } catch (e) { warn(`not recorded — ${e.message}`); }
    };
    const push = (aborted) => {
      const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
      const len = parseInt(res.getHeader("content-length"), 10);
      buffer.push({
        ts,
        rid: cap(req.requestId, 64),
        method: cap(req.method, 10) || "?",
        path: cleanPath(req.originalUrl || req.url),
        status: aborted && !res.headersSent ? 499 : res.statusCode || 0,
        ms: Math.min(ms, 2_147_483_647),
        user_id: req.user?.sub != null ? cap(req.user.sub, 64) : null,
        ip: cap(req.ip || req.socket?.remoteAddress, 64),
        ua: cap(req.get("user-agent"), 300),
        bytes: Number.isFinite(len) ? len : null,
        aborted: Boolean(aborted),
      });
      if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
      if (buffer.length >= FLUSH_AT) flush();
    };
    res.once("finish", () => record(false));
    res.once("close", () => record(!res.writableFinished));
    next();
  };
}

/** Writes the waiting rows in one INSERT. Never throws. */
async function flush() {
  if (flushing || !buffer.length) return;
  flushing = true;
  const rows = buffer;
  buffer = [];
  try {
    await ensureTable();
    const col = (k) => rows.map((r) => r[k]);
    await db.query(
      `INSERT INTO request_logs (ts, rid, method, path, status, ms, user_id, ip, ua, bytes, aborted)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::int[],
                            $6::int[], $7::text[], $8::text[], $9::text[], $10::int[], $11::bool[])`,
      [col("ts"), col("rid"), col("method"), col("path"), col("status"), col("ms"),
        col("user_id"), col("ip"), col("ua"), col("bytes"), col("aborted")]
    );
  } catch (e) {
    warn(`dropped ${rows.length} row(s) — ${e.message}`);
  } finally {
    flushing = false;
  }
}

/** Deletes rows past the retention window. Returns how many went. */
async function prune() {
  await ensureTable();
  return db.run(`DELETE FROM request_logs WHERE ts < $1`, [Date.now() - KEEP_MS]);
}

/** Starts the flush and prune timers (idempotent). */
function start() {
  if (!ENABLED || timers) return;
  const pruneNow = () => prune().catch((e) => warn(`prune failed — ${e.message}`));
  timers = [
    setInterval(flush, FLUSH_MS),
    setInterval(pruneNow, 3600_000),
  ];
  for (const t of timers) t.unref?.();
  ensureTable().then(pruneNow).catch((e) => warn(`table setup failed — ${e.message}`));
}

/** For the admin panel: newest first, filtered, paged by id. */
async function list({ before, limit = 100, method, status, q, userId, hideAdmin } = {}) {
  await ensureTable();
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (Number.isFinite(before) && before > 0) where.push(`id < ${p(before)}`);
  if (method) where.push(`method = ${p(String(method).toUpperCase())}`);
  if (/^[1-5]xx$/.test(status || "")) {
    const lo = Number(status[0]) * 100;
    where.push(`status >= ${p(lo)} AND status < ${p(lo + 100)}`);
  } else if (/^\d{3}$/.test(status || "")) {
    where.push(`status = ${p(Number(status))}`);
  }
  if (q) where.push(`position(lower(${p(String(q))}) in lower(path)) > 0`);
  if (userId) where.push(`user_id = ${p(String(userId))}`);
  if (hideAdmin) where.push(`path NOT LIKE '/admin-panel%'`);
  const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  return db.query(
    `SELECT id, ts, rid, method, path, status, ms, user_id, ip, ua, bytes, aborted
       FROM request_logs ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY id DESC LIMIT ${n}`,
    params
  );
}

/** For the admin panel: counts across what is kept. */
async function summary() {
  await ensureTable();
  const now = Date.now();
  const r = await db.one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ts > $1)::int AS last_hour,
            COUNT(*) FILTER (WHERE ts > $2)::int AS last_day,
            COUNT(*) FILTER (WHERE ts > $2 AND status >= 400 AND status < 500)::int AS c4xx,
            COUNT(*) FILTER (WHERE ts > $2 AND status >= 500)::int AS c5xx,
            COALESCE(ROUND(AVG(ms) FILTER (WHERE ts > $1)), 0)::int AS avg_ms,
            MIN(ts) AS oldest
       FROM request_logs`,
    [now - 3600_000, now - 86400_000]
  );
  return { ...r, oldest: r.oldest ? Number(r.oldest) : null, keepDays: KEEP_DAYS, enabled: ENABLED };
}

module.exports = { middleware, start, flush, prune, migrate, list, summary, cleanPath, ENABLED, KEEP_DAYS };
