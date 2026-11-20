/**
 * TURN RECORDINGS — hearing what the transcript cannot show.
 * ----------------------------------------------------------
 * A transcript tells you what the recogniser THOUGHT it heard. It does
 * not tell you that the user trailed off, that two people were talking,
 * that the assistant spoke over them, or that "Love illah" was a clear
 * sentence badly recognised.
 *
 * The phone posts both halves of a live turn, for users who said yes to
 * "Help improve", and live/turnAudio.js writes one WAV per turn into the
 * `live_recordings` table and the ROOT directory kept here. This module
 * owns that store: the table, retention (keep-window and a total ceiling),
 * the admin panel's Recordings page (list/get/destroy/usage) and the
 * file removal that account erasure and the "Help improve" switch-off use.
 *
 * Rows with format 'm4a' and leftover .pcm files are from the earlier
 * proxied-call recorder; retention and erasure still clean them up.
 */
const fsp = require("fs/promises");
const path = require("path");
const { query, run } = require("../db");

// Under DATA_DIR (/app/data in the Docker image); a fixed "/app/data"
// failed on a host without /app (the VPS, 2026-10-31).
const ROOT = process.env.LIVE_RECORD_DIR ||
  path.join(path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "..", "data")), "recordings");

/** The longest a proxied call could run; its stale leftovers are older. */
const MAX_MINUTES = Number(process.env.LIVE_RECORD_MAX_MIN || 90);

/** How long a recording is kept, and the ceiling on all of them together. */
const KEEP_DAYS = Number(process.env.LIVE_RECORD_KEEP_DAYS || 14);
const MAX_TOTAL_MB = Number(process.env.LIVE_RECORD_MAX_MB || 2048);

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS live_recordings (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        session_id  TEXT NOT NULL,
        started_at  BIGINT NOT NULL,
        duration_ms BIGINT NOT NULL DEFAULT 0,
        bytes       BIGINT NOT NULL DEFAULT 0,
        file        TEXT NOT NULL DEFAULT '',
        format      TEXT NOT NULL DEFAULT 'm4a',
        turns       INTEGER NOT NULL DEFAULT 0,
        state       TEXT NOT NULL DEFAULT 'recording'
      );
      CREATE INDEX IF NOT EXISTS idx_liverec_user ON live_recordings(user_id, id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_liverec_session ON live_recordings(session_id);
    `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

/* ------------------------------------------------------------------ *
 * Retention
 * ------------------------------------------------------------------ */

/**
 * Drops recordings past their keep-window, then the oldest survivors
 * until the total is back under the ceiling, then reclaims anything a
 * crashed or redeployed process left behind.
 *
 * The disk this lives on also holds the database and the published APK,
 * so "we ran out of space" would take the product down, not just the
 * recordings. The ceiling is not advisory.
 */
async function prune() {
  await migrate();
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  const old = await query(
    `SELECT id, file FROM live_recordings WHERE started_at < $1`, [cutoff]);
  for (const r of old) await remove(r.id, r.file);

  const rows = await query(
    `SELECT id, file, bytes FROM live_recordings
      WHERE state = 'ready' ORDER BY started_at ASC`, []);
  let total = rows.reduce((n, r) => n + Number(r.bytes || 0), 0);
  const ceiling = MAX_TOTAL_MB * 1024 * 1024;
  for (const r of rows) {
    if (total <= ceiling) break;
    await remove(r.id, r.file);
    total -= Number(r.bytes || 0);
  }

  await reclaimOrphans();
  await sweepEmptyDays();
}

/**
 * THE ROW IS NOT THE ONLY THING ON DISK.
 *
 * A row's `file` is the merged .m4a; the raw PCM either side of it is
 * deleted by the session that wrote it. A pod killed mid-call — which is
 * every deploy — never gets there, and nothing else was ever going to
 * look. The PCM is the big half: uncompressed, and about eighty times the
 * size of what it merges down to.
 *
 * No live session can own a .pcm older than the longest allowed call, so
 * age alone is a safe test.
 */
async function reclaimOrphans() {
  const staleBefore = Date.now() - (MAX_MINUTES + 10) * 60_000;
  let days = [];
  try { days = await fsp.readdir(ROOT); } catch (_) { return; }
  for (const day of days) {
    const dir = path.join(ROOT, day);
    let files = [];
    try { files = await fsp.readdir(dir); } catch (_) { continue; }
    for (const f of files) {
      if (!f.endsWith(".pcm")) continue;
      const full = path.join(dir, f);
      const st = await fsp.stat(full).catch(() => null);
      if (st && st.mtimeMs < staleBefore) {
        await fsp.unlink(full).catch(() => {});
        console.warn("recorder: reclaimed orphaned", f);
      }
    }
  }
  // Rows whose session never finished would otherwise sit in 'recording'
  // forever, invisible in the panel and never cleaned up.
  await run(
    `UPDATE live_recordings SET state = 'failed'
      WHERE state = 'recording' AND started_at < $1`, [staleBefore]
  ).catch(() => {});
}

/** Deletes one recording — the row AND the bytes. */
async function remove(id, file) {
  if (file) {
    await fsp.unlink(file).catch(() => {});
    // Belt and braces for a row that failed before its raw halves went.
    await fsp.unlink(file.replace(/\.m4a$/, ".user.pcm")).catch(() => {});
    await fsp.unlink(file.replace(/\.m4a$/, ".agent.pcm")).catch(() => {});
  }
  await run(`DELETE FROM live_recordings WHERE id = $1`, [id]).catch(() => {});
}

/**
 * The absolute path `p` if it lies strictly inside ROOT, else null: a
 * stored path with "../" can never aim an unlink anywhere else.
 */
function insideRoot(p) {
  if (!p) return null;
  const base = path.resolve(String(ROOT));
  const full = path.resolve(String(p));
  return full.startsWith(base + path.sep) ? full : null;
}

/**
 * Unlinks a recording's .m4a and both raw halves, only inside ROOT.
 * Returns how many files went. Used by account erasure and by the
 * "Help improve" switch-off.
 */
async function unlinkAll(file) {
  const f = insideRoot(file);
  if (!f) return 0;
  const all = /\.m4a$/.test(f)
    ? [f, f.replace(/\.m4a$/, ".user.pcm"), f.replace(/\.m4a$/, ".agent.pcm")]
    : [f];
  let n = 0;
  for (const p of all) {
    try { await fsp.unlink(p); n++; } catch (_) { /* already gone */ }
  }
  return n;
}

/** Day folders left behind once their recordings are gone. */
async function sweepEmptyDays() {
  try {
    for (const day of await fsp.readdir(ROOT)) {
      const dir = path.join(ROOT, day);
      const left = await fsp.readdir(dir).catch(() => null);
      if (left && !left.length) await fsp.rmdir(dir).catch(() => {});
    }
  } catch (_) { /* no directory yet */ }
}

/* ------------------------------------------------------------------ *
 * Reading, for the admin panel
 * ------------------------------------------------------------------ */

async function list({ userId, limit = 50, offset = 0 } = {}) {
  await migrate();
  const params = [];
  // Only recordings of people who said yes, made after they said it.
  let where = "r.state = 'ready' AND " +
    require("../users/helpImprove").reviewableSql("r.user_id", "r.started_at");
  if (Number.isFinite(userId) && userId > 0) {
    params.push(userId);
    where += ` AND r.user_id = $${params.length}`;
  }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  return query(
    // user_exists: a call whose account was deleted is labelled as such in
    // the panel instead of passing for a user with no name.
    `SELECT r.id, r.user_id, u.name AS user_name, (u.id IS NOT NULL) AS user_exists,
            r.session_id, r.started_at, r.duration_ms, r.bytes, r.turns, r.format,
            -- A per-turn row (src/live/turnAudio.js) is keyed turn:<id>; its
            -- words sit in conversation_turns under that id.
            (SELECT q.text FROM conversation_turns q
              WHERE r.session_id LIKE 'turn:%' AND q.user_id = r.user_id AND q.role = 'user'
                AND q.turn_id = substr(r.session_id, 6) ORDER BY q.id LIMIT 1) AS question,
            (SELECT a.text FROM conversation_turns a
              WHERE r.session_id LIKE 'turn:%' AND a.user_id = r.user_id AND a.role = 'assistant'
                AND a.turn_id = substr(r.session_id, 6) ORDER BY a.id LIMIT 1) AS answer
       FROM live_recordings r LEFT JOIN users u ON u.id = r.user_id
      WHERE ${where}
      ORDER BY r.started_at DESC LIMIT ${lim} OFFSET ${off}`,
    params
  );
}

async function get(id) {
  await migrate();
  const rows = await query(
    `SELECT id, user_id, session_id, file, bytes, duration_ms, started_at, format
       FROM live_recordings WHERE id = $1 AND state = 'ready'
        AND ${require("../users/helpImprove").reviewableSql("user_id", "started_at")}`,
    [Number(id) || 0]);
  return rows[0] || null;
}

/**
 * Deletes one recording on request — the bytes go too, not just the row.
 * Rows still in 'recording' are left to reclaimOrphans().
 */
async function destroy(id) {
  await migrate();
  const rows = await query(
    `SELECT id, file FROM live_recordings WHERE id = $1 AND state <> 'recording'`,
    [Number(id) || 0]);
  if (!rows.length) return false;
  await remove(rows[0].id, rows[0].file);
  await sweepEmptyDays();
  return true;
}

/** Everything on disk, in one number, for the panel's header. */
async function usage() {
  await migrate();
  const rows = await query(
    `SELECT count(*) FILTER (WHERE state = 'ready')::int AS n,
            COALESCE(sum(bytes) FILTER (WHERE state = 'ready'), 0)::bigint AS bytes,
            COALESCE(sum(duration_ms) FILTER (WHERE state = 'ready'), 0)::bigint AS ms,
            count(*) FILTER (WHERE state = 'failed')::int AS failed
       FROM live_recordings`, []);
  const u = rows[0] || { n: 0, bytes: 0, ms: 0, failed: 0 };
  return {
    count: Number(u.n || 0),
    bytes: Number(u.bytes || 0),
    ms: Number(u.ms || 0),
    failed: Number(u.failed || 0),
    keepDays: KEEP_DAYS,
    maxMb: MAX_TOTAL_MB,
  };
}

module.exports = {
  list, get, destroy, usage, prune, KEEP_DAYS,
  // Per-turn recordings (live/turnAudio.js) write into the table and ROOT.
  // Account erasure (src/routes/privacy.js) finds the files through the
  // rows, checks every path is under ROOT, and tidies the day folders.
  migrate, sweepEmptyDays, ROOT, MAX_MINUTES,
  // "Help improve" switch-off (users/helpImprove.js).
  unlinkAll,
};
