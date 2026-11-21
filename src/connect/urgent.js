/**
 * URGENT ALERTS THAT ESCALATE (owner, 2026-11-21).
 *
 * An urgent alert from a contact's assistant rings the host's phone, and
 * keeps ringing louder until the host shows they have seen it:
 *
 *   0:00          one ping                       (channel hari_emergency, the app's emergency tone)
 *   5:00, 5:15    two pings, alarm volume        (channel hari_emergency_loud, longer tone)
 *   6:15 onward   three pings a minute (every 20 s), alarm volume,
 *                 until acknowledged — for at most MAX_MIN minutes
 *
 * "Seen" = the host taps the alert (POST /connect/urgent/ack) or reads the
 * message in their inbox (POST /messages/read with its id). The caller is
 * told once it is seen, or that it was not seen when the alerts stop.
 *
 * The pings are jobs (infra/jobs.js), so they survive a restart.
 */
const { one, query, run } = require("../db");

const MIN = 60_000;
const FIRST_GAP = Number(process.env.URGENT_FIRST_GAP_MS) || 5 * MIN;
const SECOND_GAP = Number(process.env.URGENT_SECOND_GAP_MS) || 15_000;
const THIRD_GAP = Number(process.env.URGENT_THIRD_GAP_MS) || MIN;
const REPEAT_GAP = Number(process.env.URGENT_REPEAT_GAP_MS) || 20_000;
const MAX_MIN = Number(process.env.URGENT_MAX_MIN) || 60;
const JOB = "connect_urgent_ping";

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS connect_urgent (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,     -- the host being alerted
        caller_id   INTEGER NOT NULL,
        message_id  BIGINT,               -- agent_messages row
        text        TEXT NOT NULL DEFAULT '',
        pings       INTEGER NOT NULL DEFAULT 0,
        created_at  BIGINT NOT NULL,
        acked_at    BIGINT,
        ended_at    BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_connect_urgent_open
        ON connect_urgent(user_id) WHERE acked_at IS NULL AND ended_at IS NULL;
    `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

const firstName = (s) => String(s || "").trim().split(/\s+/)[0] || "";

/** Delay before ping n+1, after ping n (1-based). */
function gapAfter(n) {
  if (n === 1) return FIRST_GAP;
  if (n === 2) return SECOND_GAP;
  if (n === 3) return THIRD_GAP;
  return REPEAT_GAP;
}

async function ping(alert, host, callerName, n) {
  // Counted as a step even when the phone has no token (it may register later).
  await run(`UPDATE connect_urgent SET pings = pings + 1 WHERE id = $1`, [alert.id]);
  if (!host?.fcm_token) return false;
  const loud = n >= 2;
  const body = String(alert.text || "").replace(/^\[URGENT\]\s*/, "").slice(0, 140);
  const title = n === 1 ? `Urgent: ${callerName} Needs You`
    : `Urgent (Not Yet Seen): ${callerName} Needs You`;
  const r = await require("../services/push").send(host.fcm_token, title, body,
    { kind: "agent_message_urgent", alertId: alert.id, ping: n },
    { channelId: loud ? "hari_emergency_loud" : "hari_emergency", tag: `urgent-${alert.id}` });
  return r.ok;
}

/** Starts the escalation for one urgent message. Returns the alert id. */
async function start({ hostId, callerId, messageId, text }) {
  await migrate();
  const row = await one(
    `INSERT INTO connect_urgent (user_id, caller_id, message_id, text, created_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [hostId, callerId, messageId || null, String(text || ""), Date.now()]);
  const host = await one(`SELECT id, fcm_token FROM users WHERE id = $1`, [hostId]);
  const caller = await one(`SELECT name FROM users WHERE id = $1`, [callerId]);
  await ping(row, host, firstName(caller?.name) || "Someone", 1).catch(() => false);
  await require("../infra/jobs").enqueue(JOB, { id: Number(row.id), n: 2 },
    { userId: hostId, delayMs: gapAfter(1) });
  return Number(row.id);
}

async function tellCaller(alert, seen) {
  const caller = await one(`SELECT fcm_token FROM users WHERE id = $1`, [alert.caller_id]);
  const host = await one(`SELECT name FROM users WHERE id = $1`, [alert.user_id]);
  if (!caller?.fcm_token) return;
  const who = firstName(host?.name) || "They";
  await require("../services/push").sendNotification(caller.fcm_token,
    seen ? `${who} Has Seen Your Urgent Alert` : `${who} Has Not Seen Your Urgent Alert`,
    seen ? "Your urgent message has been read."
      : `The alerts have stopped after ${MAX_MIN} minutes. Please try calling ${who} directly.`,
    { kind: "urgent_status", alertId: alert.id, seen: seen ? 1 : 0 }).catch(() => false);
}

/** The job: one ping, then the next one scheduled — until seen or expired. */
async function onJob(payload) {
  await migrate();
  const alert = await one(`SELECT * FROM connect_urgent WHERE id = $1`, [Number(payload.id)]);
  if (!alert || alert.acked_at || alert.ended_at) return;
  if (Date.now() - Number(alert.created_at) > MAX_MIN * MIN) {
    const ended = await one(
      `UPDATE connect_urgent SET ended_at = $2 WHERE id = $1 AND ended_at IS NULL AND acked_at IS NULL RETURNING *`,
      [alert.id, Date.now()]);
    if (ended) await tellCaller(ended, false);
    return;
  }
  const n = Number(payload.n) || 2;
  const host = await one(`SELECT id, fcm_token FROM users WHERE id = $1`, [alert.user_id]);
  const caller = await one(`SELECT name FROM users WHERE id = $1`, [alert.caller_id]);
  await ping(alert, host, firstName(caller?.name) || "Someone", n).catch(() => false);
  await require("../infra/jobs").enqueue(JOB, { id: Number(alert.id), n: n + 1 },
    { userId: Number(alert.user_id), delayMs: gapAfter(n) });
}

/**
 * The host has seen it: stops the pings and tells the caller. With no id,
 * every open alert of the host; with messageIds, the alerts for those
 * inbox messages. Returns how many were acknowledged.
 */
async function ack(userId, { id = null, messageIds = null } = {}) {
  await migrate();
  const params = [Number(userId), Date.now()];
  let where = "user_id = $1 AND acked_at IS NULL AND ended_at IS NULL";
  if (id) { params.push(Number(id)); where += ` AND id = $${params.length}`; }
  if (messageIds) { params.push(messageIds.map(Number)); where += ` AND message_id = ANY($${params.length}::bigint[])`; }
  const rows = await query(`UPDATE connect_urgent SET acked_at = $2 WHERE ${where} RETURNING *`, params);
  for (const r of rows) await tellCaller(r, true);
  return rows.length;
}

function register(jobs) {
  jobs.register(JOB, onJob);
}

// The host's alerts (the words are also in their inbox, agent_messages).
const USER_TABLES = [["connect_urgent", "user_id"]];

module.exports = { migrate, start, ack, onJob, register, gapAfter, USER_TABLES, JOB };
